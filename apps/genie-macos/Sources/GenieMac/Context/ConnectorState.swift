import CryptoKit
import Foundation
import GenieCore

@MainActor
final class ConnectorState: ObservableObject {
    static let shared = ConnectorState()
    struct Source: Identifiable, Equatable {
        let pluginId: String
        let name: String
        let purpose: String
        let provider: String
        let connectorId: String
        let scopes: [String]
        var readOnly: Bool = true
        var id: String { statusKey }
        var statusKey: String { readOnly ? pluginId : "\(pluginId)#\(connectorId)" }
    }
    /// `expired`: 提供者が更新を断った（host が資格情報に印を付けた）。つなぎ直すまで読めない。
    enum Status: Equatable { case connected, expired, disconnected, cannotConnect, connecting, checking, disconnecting, failed(String) }
    struct Credential: Codable {
        let clientId: String
        let accessToken: String
        let refreshToken: String?
        let expiresAt: String?
        let grantedScopes: [String]
        let tokenType: String
        var accountLabel: String?
        var usable: Bool {
            !accessToken.isEmpty && (refreshToken?.isEmpty == false || expiresAt.flatMap { ISO8601DateFormatter().date(from: $0) }.map { $0 > Date() } == true)
        }
        /// 接続の指紋。host（`credentialFingerprint`）と同じ計算。「更新を断られた」がこの接続のことかを見分ける。
        var fingerprint: String {
            String(SHA256.hash(data: Data((refreshToken ?? accessToken).utf8)).map { String(format: "%02x", $0) }.joined().prefix(32))
        }
    }
    struct Record: Decodable {
        let connectorId: String
        let state: String
        let grantedScopes: [String]
        let expiresAt: String?
        let accountLabel: String?
    }
    struct Dependencies {
        var configuration: () -> [String: String]
        var read: (Source) throws -> String?
        var write: (Source, String) throws -> Void
        var delete: (Source) throws -> Void
        var list: (String, String, Source) async throws -> [Record]
        var register: (String, String, Source, Credential) async throws -> Void
        var remove: (String, String, Source) async throws -> Void
        var exchange: (String, String, String?, ConnectorFlow.Pending, String) async throws -> Credential
        var account: (String, String) async -> String?
        /// host が「提供者に更新を断られた」と記録した接続の指紋。無ければ nil。
        var rejected: (Source) -> String? = { _ in nil }
        /// 読めなくなった項目を、本人の「つなぎ直す」で作り直す。無ければ通常の保存だけ。
        var replaceLocked: ((Source, String) throws -> Void)? = nil
        /// gateway への呼び出し（LINE からのつなぎ直し）。答えの本文を返す。届かなければ nil。
        var remote: (String, String, String, String, [String: Any]?) async -> Data? = { _, _, _, _, _ in nil }
        var startsRemoteLoop = false
    }
    @Published var connected: Set<String> = []
    @Published private(set) var status: [String: Status] = [:]
    @Published private(set) var sources: [Source] = []
    @Published private(set) var accounts: [String: String] = [:]
    @Published private(set) var activeProvider: String?
    @Published private(set) var disconnectFailures: Set<String> = []
    @Published private(set) var notice: [String: String] = [:]
    private let flow = ConnectorFlow()
    private let deps: Dependencies
    private var base: String?
    private var token: String?
    private var generation = UUID()
    private var refreshTask: Task<Void, Never>?
    private var work: Task<Void, Never>?
    private var activeSources: [Source] = []
    private var injectedSources: Bool

