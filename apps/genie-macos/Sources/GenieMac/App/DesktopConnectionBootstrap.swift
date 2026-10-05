import Foundation
import Darwin

/// A saved connection choice, never credentials or proof that a backend is running.
/// Applied before AppKit and app singletons so Swift and Rust share one workspace.
enum DesktopConnectionBootstrap {
    static let fileName = "desktop-connection.json"
    static let issueMessage = "接続設定の再確認が必要です。Genieの起動コマンドを実行してください。"
    static let allowedKeys: Set<String> = ["ASTRA_GATEWAY_URL", "ASTRA_DATA_ROOT", "ASTRA_DESKTOP_IDENTITY", "ASTRA_LLM_CLI",
        "ASTRA_LOCAL_LLM_URL", "ASTRA_LOCAL_LLM_MODEL", "ASTRA_CODEX_MODEL", "ASTRA_LOCAL_VISION",
        "ASTRA_MODEL_DISCLOSURE", "ASTRA_RUNTIME_CONFIGURATION_ERROR"]
    enum Selection: Equatable { case ignored, absent, configured([String: String]), invalid }
    enum Invalid: Error { case configuration }
    private struct Descriptor: Decodable {
        let version: Int
        let gatewayURL: String
        let workspace: String
        let desktopIdentity: UUID
        let model: Model
        let externalAuthorization: Authorization?
        struct Model: Decodable { let provider: String; let name: String; let url: String? }
        struct Authorization: Decodable { let provider: String; let model: String }
    }

    /// 起動コマンド（scripts/local-preview/config.mjs の EXTERNAL_PROVIDERS）と同じ送信先の言い方。
    static let externalProviders: [String: (recipient: String, via: String)] = [
        "codex": ("OpenAI", "Codex接続"),
        "claude_code": ("Anthropic", "Claude Code接続"),
        "gemini_api": ("Google", "Gemini API"),
    ]

    static var isInvalid: Bool { ProcessInfo.processInfo.environment["ASTRA_RUNTIME_CONFIGURATION_ERROR"] == "1" }

    static func install() {
        let state = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Genie/local-preview", isDirectory: true)
        let selection = select(state: state, environment: ProcessInfo.processInfo.environment, arguments: CommandLine.arguments)
        let projection: [String: String]
        switch selection {
        case .ignored, .absent: return
        case .configured(let values): projection = values
        case .invalid:
            projection = ["ASTRA_RUNTIME_CONFIGURATION_ERROR": "1", "ASTRA_LLM_CLI": "unavailable",
                          "ASTRA_MODEL_DISCLOSURE": issueMessage]
        }
        do { try apply(projection) }
        catch {
            // An incomplete environment must not revive a default local model.
            fputs("Genie: connection configuration could not be applied.\n", stderr)
            exit(1)
        }
    }

    static func apply(_ projection: [String: String]) throws {
        guard Set(projection.keys).isSubset(of: allowedKeys),
              projection.values.allSatisfy({ !$0.contains("\0") }) else { throw Invalid.configuration }
        for (key, value) in projection {
            guard setenv(key, value, 1) == 0 else { throw Invalid.configuration }
        }
    }

    static func select(state: URL, environment: [String: String], arguments: [String]) -> Selection {
        // Explicit launch/test environments always retain their original isolation.
        guard !arguments.contains("--selftest"), !arguments.contains("--native-messaging"),
              !environment.keys.contains(where: { $0.hasPrefix("ASTRA_") }) else { return .ignored }
        do {
            guard let data = try readPrivateDescriptor(state: state) else { return .absent }
            return .configured(try projection(data, workspace: state.appendingPathComponent("app").path))
        } catch { return .invalid }
    }

