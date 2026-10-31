import XCTest
import GenieCore
@testable import GenieMac

@MainActor
final class ConnectionJourneyTests: XCTestCase {
    let mail = ConnectorState.Source(pluginId: "test.mail", name: "Gmail", purpose: "Mail", provider: "google", connectorId: "mail", scopes: ["mail.read"])
    let calendar = ConnectorState.Source(pluginId: "test.calendar", name: "Google Calendar", purpose: "Calendar", provider: "google", connectorId: "calendar", scopes: ["calendar.read"])
    let pending = ConnectorFlow.Pending(verifier: String(repeating: "a", count: 64), state: "expected", redirectUri: "http://127.0.0.1:1234/callback", port: 1234)
    final class Storage {
        var values: [String: String] = [:]
        var records: [String: [ConnectorState.Record]] = [:]
        var failRegister = false
        var failDelete = false
        var failList = false
        var scopes = ["mail.read", "calendar.read"]
        var registrations = 0
        var delayExchange = false
        var account = "tester@example.invalid"
        var rejected: [String: String] = [:]
        var locked: Set<String> = []
        var replaced: [String] = []
        var refresh = "test-refresh"
    }
    func make(_ storage: Storage) -> ConnectorState {
        ConnectorState(sources: [mail, calendar], dependencies: makeDeps(storage))
    }
    func makeDeps(_ storage: Storage) -> ConnectorState.Dependencies {
        ConnectorState.Dependencies(configuration: { ["ASTRA_OAUTH_GOOGLE_CLIENT_ID": "client"] },
            read: { if storage.locked.contains($0.id) { throw KeychainStore.KeychainError.accessDenied }; return storage.values[$0.id] },
            write: { if storage.locked.contains($0.id) { throw KeychainStore.KeychainError.accessDenied }; storage.values[$0.id] = $1 },
            delete: { if storage.failDelete { throw URLError(.cannotWriteToFile) }; storage.values[$0.id] = nil },
            list: { _, _, source in if storage.failList { throw URLError(.notConnectedToInternet) }; return storage.records[source.id] ?? [] },
            register: { _, _, source, credential in
                if storage.failRegister { throw URLError(.networkConnectionLost) }
                storage.registrations += 1
                storage.records[source.id] = [.init(connectorId: source.connectorId, state: "CONNECTED", grantedScopes: credential.grantedScopes, expiresAt: nil, accountLabel: "tester@example.invalid")]
            },
            remove: { _, _, source in storage.records[source.id] = [] },
            exchange: { _, _, _, _, _ in
                if storage.delayExchange { try await Task.sleep(for: .milliseconds(100)) }
                return .init(clientId: "client", accessToken: "test-access", refreshToken: storage.refresh, expiresAt: nil, grantedScopes: storage.scopes, tokenType: "Bearer")
            },
            account: { _, _ in storage.account },
            rejected: { storage.rejected[$0.id] },
            replaceLocked: { source, value in
                storage.replaced.append(source.id); storage.locked.remove(source.id); storage.values[source.id] = value
            })
    }
    func complete(_ state: ConnectorState) async {
        await state.finish(list: [mail, calendar], callback: connectorParseCallback(target: "/callback?code=code&state=expected"), pending: pending,
            clientId: "client", secret: nil, base: "fixture", token: "fixture")
    }
    func testSingleAuthorizationPersistsBothServicesAndAccount() async {
        let store = Storage()
        let subject = make(store)
        await complete(subject)
        XCTAssertEqual(store.registrations, 2)
        XCTAssertEqual(subject.connected, ["Gmail", "Google Calendar"])
        XCTAssertEqual(subject.accounts["google"], "tester@example.invalid")
        let saved = try? JSONDecoder().decode(ConnectorState.Credential.self, from: Data(store.values[mail.id]!.utf8))
        XCTAssertEqual(saved?.clientId, "client")
        XCTAssertEqual(saved?.accountLabel, "tester@example.invalid")
    }
    func testPartialConsentConnectsOnlyActuallyGrantedService() async {
        let store = Storage(); store.scopes = ["mail.read"]
        let subject = make(store); await complete(subject)
        XCTAssertEqual(subject.connected, ["Gmail"])
        XCTAssertNil(store.values[calendar.id])
        XCTAssertEqual(store.registrations, 1)
        guard case .failed = subject.status[calendar.id] else { return XCTFail("Missing consent must be visible") }
    }
    func testUnexpectedWriteGrantIsNotSaved() async {
        let store = Storage(); store.scopes.append("mail.send")
        let subject = make(store); await complete(subject)
        XCTAssertTrue(store.values.isEmpty); XCTAssertEqual(store.registrations, 0); XCTAssertTrue(subject.connected.isEmpty)
    }
    func testRegistrationFailureRestoresPreviousCredential() async {
        let store = Storage(); store.failRegister = true; store.values[mail.id] = "previous-value"
        let subject = make(store); await complete(subject)
        XCTAssertEqual(store.values[mail.id], "previous-value")
        XCTAssertTrue(subject.connected.isEmpty)
        guard case .failed = subject.status[mail.id] else { return XCTFail("Must expose persistence failure") }
    }
    func testWrongStateAndDeniedConsentNeverExchangeOrRegister() async {
        let store = Storage()
        let state = make(store)
        await state.finish(list: [mail], callback: connectorParseCallback(target: "/callback?code=code&state=wrong"), pending: pending,
            clientId: "client", secret: nil, base: "fixture", token: "fixture")
        XCTAssertTrue(store.values.isEmpty)
        await state.finish(list: [mail], callback: connectorParseCallback(target: "/callback?state=expected&error=access_denied"), pending: pending,
            clientId: "client", secret: nil, base: "fixture", token: "fixture")
        XCTAssertEqual(store.registrations, 0)
    }
    func testCloudRecordWithoutLocalCredentialIsNotConnected() async {
        let store = Storage(); let state = make(store); await complete(state)
        store.values = [:]
        state.configureBackend(base: "fixture", token: "fixture")
        await state.refreshNow()
        XCTAssertTrue(state.connected.isEmpty)
    }
    func testRejectedRenewalIsReportedForLine() async {
        let store = Storage(); let state0 = make(store); await complete(state0)
        let saved = try! JSONDecoder().decode(ConnectorState.Credential.self, from: Data(store.values[mail.id]!.utf8))
        store.rejected[mail.id] = saved.fingerprint
        var deps = makeDeps(store)
        var posted: [(String, [String: Any]?)] = []
        deps.remote = { _, _, _, path, body in posted.append((path, body)); return Data() }
        let state = ConnectorState(sources: [mail, calendar], dependencies: deps)
        state.configureBackend(base: "fixture", token: "fixture")
        await state.refreshNow()
        XCTAssertEqual(posted.first?.0, "/v1/connector-reconnects/rejected")
        XCTAssertEqual(posted.first?.1?["plugin_id"] as? String, mail.pluginId)
        XCTAssertEqual(posted.first?.1?["fingerprint"] as? String, saved.fingerprint)
        // 断られていない接続（カレンダー）は知らせない
        XCTAssertFalse(posted.contains { $0.1?["plugin_id"] as? String == calendar.pluginId })
    }
    func testRemoteReconnectHandsOnlyTheUrlThenSavesThePastedCode() async {
        // LINE からのつなぎ直し: URL だけを渡し、貼られた認可コードで保存する
        let store = Storage()
        var deps = makeDeps(store)
        var calls: [(String, [String: Any]?)] = []
        var answer = #"{"items":[{"id":"r1","provider":"google","state":"requested"}]}"#
        deps.remote = { _, _, method, path, body in
            if method == "GET" { return Data(answer.utf8) }
            calls.append((path, body)); return Data()
        }
        let state = ConnectorState(sources: [mail, calendar], dependencies: deps)
        state.configureBackend(base: "fixture", token: "fixture")
        await state.pollRemoteReconnects()
        XCTAssertEqual(calls.first?.0, "/v1/connector-reconnects/r1/authorize")
        let url = try! XCTUnwrap(calls.first?.1?["authorize_url"] as? String)
        XCTAssertFalse(url.contains("code_verifier"))
        let stateValue = URLComponents(string: url)!.queryItems!.first { $0.name == "state" }!.value!
        // 別の手続きの値は保存しない
        answer = #"{"items":[{"id":"r2","provider":"google","state":"code","code":"c"}]}"#
        await state.pollRemoteReconnects()
        XCTAssertEqual(calls.last?.0, "/v1/connector-reconnects/r2/finished")
        XCTAssertEqual(calls.last?.1?["ok"] as? Bool, false)
        XCTAssertEqual(store.registrations, 0)
        answer = #"{"items":[{"id":"r1","provider":"google","state":"code","code":"c","callback_state":"\#(stateValue)"}]}"#
        await state.pollRemoteReconnects()
        XCTAssertEqual(store.registrations, 2)
        XCTAssertEqual(calls.last?.0, "/v1/connector-reconnects/r1/finished")
        XCTAssertEqual(calls.last?.1?["ok"] as? Bool, true)
        XCTAssertEqual(state.status[mail.id], .connected)
    }
    func testRejectedRenewalShowsExpiredUntilReconnected() async {
        // host が invalid_grant を受け、この接続の指紋を記録した（Google の「テスト中」のアプリは 7 日で失効する）
        let store = Storage(); let state = make(store); await complete(state)
        let saved = try! JSONDecoder().decode(ConnectorState.Credential.self, from: Data(store.values[mail.id]!.utf8))
        // host（connector-steps.ts の credentialFingerprint）と同じ値になる
        XCTAssertEqual(saved.fingerprint, "fbfc47f7125f9d940886909d2719b9a4")
        store.rejected[mail.id] = saved.fingerprint
        state.configureBackend(base: "fixture", token: "fixture")
        await state.refreshNow()
        XCTAssertEqual(state.status[mail.id], .expired)
        XCTAssertEqual(state.status[calendar.id], .connected)
        XCTAssertEqual(state.connected, ["Google Calendar"])
        // つなぎ直すと指紋が変わり、古い記録は当てはまらない
        store.refresh = "reconnected-refresh"
        await complete(state)
        await state.refreshNow()
        XCTAssertEqual(state.status[mail.id], .connected)
    }
    func testUnreadableItemShowsExpiredAndReconnectReplacesIt() async {
        // host の書き戻しで、アプリが自分の項目を読めなくなった（2026-10-16〜19）
        let store = Storage(); let state = make(store); await complete(state)
        store.locked.insert(mail.id)
        state.configureBackend(base: "fixture", token: "fixture")
        await state.refreshNow()
        XCTAssertEqual(state.status[mail.id], .expired)
        // 「つなぎ直す」: 読めない項目を作り直して保存できる
        await complete(state)
        XCTAssertEqual(state.status[mail.id], .connected)
        XCTAssertEqual(store.replaced, [mail.id])
        XCTAssertFalse(store.locked.contains(mail.id))
    }
    func testOfflineRefreshShowsFailureInsteadOfFalseConnected() async {
        let store = Storage(); let state = make(store); await complete(state)
        store.failList = true
        state.configureBackend(base: "fixture", token: "fixture")
        await state.refreshNow()
        XCTAssertTrue(state.connected.isEmpty)
        guard case .failed = state.status[mail.id] else { return XCTFail("Offline is not empty success") }
    }
    func testCallbackIgnoresFaviconPostDuplicateAndWrongState() {
        for request in [
            "GET /favicon.ico HTTP/1.1\r\n\r\n", "POST /callback?code=x&state=s HTTP/1.1\r\n\r\n",
            "GET /callback?code=x&state=wrong HTTP/1.1\r\n\r\n",
            "GET /callback?code=x&state=s&state=s HTTP/1.1\r\n\r\n",
            "GET /callback?code=x&state=s&%73tate=s HTTP/1.1\r\n\r\n",
            "GET /callback?code=x&error=denied&state=s HTTP/1.1\r\n\r\n",
        ] { XCTAssertNil(ConnectorFlow.acceptedCallback(request: request, expectedState: "s")) }
        XCTAssertEqual(ConnectorFlow.acceptedCallback(request: "GET /callback?code=x&state=s HTTP/1.1\r\n\r\n", expectedState: "s")?.code, "x")
        XCTAssertEqual(ConnectorFlow.acceptedCallback(request: "GET /callback?error=access_denied&state=s HTTP/1.1\r\n\r\n", expectedState: "s")?.error, "access_denied")
    }
    func testCancelledExchangeCannotSaveOrRegister() async {
        let store = Storage(); store.delayExchange = true
        let subject = make(store)
        let exchange = Task { await complete(subject) }
        await Task.yield()
        subject.cancel()
        await exchange.value
        XCTAssertTrue(store.values.isEmpty); XCTAssertEqual(store.registrations, 0)
    }
    func testDisconnectFailureRemainsRetryable() async {
        let store = Storage(); let subject = make(store)
        await complete(subject)
        subject.configureBackend(base: "fixture", token: "fixture")
        store.failDelete = true
        subject.disconnectProvider("google")
        for _ in 0..<100 where subject.activeProvider != nil { await Task.yield() }
        XCTAssertTrue(subject.disconnectFailures.contains("google"))
        XCTAssertFalse(store.values.isEmpty)
        store.failDelete = false
        subject.disconnectProvider("google")
        for _ in 0..<100 where subject.activeProvider != nil { await Task.yield() }
        XCTAssertFalse(subject.disconnectFailures.contains("google"))
        XCTAssertTrue(store.values.isEmpty); XCTAssertTrue(subject.connected.isEmpty)
    }
    func testLoopbackRejectsUnrelatedRequestThenAcceptsExpectedCallback() async throws {
        let flow = ConnectorFlow(); var callbacks = 0
        let port = try await flow.startLoopback(expectedState: "expected") { _ in callbacks += 1 }
        defer { flow.stopLoopback() }
        let base = "http://127.0.0.1:\(port)"
        let (_, bad) = try await URLSession.shared.data(from: URL(string: base + "/favicon.ico")!)
        XCTAssertEqual((bad as? HTTPURLResponse)?.statusCode, 400); XCTAssertEqual(callbacks, 0)
        let (_, good) = try await URLSession.shared.data(from: URL(string: base + "/callback?code=fixture&state=expected")!)
        XCTAssertEqual((good as? HTTPURLResponse)?.statusCode, 200); XCTAssertEqual(callbacks, 1)
    }
    /// Advance the authorization timer without waiting five real minutes or opening a browser.
    final class AuthorizationClock {
        var elapsed: Duration = .zero
        var deadline: Duration?
        var sleeper: CheckedContinuation<Void, Error>?
        func sleep(for duration: Duration) async throws {
            deadline = elapsed + duration
            try await withCheckedThrowingContinuation { sleeper = $0 }
        }
        func advance(by duration: Duration) {
            elapsed += duration
            if let deadline, elapsed >= deadline {
                let pending = sleeper; sleeper = nil; self.deadline = nil
                pending?.resume()
            }
        }
    }
    func callbackURL(_ authorization: URL) throws -> URL {
        let items = try XCTUnwrap(URLComponents(url: authorization, resolvingAgainstBaseURL: false)?.queryItems)
        let redirect = try XCTUnwrap(items.first { $0.name == "redirect_uri" }?.value)
        let state = try XCTUnwrap(items.first { $0.name == "state" }?.value)
        var callback = try XCTUnwrap(URLComponents(string: redirect))
        callback.queryItems = [.init(name: "code", value: "fixture"), .init(name: "state", value: state)]
        return try XCTUnwrap(callback.url)
    }
    func testAuthorizationStillAcceptsCallbackAfterThreeMinutesAndCancelsExpiry() async throws {
        let clock = AuthorizationClock(); var authorization: URL?; var callbacks = 0; var expirations = 0
        let flow = ConnectorFlow(openAuthorizationURL: { authorization = $0; return true }, waitForAuthorization: { try await clock.sleep(for: $0) })
        defer { flow.stopLoopback(); clock.advance(by: .seconds(300)) }
        let started = try await flow.begin(provider: "google", clientId: "fixture", scopes: ["openid"],
            onTimeout: { expirations += 1 }) { _, _ in callbacks += 1 }
        XCTAssertTrue(started)
        for _ in 0..<100 where clock.sleeper == nil { await Task.yield() }
        XCTAssertNotNil(clock.sleeper)
        clock.advance(by: .seconds(231)) // Observed account-selection/consent duration.
        await Task.yield()
        let callback = try callbackURL(XCTUnwrap(authorization))
        let (_, response) = try await URLSession.shared.data(from: callback)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(callbacks, 1); XCTAssertEqual(expirations, 0)
        clock.advance(by: .seconds(69))
        await Task.yield()
        XCTAssertEqual(expirations, 0)
        do {
            _ = try await URLSession.shared.data(from: callback)
            XCTFail("A consumed callback must not remain available")
        } catch { XCTAssertEqual(callbacks, 1) }
    }
    func testAuthorizationExpiresOnceAtFiveMinutes() async throws {
        let clock = AuthorizationClock(); var authorization: URL?; var callbacks = 0; var expirations = 0
        let flow = ConnectorFlow(openAuthorizationURL: { authorization = $0; return true }, waitForAuthorization: { try await clock.sleep(for: $0) })
        defer { flow.stopLoopback(); clock.advance(by: .seconds(300)) }
        _ = try await flow.begin(provider: "google", clientId: "fixture", scopes: ["openid"],
            onTimeout: { expirations += 1 }) { _, _ in callbacks += 1 }
        for _ in 0..<100 where clock.sleeper == nil { await Task.yield() }
        XCTAssertNotNil(clock.sleeper)
        clock.advance(by: .seconds(299)); await Task.yield()
        XCTAssertEqual(expirations, 0)
        clock.advance(by: .seconds(1))
        for _ in 0..<100 where expirations == 0 { await Task.yield() }
        XCTAssertEqual(expirations, 1)
        do {
            _ = try await URLSession.shared.data(from: callbackURL(XCTUnwrap(authorization)))
            XCTFail("Expired authorization must close its callback listener")
        } catch { XCTAssertEqual(callbacks, 0) }
        clock.advance(by: .seconds(300)); await Task.yield()
        XCTAssertEqual(expirations, 1)
    }
    func testCancelledAuthorizationTimerCannotStopNewListener() async throws {
        let clock = AuthorizationClock(); var expirations = 0; var callbacks = 0
        let flow = ConnectorFlow(openAuthorizationURL: { _ in true }, waitForAuthorization: { try await clock.sleep(for: $0) })
        defer { flow.stopLoopback(); clock.advance(by: .seconds(300)) }
        _ = try await flow.begin(provider: "google", clientId: "fixture", scopes: ["openid"],
            onTimeout: { expirations += 1 }) { _, _ in XCTFail("Cancelled authorization callback") }
        for _ in 0..<100 where clock.sleeper == nil { await Task.yield() }
        XCTAssertNotNil(clock.sleeper)
        flow.stopLoopback()
        let port = try await flow.startLoopback(expectedState: "new") { _ in callbacks += 1 }
        clock.advance(by: .seconds(300)); await Task.yield()
        let (_, response) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/callback?code=fixture&state=new")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(callbacks, 1); XCTAssertEqual(expirations, 0)
    }
    func testConfigurationAllowlistAndDedicatedClientPrecedence() {
        let values = ConnectionConfiguration.merge([["ASTRA_OAUTH_GOOGLE_CLIENT_ID": "legacy", "access_token": "not-configuration"],
            ["ASTRA_OAUTH_GOOGLE_READ_CLIENT_ID": " read ", "ASTRA_OAUTH_GOOGLE_WRITE_CLIENT_ID": "write"]])
        XCTAssertNil(values["access_token"])
        XCTAssertEqual(ConnectionConfiguration.clientId(provider: "google", readOnly: true, values: values), "read")
        XCTAssertEqual(ConnectionConfiguration.clientId(provider: "google", readOnly: false, values: values), "write")
    }
    func testFailedProfileCanLeaveHomeAndReopenWithoutStartingAnotherRead() {
        let store = InitialProfileStore()
        store.installForTesting(.init(id: "fixture", provider: "google", status: "failed", startedAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z", outcomes: [], sections: nil))
        XCTAssertTrue(store.visible)
        store.deferUntilRequested()
        XCTAssertFalse(store.visible)
        store.connected(provider: "google")
        XCTAssertTrue(store.visible)
        XCTAssertFalse(store.starting)
        XCTAssertEqual(store.result?.id, "fixture")
        XCTAssertNil(store.failure)
    }
    func testSeparateSendAuthorizationDoesNotRelabelReadAccount() async {
        let store = Storage(); let state = make(store); await complete(state)
        store.account = "sender@example.invalid"; store.scopes = ["mail.send"]
        let action = ConnectorState.Source(pluginId: mail.pluginId, name: mail.name, purpose: "Send", provider: "google", connectorId: "mail-actions", scopes: ["mail.send"], readOnly: false)
        await state.finish(list: [action], callback: connectorParseCallback(target: "/callback?code=code&state=expected"), pending: pending, clientId: "client", secret: nil, base: "fixture", token: "fixture")
        XCTAssertEqual(state.status[action.statusKey], .connected)
        XCTAssertEqual(state.accounts["google"], "tester@example.invalid")
        XCTAssertEqual(state.connected, ["Gmail", "Google Calendar"])
    }

    /// 普段の起動（ブートストラップが保存先を決めた）は運営者の接続設定を読む。検査や外から渡した保存先は隔離する。
    func testOnlyFixturesAreIsolatedFromThePublisherConfiguration() {
        let app = "/Users/u/Library/Application Support/Genie/local-preview/app"
        XCTAssertFalse(ConnectionConfiguration.isolated(dataRoot: nil, projected: nil, selftest: false))
        XCTAssertFalse(ConnectionConfiguration.isolated(dataRoot: app, projected: app, selftest: false), "ローカルプレビューの普段の起動")
        XCTAssertTrue(ConnectionConfiguration.isolated(dataRoot: "/tmp/liveflow", projected: nil, selftest: false), "外から渡された保存先")
        XCTAssertTrue(ConnectionConfiguration.isolated(dataRoot: app, projected: app, selftest: true), "検査はいつも隔離")
    }
}
