import Foundation

/// Genie の API キー・鍵の置き場所は **macOS のキーチェーン 1 か所**（docs/SECRETS.ja.md）。
/// サービス（手元の gateway・スクリプト）は、この口からだけ読み書きする: `Genie --secret get|set|delete|status <名前>`。
///
/// 読み書きするのは同じ署名の Genie 自身なので、macOS のパスワードの確認は出ない（`security` で読むと出る。
/// ConnectorSecretCommand と同じ理由）。値は標準入出力で渡し、引数やログに出さない。
/// 扱う名前は下の表だけ。Mac の設定で入れた Gemini・Google マップのキーも同じ項目を使う（二重に持たない）。
enum SecretCommand {
    static let flag = "--secret"
    static let notFound: Int32 = 44

    /// 名前 → キーチェーンの項目（サービス `com.astra.mac` のアカウント名）。
    static let items: [(name: String, account: String)] = [
        // GeminiLiveSettings.keychainKey・PlacesSettings.keychainKey と同じ項目（試験で一致を確かめる）
        ("gemini", "gemini.live.apiKey"),
        ("google-maps", "googleMaps.apiKey.v2"),
        ("line-channel-secret", "genie.line.channelSecret"),
        ("line-access-token", "genie.line.accessToken"),
        ("anthropic", "genie.anthropic.apiKey"),
        ("genie-secret-key", "genie.secretKey"),
        ("slack-bot-token", "genie.slack.botToken"),
        ("slack-app-token", "genie.slack.appToken"),
        ("channel-action-secret", "genie.channelActionSecret"),
        // LINE の中継（公式アカウント 1 つ）。この Genie の鍵（install id と secret）と、中継を置く人の登録の合言葉
        ("line-hub", "genie.lineHub.credential"),
        ("line-hub-registration", "genie.lineHub.registrationToken"),
    ]

    struct Store {
        var get: (String) throws -> String?
        var set: (String, String) throws -> Void
        var delete: (String) throws -> Void
        static let live = Store(
            get: { try KeychainStore.get($0) },
            set: { try KeychainStore.set($0, $1) },
            delete: { try KeychainStore.delete($0) })
    }

    /// 起動時に最初に呼ぶ。指定が無ければ何もしない。あれば処理して終わる（画面は出さない）。
    static func runIfRequested(_ args: [String] = CommandLine.arguments) {
        guard let i = args.firstIndex(of: flag) else { return }
        exit(run(Array(args[(i + 1)...]), store: .live,
                 input: { FileHandle.standardInput.readDataToEndOfFile() },
                 output: { FileHandle.standardOutput.write(Data($0.utf8)) }))
    }

    static func run(_ rest: [String], store: Store, input: () -> Data, output: (String) -> Void) -> Int32 {
        // status: どの名前が入っているかだけ（値は出さない）
        if rest == ["status"] {
            for item in items {
                let present = ((try? store.get(item.account)) ?? nil).map { !$0.isEmpty } ?? false
                output("\(item.name)\t\(present ? "set" : "missing")\n")
            }
            return 0
        }
        guard rest.count == 2, let item = items.first(where: { $0.name == rest[1] }) else { return 2 }
        do {
            switch rest[0] {
            case "get":
                guard let value = try store.get(item.account), !value.isEmpty else { return notFound }
                output(value); return 0
            case "set":
                let value = String(decoding: input(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty, !value.contains("\n") else { return 2 }
                try store.set(item.account, value); return 0
            case "delete":
                try store.delete(item.account); return 0
            default:
                return 2
            }
        } catch {
            return 45
        }
    }
}