    static func projection(_ data: Data, workspace: String) throws -> [String: String] {
        guard data.count <= 16_384,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["version", "gatewayURL", "workspace", "desktopIdentity", "model", "externalAuthorization"],
              let model = object["model"] as? [String: Any],
              Set(model.keys) == (model["provider"] as? String == "local" ? ["provider", "name", "url"] : ["provider", "name"])
        else { throw Invalid.configuration }
        var keys = UniqueJSONKeys(bytes: Array(data))
        try keys.validate()
        let value = try JSONDecoder().decode(Descriptor.self, from: data)
        guard value.version == 1, value.workspace == workspace,
              value.gatewayURL.range(of: #"^http://127\.0\.0\.1:[0-9]{4,5}$"#, options: .regularExpression) != nil,
              let port = URL(string: value.gatewayURL)?.port, (1024...65535).contains(port),
              value.model.name.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$"#, options: .regularExpression) != nil
        else { throw Invalid.configuration }
        var result = ["ASTRA_GATEWAY_URL": value.gatewayURL, "ASTRA_DATA_ROOT": workspace,
                      "ASTRA_DESKTOP_IDENTITY": value.desktopIdentity.uuidString.lowercased(),
                      "ASTRA_LLM_CLI": value.model.provider]
        switch value.model.provider {
        case "codex", "claude_code", "gemini_api":
            // 外部へ送る提供元は、その提供元・そのモデルへの明示の許可が保存されているときだけ通す。
            guard let external = externalProviders[value.model.provider],
                  let authorization = object["externalAuthorization"] as? [String: Any],
                  Set(authorization.keys) == ["provider", "model"],
                  value.externalAuthorization?.provider == value.model.provider,
                  value.externalAuthorization?.model == value.model.name else { throw Invalid.configuration }
            if value.model.provider == "codex" { result["ASTRA_CODEX_MODEL"] = value.model.name }
            result["ASTRA_LOCAL_VISION"] = "0"
            result["ASTRA_MODEL_DISCLOSURE"] = "送信先: \(external.recipient) の \(value.model.name)（\(external.via)）。依頼した文章や添付画像を外部モデルへ送ります。"
        case "local":
            guard object["externalAuthorization"] is NSNull,
                  value.model.name.range(of: #"(?:^|[:/_-])cloud(?:$|[:/_-])"#, options: [.regularExpression, .caseInsensitive]) == nil,
                  let endpoint = value.model.url, let url = URL(string: endpoint),
                  url.scheme == "http",
                  ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? ""),
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
            else { throw Invalid.configuration }
            result["ASTRA_LOCAL_LLM_URL"] = endpoint
            result["ASTRA_LOCAL_LLM_MODEL"] = value.model.name
            result["ASTRA_LOCAL_VISION"] = "1"
            result["ASTRA_MODEL_DISCLOSURE"] = "送信先: このMacの \(value.model.name)（\(endpoint)）。外部モデルへの切替はありません。"
        default: throw Invalid.configuration
        }
        return result
    }

    /// Foundation dictionaries discard duplicate keys. Reject ambiguity before
    /// decoding so schema validation and model selection cannot see different values.
    private struct UniqueJSONKeys {
        let bytes: [UInt8]
        var index = 0
        mutating func whitespace() { while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 } }
        mutating func string() throws -> String {
            let start = index
            guard index < bytes.count, bytes[index] == 34 else { throw Invalid.configuration }
            index += 1
            while index < bytes.count {
                let byte = bytes[index]; index += 1
                if byte == 92 { index += 1 }
                else if byte == 34 { return try JSONDecoder().decode(String.self, from: Data(bytes[start..<index])) }
            }
            throw Invalid.configuration
        }
        mutating func value(_ depth: Int) throws {
            guard depth < 8 else { throw Invalid.configuration }
            whitespace(); guard index < bytes.count else { throw Invalid.configuration }
            if bytes[index] == 34 { _ = try string(); return }
            if bytes[index] == 123 {
                index += 1; whitespace(); var seen = Set<String>()
                while index < bytes.count && bytes[index] != 125 {
                    let key = try string()
                    guard seen.insert(key).inserted else { throw Invalid.configuration }
                    whitespace(); guard index < bytes.count, bytes[index] == 58 else { throw Invalid.configuration }
                    index += 1; try value(depth + 1); whitespace()
                    if index < bytes.count && bytes[index] == 44 { index += 1; whitespace() } else { break }
                }
                guard index < bytes.count, bytes[index] == 125 else { throw Invalid.configuration }
                index += 1; return
            }
            // Arrays are never valid in this deliberately small descriptor schema.
            guard bytes[index] != 91 else { throw Invalid.configuration }
            while index < bytes.count && ![9, 10, 13, 32, 44, 125].contains(bytes[index]) { index += 1 }
        }
        mutating func validate() throws {
            try value(0); whitespace()
            guard index == bytes.count else { throw Invalid.configuration }
        }
    }

    /// Open relative to the checked directory; never follow a descriptor symlink.
    /// Read from that same fd through EOF, then reject concurrent in-place mutation.
    private static func readPrivateDescriptor(state: URL) throws -> Data? {
        let path = state.standardizedFileURL.path
        let directory = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        if directory < 0 {
            if errno == ENOENT { return nil }
            throw Invalid.configuration
        }
        defer { close(directory) }
        var directoryInfo = stat()
        guard fstat(directory, &directoryInfo) == 0, directoryInfo.st_uid == getuid(),
              (directoryInfo.st_mode & 0o7777) == 0o700,
              state.resolvingSymlinksInPath().standardizedFileURL.path == path else { throw Invalid.configuration }
        let descriptor = openat(directory, fileName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if descriptor < 0 {
            if errno == ENOENT { return nil }
            throw Invalid.configuration
        }
        defer { close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
              before.st_uid == getuid(), (before.st_mode & 0o7777) == 0o600,
              (2...16_384).contains(before.st_size) else { throw Invalid.configuration }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw Invalid.configuration }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= 16_384 else { throw Invalid.configuration }
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0, before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size, data.count == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { throw Invalid.configuration }
        // A workspace symlink must not switch the Rust/native data root elsewhere.
        let app = state.appendingPathComponent("app", isDirectory: true)
        var workspaceInfo = stat()
        guard lstat(app.path, &workspaceInfo) == 0, (workspaceInfo.st_mode & S_IFMT) == S_IFDIR,
              workspaceInfo.st_uid == getuid(), (workspaceInfo.st_mode & 0o077) == 0,
              app.resolvingSymlinksInPath().standardizedFileURL.path == app.standardizedFileURL.path
        else { throw Invalid.configuration }
        return data
    }
}