    init(sources: [Source]? = nil, dependencies: Dependencies? = nil) {
        deps = dependencies ?? Self.liveDependencies()
        injectedSources = sources != nil
        if let sources { self.sources = sources }
        reloadSources()
    }
    func reloadSources() {
        if !injectedSources {
            let store = PluginRuntimeStore.shared; store.load()
            sources = ["com.astra.gmail", "com.astra.google-calendar", "com.astra.outlook", "com.astra.microsoft-todo"].compactMap { id in
                guard let m = store.manifests.first(where: { $0.id == id }), let c = m.readConnector else { return nil }
                return Source(pluginId: id, name: m.name, purpose: c.purpose ?? "読むだけ", provider: c.provider, connectorId: c.id, scopes: c.scopes)
            }
        }
        for source in sources where status[source.statusKey] == nil {
            status[source.statusKey] = canConnect(source.name) ? .disconnected : .cannotConnect
        }
    }
    static func provider(for app: String) -> String? {
        let a = app.lowercased()
        if a.contains("gmail") || a.contains("google") || a.contains("calendar") || a.contains("drive") { return "google" }
        if a.contains("microsoft") || a.contains("outlook") || a.contains("teams") || a.contains("to do") { return "microsoft" }
        return nil
    }
    static func connectionClientId(provider: String, readOnly: Bool, env: [String: String]) -> String? {
        ConnectionConfiguration.clientId(provider: provider, readOnly: readOnly, values: env)
    }
    static func normalize(_ scope: String) -> String {
        scope.replacingOccurrences(of: "https://graph.microsoft.com/", with: "", options: .caseInsensitive).lowercased()
    }
    static func microsoftScopesMatch(granted: [String], required: [String]) -> Bool {
        let identity: Set<String> = ["openid", "profile", "email", "offline_access", "user.read"]
        let wanted = Set(required.map(normalize)).subtracting(identity), actual = Set(granted.map(normalize))
        return wanted.isSubset(of: actual) && actual.isSubset(of: wanted.union(identity))
    }
    static func permits(_ source: Source, granted: [String]) -> Bool {
        let identity: Set<String> = ["openid", "profile", "email", "offline_access", "user.read"]
        let wanted = Set(source.scopes.map(normalize)).subtracting(identity)
        return !wanted.isEmpty && wanted.isSubset(of: Set(granted.map(normalize)))
    }
    static func scopesSafe(_ granted: [String], for list: [Source]) -> Bool {
        let identities: Set<String> = ["openid", "email", "profile", "offline_access", "user.read", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]
        return Set(granted.map(normalize)).isSubset(of: Set(list.flatMap(\.scopes).map(normalize)).union(identities))
    }
    func configuredProviders() -> [String] {
        ["google", "microsoft"].filter { Self.connectionClientId(provider: $0, readOnly: true, env: deps.configuration()) != nil }
    }
    func canConnect(_ app: String) -> Bool { Self.provider(for: app).map { configuredProviders().contains($0) } ?? false }
    func source(named app: String) -> Source? { sources.first { $0.name == app } }
    func status(of app: String) -> Status? { source(named: app).flatMap { status[$0.statusKey] } }
    func actionsSource(pluginId: String, connectorId: String) -> Source? {
        let store = PluginRuntimeStore.shared; store.load()
        guard let m = store.manifests.first(where: { $0.id == pluginId }), let c = m.connectors.first(where: { $0.id == connectorId && !$0.readOnly }) else { return nil }
        return Source(pluginId: pluginId, name: m.name, purpose: c.purpose ?? "送る・動かす", provider: c.provider, connectorId: c.id, scopes: c.scopes, readOnly: false)
    }
    @discardableResult func connectActions(pluginId: String, connectorId: String) -> Bool {
        guard let s = actionsSource(pluginId: pluginId, connectorId: connectorId) else { return false }; return connect(source: s)
    }
    func installActionsStatus(pluginId: String, connectorId: String, _ st: Status) { status["\(pluginId)#\(connectorId)"] = st }
    func installStatus(_ pluginId: String, _ st: Status) {
        status[pluginId] = st
        if let s = sources.first(where: { $0.pluginId == pluginId }) { update(s, st) }
    }
    private func update(_ source: Source, _ state: Status) {
        status[source.statusKey] = state
        if source.readOnly {
            if state == .connected { connected.insert(source.name) } else { connected.remove(source.name) }
        }
    }
    func configureBackend(base: String, token: String) {
        if self.base != nil && (self.base != base || self.token != token) {
            generation = UUID(); work?.cancel(); flow.stopLoopback(); activeProvider = nil; activeSources = []
            connected.removeAll(); accounts.removeAll()
            sources.forEach { update($0, .disconnected) }
        }
        self.base = base; self.token = token; refresh()
        if deps.startsRemoteLoop { startRemoteReconnects() }
    }
    func refresh() {
        guard activeProvider == nil else { return }
        refreshTask?.cancel()
        refreshTask = Task { await refreshNow() }
    }
    func refreshNow() async {
        guard let base, let token, activeProvider == nil else { return }
        let attempt = generation
        for s in sources {
            guard !Task.isCancelled, attempt == generation, activeProvider == nil else { return }
            do {
                let rows = try await deps.list(base, token, s)
                guard attempt == generation, activeProvider == nil, !Task.isCancelled else { return }
                let local: Credential?
                do { local = try deps.read(s).flatMap { try JSONDecoder().decode(Credential.self, from: Data($0.utf8)) } }
                catch KeychainStore.KeychainError.accessDenied {
                    // 項目はあるのにアプリが読めない（host の書き戻しで partition が変わった）。つなぎ直すしかない。
                    update(s, canConnect(s.name) ? .expired : .cannotConnect); continue
                }
                let recorded = rows.first { $0.connectorId == s.connectorId && $0.state == "CONNECTED" }
                let expected = Self.connectionClientId(provider: s.provider, readOnly: s.readOnly, env: deps.configuration())
                let valid = recorded.map { r in
                    Self.permits(s, granted: r.grantedScopes) && (r.expiresAt == nil || r.expiresAt.flatMap { ISO8601DateFormatter().date(from: $0) }.map { $0 > Date() } == true)
                } ?? false
                if valid, let local, local.usable, local.clientId == expected, Self.permits(s, granted: local.grantedScopes),
                   Self.scopesSafe(local.grantedScopes, for: sources.filter { $0.provider == s.provider }) {
                    // 保存はあっても、提供者が更新を断っていれば「接続済み」とは言わない（2026-10-19、7 日で失効した Gmail）。
                    let refused = deps.rejected(s) == local.fingerprint
                    update(s, refused ? .expired : .connected)
                    // 本人の LINE へ。host は断られたときにしか知らせず、次に更新を試すのが翌日のこともある（同じ接続では gateway が 1 回にまとめる）
                    if refused {
                        _ = await deps.remote(base, token, "POST", "/v1/connector-reconnects/rejected",
                            ["plugin_id": s.pluginId, "connector_id": s.connectorId, "fingerprint": local.fingerprint])
                    }
                    accounts[s.provider] = local.accountLabel ?? recorded?.accountLabel
                } else { update(s, canConnect(s.name) ? .disconnected : .cannotConnect) }
            } catch {
                guard attempt == generation, !Task.isCancelled else { return }
                update(s, .failed("接続状況を確認できません。通信を確認して再確認してください。"))
            }
        }
    }
    // MARK: LINE からのつなぎ直し（services/api-gateway/src/connector-reconnect.ts）
    // 保存はアプリだけができる（host からキーチェーンへ書くとアプリが読めなくなる）ので、ここで受ける。

