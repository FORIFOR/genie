import Foundation

/// U109「声が返ってこない。何が原因？」: マイク・呼びかけ・Gemini のキー・Gemini の利用可否（課金）・
/// 月の上限・Genie のサービス接続を順に確かめ、原因と直し方を並べる。別の会話経路へは切り替えない。
@MainActor
enum VoiceDiagnosis {
    struct Item: Equatable {
        let ok: Bool
        let name: String
        let detail: String
        /// 直し方（問題があるときだけ）。
        let fix: String?
    }

    /// 文字の依頼から診断を求められたか（「声が返ってこない」「反応しない」「原因は」「診断して」）。
    static func isRequest(_ text: String) -> Bool {
        text.range(of: "(声|返事|返答|音声|ジーニー).{0,8}(返ってこない|返らない|出ない|聞こえない|反応しない|動かない)|診断して|なぜ.{0,6}(反応|返事)",
                   options: .regularExpression) != nil
    }

    static func run(gemini: GeminiLiveSettings = .shared, ping: ((String) async -> Int?)? = nil) async -> [Item] {
        var items: [Item] = []
        let mic = Permissions.microphone == .granted
        items.append(Item(ok: mic, name: "マイク", detail: mic ? "許可されています" : "許可されていません",
                          fix: mic ? nil : "システム設定 → プライバシーとセキュリティ → マイク で Genie を許可してください。"))

        let wake = WakeController.shared
        // 検査の実行では待ち受けを始めないので、モデルが置かれているかだけを見る。
        let loaded = wake.detector != nil
            || (CommandLine.arguments.contains("--selftest") && LiveKitWakeDetector.modelURL() != nil)
        let wakeOK = !wake.enabled || loaded
        items.append(Item(ok: wakeOK, name: "「ジーニー」の待ち受け",
                          detail: !wake.enabled ? "オフにしています" : (loaded ? "待ち受け中" : "呼びかけモデルを読み込めていません"),
                          fix: wakeOK ? nil : "Genie を起動し直してください。直らなければ genie.log の [wake] を確認します。"))

        await gemini.refreshKeyPresence()
        let keyOK = gemini.hasKey && gemini.keyAccessIssue == nil
        items.append(Item(ok: keyOK, name: "Gemini のキー",
                          detail: keyOK ? "登録されています" : (gemini.keyAccessIssue ?? "登録されていません"),
                          fix: keyOK ? nil : "設定で Gemini の API キーを登録してください（AI Studio のコピーボタンで写すと確実です）。"))

        if keyOK, let key = gemini.apiKey() {
            let status = await (ping ?? Self.ping)(key)
            let (ok, detail, fix): (Bool, String, String?) = switch status {
            case 200: (true, "使えます", nil)
            case 402: (false, "前払いクレジットが空です", "AI Studio でこのキーのプロジェクトにクレジットを追加してください。")
            case 400, 401, 403: (false, "キーが受け付けられません（HTTP \(status!)）", "AI Studio でキーを確認し、貼り直してください。")
            case 429: (false, "利用の上限に達しています", "しばらく待つか、AI Studio で上限を確認してください。")
            case nil: (false, "Google に届きません", "インターネット接続を確認してください。")
            default: (false, "応答が異常です（HTTP \(status!)）", "少し待ってから、もう一度確かめてください。")
            }
            items.append(Item(ok: ok, name: "Gemini の利用", detail: detail, fix: fix))
        }

        let left = Int(gemini.budget.remainingSeconds(at: Date()) / 60)
        let budgetOK = left > 0
        items.append(Item(ok: budgetOK, name: "Gemini Live の月の上限",
                          detail: "残り約 \(left) 分（上限 \(gemini.budget.monthlyMinutes) 分）",
                          fix: budgetOK ? nil : "設定で月の上限を上げてください。"))
        if let blocked = wake.billingBlocked {
            items.append(Item(ok: false, name: "支払いで止めている状態", detail: blocked,
                              fix: "クレジットを足したら、Dock から会話を始めるか「呼びかけを試す」で解除されます。"))
        }

        let data = MainData.shared
        let connOK = data.connected && data.connectionIssue == nil
        items.append(Item(ok: connOK, name: "Genie のサービス（仕事の実行）",
                          detail: connOK ? "つながっています" : (data.connectionIssue?.message ?? "つながっていません"),
                          fix: connOK ? nil : "設定 → 接続 の「再確認」を押してください。声の会話はできますが、頼んだ仕事は実行されません。"))
        GenieLog.write("diagnosis", items.map { "\($0.name)=\($0.ok ? "ok" : "ng")" }.joined(separator: " "))
        return items
    }

    /// 結果を短い文にする（問題が無ければ一文、あれば問題だけを直し方つきで）。
    static func summary(_ items: [Item]) -> String {
        let problems = items.filter { !$0.ok }
        guard !problems.isEmpty else { return "マイク・呼びかけ・Gemini・接続はすべて正常です。" }
        return (["見つかった問題:"] + problems.map { "・\($0.name): \($0.detail)。\($0.fix ?? "")" }).joined(separator: "\n")
    }

    /// Gemini の利用可否（ごく短い文章生成。モデル一覧ではクレジット切れが分からない）。HTTP 状態だけを返す。
    static func ping(_ key: String) async -> Int? {
        var request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent")!,
                                 timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["contents": [["parts": [["text": "OK"]]]],
                                                                      "generationConfig": ["maxOutputTokens": 1]])
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return nil }
        return (response as? HTTPURLResponse)?.statusCode
    }
}
