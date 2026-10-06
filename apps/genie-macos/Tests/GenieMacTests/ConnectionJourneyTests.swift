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
    }
    func make(_ storage: Storage) -> ConnectorState {
        let deps = ConnectorState.Dependencies(configuration: { ["ASTRA_OAUTH_GOOGLE_CLIENT_ID": "client"] },
            read: { storage.values[$0.id] }, write: { storage.values[$0.id] = $1 },
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
                return .init(clientId: "client", accessToken: "test-access", refreshToken: "test-refresh", expiresAt: nil, grantedScopes: storage.scopes, tokenType: "Bearer")
            },
            account: { _, _ in storage.account })
        return ConnectorState(sources: [mail, calendar], dependencies: deps)
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