    private struct RemoteItem: Decodable {
        let id: String
        let provider: String
        let state: String
        let code: String?
        let error: String?
        let callback_state: String?
    }
    private struct RemoteResponse: Decodable { let items: [RemoteItem] }
    private var remoteFlows: [String: ConnectorFlow.Pending] = [:]
    private var remoteLoop: Task<Void, Never>?

    func startRemoteReconnects(interval: Duration = .seconds(10)) {
        guard remoteLoop == nil else { return }
        remoteLoop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollRemoteReconnects()
                try? await Task.sleep(for: interval)
            }
        }
    }

    func pollRemoteReconnects() async {
        guard let base, let token,
              let data = await deps.remote(base, token, "GET", "/v1/connector-reconnects/pending", nil),
              let items = try? JSONDecoder().decode(RemoteResponse.self, from: data).items else { return }
        for item in items {
            let list = sources.filter { $0.provider == item.provider }
            let path = "/v1/connector-reconnects/\(item.id)"
            guard let first = list.first,
                  let clientId = Self.connectionClientId(provider: first.provider, readOnly: first.readOnly, env: deps.configuration()) else {
                _ = await deps.remote(base, token, "POST", "\(path)/finished", ["ok": false]); continue
            }
            if item.state == "requested" {
                var scopes = Set(list.flatMap(\.scopes))
                if first.readOnly { scopes.formUnion(first.provider == "google" ? ["openid", "email"] : ["User.Read"]) }
                guard let prepared = ConnectorFlow.prepareRemote(provider: first.provider, clientId: clientId, scopes: scopes.sorted()) else {
                    _ = await deps.remote(base, token, "POST", "\(path)/finished", ["ok": false]); continue
                }
                remoteFlows[item.id] = prepared.pending
                _ = await deps.remote(base, token, "POST", "\(path)/authorize", ["authorize_url": prepared.url])
            } else if item.state == "code", let pending = remoteFlows.removeValue(forKey: item.id) {
                let callback = OauthCallback(code: item.code, state: item.callback_state, error: item.error, errorDescription: nil, idToken: nil, displayName: nil)
                await finish(list: list, callback: callback, pending: pending, clientId: clientId,
                    secret: ConnectionConfiguration.clientSecret(provider: first.provider, readOnly: first.readOnly, values: deps.configuration()),
                    base: base, token: token)
                let ok = list.contains { status[$0.statusKey] == .connected }
                var body: [String: Any] = ["ok": ok]
                if ok, let account = accounts[first.provider] { body["account"] = account }
                _ = await deps.remote(base, token, "POST", "\(path)/finished", body)
            } else if item.state == "code" {
                // アプリが手続きの途中で起動し直した。verifier が無いので交換できない
                _ = await deps.remote(base, token, "POST", "\(path)/finished", ["ok": false])
            }
        }
    }

    @discardableResult func connect(_ app: String) -> Bool { source(named: app).map { connect(source: $0) } ?? false }
    @discardableResult func connect(source: Source) -> Bool { begin([source]) }
    @discardableResult func connectProvider(_ provider: String) -> Bool { begin(sources.filter { $0.provider == provider }) }
    @discardableResult private func begin(_ list: [Source]) -> Bool {
        guard activeProvider == nil, let first = list.first else { return false }
        let config = deps.configuration()
        guard let clientId = Self.connectionClientId(provider: first.provider, readOnly: first.readOnly, env: config) else {
            list.forEach { update($0, .cannotConnect) }; return false
        }
        guard let base, let token, !base.isEmpty, !token.isEmpty else {
            list.forEach { update($0, .failed("Genieの接続先に届きません。再確認してから接続してください。")) }; return false
        }
        refreshTask?.cancel(); generation = UUID(); let attempt = generation
        activeProvider = first.provider; activeSources = list; notice[first.provider] = nil
        list.forEach { update($0, .connecting) }
        var scopes = Set(list.flatMap(\.scopes))
        if first.readOnly { scopes.formUnion(first.provider == "google" ? ["openid", "email"] : ["User.Read"]) }
        work = Task {
        guard !Task.isCancelled, generation == attempt else { return }
        let started = (try? await flow.begin(provider: first.provider, clientId: clientId, scopes: scopes.sorted(), onTimeout: { [weak self] in
            guard let self, self.generation == attempt else { return }
            self.fail(list, "認証の待ち時間が過ぎました。もう一度接続してください。")
        }) { [weak self] callback, pending in
            guard let self, self.generation == attempt else { return }
            self.work = Task {
                await self.finish(list: list, callback: callback, pending: pending, clientId: clientId,
                    secret: ConnectionConfiguration.clientSecret(provider: first.provider, readOnly: first.readOnly, values: config),
                    base: base, token: token, attempt: attempt)
            }
        }) ?? false
        if !started, generation == attempt { fail(list, "認証画面を開けませんでした。既定のブラウザーを確認して再試行してください。") }
        }
        return true
    }
    func cancel() {
        let list = activeSources
        generation = UUID(); work?.cancel(); flow.stopLoopback(); activeProvider = nil; activeSources = []
        list.forEach { update($0, canConnect($0.name) ? .disconnected : .cannotConnect) }
        if let provider = list.first?.provider { notice[provider] = "接続を中止しました。いつでもやり直せます。" }
        refresh()
    }
    private func fail(_ list: [Source], _ reason: String) {
        list.forEach { update($0, .failed(reason)) }; activeProvider = nil; activeSources = []; flow.stopLoopback()
    }
    func finish(list: [Source], callback: OauthCallback, pending: ConnectorFlow.Pending, clientId: String,
                secret: String?, base: String, token: String, attempt: UUID? = nil) async {
        let attempt = attempt ?? generation
        guard let first = list.first, callback.state == pending.state else { fail(list, "認証を確認できません。もう一度接続してください。"); return }
        guard callback.error == nil, let code = callback.code else { fail(list, "接続は許可されませんでした。必要なサービスを許可して再試行できます。"); return }
        list.forEach { update($0, .checking) }
        do {
            var credential = try await deps.exchange(first.provider, clientId, secret, pending, code)
            guard attempt == generation, !Task.isCancelled else { return }
            guard Self.scopesSafe(credential.grantedScopes, for: list) else { fail(list, "許可の範囲が接続の用途と一致しません。専用の接続設定を確認してください。"); return }
            let accepted = list.filter { Self.permits($0, granted: credential.grantedScopes) }
            guard !accepted.isEmpty else { fail(list, "メールや予定の読み取りが許可されていません。利用するサービスを選んで再接続してください。"); return }
            credential.accountLabel = await deps.account(first.provider, credential.accessToken)
            guard attempt == generation, !Task.isCancelled else { return }
            for s in accepted {
                // 読めない古い項目は、戻す先にもならない。本人がつなぎ直しているので作り直す。
                var locked = false
                let previous: String?
                do { previous = try deps.read(s) } catch KeychainStore.KeychainError.accessDenied { previous = nil; locked = true }
                let text = String(decoding: try JSONEncoder().encode(credential), as: UTF8.self)
                if locked, let replace = deps.replaceLocked { try replace(s, text) } else { try deps.write(s, text) }
                do { try await deps.register(base, token, s, credential) }
                catch {
                    if let previous { try? deps.write(s, previous) } else { try? deps.delete(s) }
                    throw error
                }
                // A completed registration remains real even if UI cancellation happened meanwhile.
                guard attempt == generation, !Task.isCancelled else { return }
                update(s, .connected)
            }
            if first.readOnly { accounts[first.provider] = credential.accountLabel }
            for s in list where !accepted.contains(s) { update(s, .failed("このサービスへの許可がありません。接続し直して選択できます。")) }
            if first.readOnly {
                notice[first.provider] = accepted.count == list.count ? "接続できました。初期Profileや今日の予定に活用できます。" : "許可されたサービスを接続しました。残りは再接続して追加できます。"
            }
            activeProvider = nil; activeSources = []
            WorkContextStore.shared.load()
        } catch {
            guard attempt == generation, !Task.isCancelled else { return }
            for s in list where status[s.statusKey] != .connected { update(s, .failed("接続を保存できませんでした。通信と接続設定を確認し、再試行してください。")) }
            activeProvider = nil; activeSources = []
        }
    }
    func disconnect(_ app: String) { if let s = source(named: app) { disconnectProvider(s.provider) } }
    func disconnectProvider(_ provider: String) {
        guard activeProvider == nil else { return }
        let reads = sources.filter { $0.provider == provider }
        let actions = reads.flatMap { s -> [Source] in
            let store = PluginRuntimeStore.shared; store.load()
            return store.manifests.first(where: { $0.id == s.pluginId })?.connectors.compactMap { c in
                c.readOnly ? nil : actionsSource(pluginId: s.pluginId, connectorId: c.id)
            } ?? []
        }
        guard let base, let token else { fail(reads, "接続先に届きません。通信を確認してください。"); return }
        refreshTask?.cancel(); generation = UUID(); let attempt = generation
        activeProvider = provider; activeSources = reads
        reads.forEach { update($0, .disconnecting) }
        work = Task {
            do {
                for s in reads + actions {
                    let rows = try await deps.list(base, token, s)
                    guard attempt == generation, !Task.isCancelled else { return }
                    if rows.contains(where: { $0.connectorId == s.connectorId && $0.state != "REVOKED" }) { try await deps.remove(base, token, s) }
                    guard attempt == generation, !Task.isCancelled else { return }
                    try deps.delete(s)
                    update(s, canConnect(s.name) ? .disconnected : .cannotConnect)
                }
                accounts[provider] = nil; disconnectFailures.remove(provider); notice[provider] = "接続を解除しました。保存済みの成果物は引き続き開けます。"
            } catch {
                guard attempt == generation, !Task.isCancelled else { return }
                disconnectFailures.insert(provider)
                reads.forEach { update($0, .failed("切断を完了できませんでした。通信とKeychainを確認してもう一度切断してください。")) }
            }
            activeProvider = nil; activeSources = []
        }
    }
}
