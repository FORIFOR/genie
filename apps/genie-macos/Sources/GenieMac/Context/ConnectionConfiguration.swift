import Foundation

/// Publisher-owned native OAuth configuration. Never contains user tokens.
/// The same allowlisted JSON file is read by the local agent host for refresh.
enum ConnectionConfiguration {
    static let keys: Set<String> = [
        "ASTRA_OAUTH_GOOGLE_CLIENT_ID", "ASTRA_OAUTH_GOOGLE_CLIENT_SECRET",
        "ASTRA_OAUTH_GOOGLE_READ_CLIENT_ID", "ASTRA_OAUTH_GOOGLE_READ_CLIENT_SECRET",
        "ASTRA_OAUTH_GOOGLE_WRITE_CLIENT_ID", "ASTRA_OAUTH_GOOGLE_WRITE_CLIENT_SECRET",
        "ASTRA_OAUTH_MICROSOFT_READ_CLIENT_ID", "ASTRA_OAUTH_MICROSOFT_WRITE_CLIENT_ID",
    ]
    static var localURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Astra/connections.json")
    }
    static func merge(_ layers: [[String: String]]) -> [String: String] {
        var result: [String: String] = [:]
        for layer in layers {
            for (key, value) in layer where keys.contains(key) {
                result[key] = value.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return result
    }
    static func read(_ url: URL?) -> [String: String] {
        guard let url, let data = try? Data(contentsOf: url),
              let values = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return merge([values])
    }
    static var current: [String: String] {
        let env = ProcessInfo.processInfo.environment
        // Fixtures must not consume the user's real configuration.
        // ただし普段の起動でブートストラップ自身が決めた保存先は検査の隔離ではない（2026-10-07: これで
        // ローカルプレビューの Genie が接続設定を読めず、Gmail・カレンダーが「設定が必要」のままだった）。
        let isolated = isolated(dataRoot: env["ASTRA_DATA_ROOT"], projected: DesktopConnectionBootstrap.projectedDataRoot,
                                selftest: CommandLine.arguments.contains("--selftest"))
        let explicit = env["ASTRA_CONNECTIONS_CONFIG"].map { URL(fileURLWithPath: $0) }
        return merge([
            isolated ? [:] : read(Bundle.main.url(forResource: "connections", withExtension: "json")),
            read(explicit ?? (isolated ? nil : localURL)), env,
        ])
    }
    /// 検査（--selftest）か、外から別の保存先を渡された起動なら隔離する。
    static func isolated(dataRoot: String?, projected: String?, selftest: Bool) -> Bool {
        if selftest { return true }
        guard let dataRoot else { return false }
        return dataRoot != projected
    }
    static func clientId(provider: String, readOnly: Bool, values: [String: String]) -> String? {
        let prefix = "ASTRA_OAUTH_" + provider.uppercased()
        let read = values[prefix + "_READ_CLIENT_ID"] ?? (provider == "google" ? values[prefix + "_CLIENT_ID"] : nil)
        let write = values[prefix + "_WRITE_CLIENT_ID"] ?? (provider == "google" ? values[prefix + "_CLIENT_ID"] : nil)
        if provider == "microsoft", let read, !read.isEmpty, read == write { return nil }
        return (readOnly ? read : write).flatMap { $0.isEmpty ? nil : $0 }
    }
    /// The agent host also needs the publisher's parameters to renew a saved grant.
    static func persistForRefresh() throws {
        let values = current
        guard !values.isEmpty else { return }
        try FileManager.default.createDirectory(at: localURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(values).write(to: localURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: localURL.path)
    }
    static func clientSecret(provider: String, readOnly: Bool, values: [String: String]) -> String? {
        guard provider == "google" else { return nil }
        let role = readOnly ? "READ" : "WRITE"
        if values["ASTRA_OAUTH_GOOGLE_\(role)_CLIENT_ID"] != nil {
            return values["ASTRA_OAUTH_GOOGLE_\(role)_CLIENT_SECRET"]
        }
        return values["ASTRA_OAUTH_GOOGLE_CLIENT_SECRET"]
    }
}
