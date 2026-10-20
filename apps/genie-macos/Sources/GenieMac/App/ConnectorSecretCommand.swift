import Foundation

/// Genie のサービス（agent-host）が接続の鍵を読み書きする口: `Genie --connector-secret get|set|delete <service>`。
///
/// これまでサービスは `/usr/bin/security` で読み書きしていた。macOS はキーチェーンの項目ごとに読める相手
/// （partition）を持ち、アプリが作った項目を `security` で読むとパスワードを求め、`security` で書き戻すと
/// アプリが読めなくなった（2026-10-16〜20。Gmail のつなぎ直しでログインパスワードを求めた）。
/// 同じ署名の Genie 自身が読み書きすれば、確認なしで通る。パスワードを求めてよいのは本人が個人情報や
/// パスワードを入れるときだけ。
///
/// 扱うのは接続の項目（`com.astra.connector.`）だけ。値は標準入出力で渡し、引数やログに出さない。
enum ConnectorSecretCommand {
    static let flag = "--connector-secret"
    /// `security` と同じ「無い」の終了コード（agent-host の isNotFound）。
    static let notFound: Int32 = 44

    struct Store {
        var get: (String) throws -> String?
        var set: (String, String) throws -> Void
        var delete: (String) throws -> Void
        static let live = Store(
            get: { try KeychainStore.getGeneric(service: $0, account: NSUserName()) },
            set: { try KeychainStore.setConnectorSecret(service: $0, account: NSUserName(), value: $1) },
            delete: { try KeychainStore.deleteGeneric(service: $0, account: NSUserName()) })
    }

    /// 起動時に最初に呼ぶ。指定が無ければ何もしない。あれば処理して終わる（画面は出さない）。
    static func runIfRequested(_ args: [String] = CommandLine.arguments) {
        guard let i = args.firstIndex(of: flag) else { return }
        exit(run(Array(args[(i + 1)...]), store: .live,
                 input: { FileHandle.standardInput.readDataToEndOfFile() },
                 output: { FileHandle.standardOutput.write(Data($0.utf8)) }))
    }

    static func run(_ rest: [String], store: Store, input: () -> Data, output: (String) -> Void) -> Int32 {
        guard rest.count == 2, rest[1].hasPrefix("com.astra.connector."), !rest[1].contains("\n") else { return 2 }
        let service = rest[1]
        do {
            switch rest[0] {
            case "get":
                guard let value = try store.get(service) else { return notFound }
                output(value); return 0
            case "set":
                let value = String(decoding: input(), as: UTF8.self)
                guard !value.isEmpty else { return 2 }
                try store.set(service, value); return 0
            case "delete":
                try store.delete(service); return 0
            default:
                return 2
            }
        } catch {
            return 45
        }
    }
}
