import Foundation

/// 画面操作の引き継ぎを言葉で行う（受け入れ項目書 2026-10-29 の T13・T14・E2E-04）。
///
///   「ここから自分で操作する」 → いま動いている画面操作の入力を止め、本人の番にする（Genie からは何も打たない）
///   「続きお願い」             → 本人の番を終える。続きは helper が画面を撮り直してから（古い座標は使わない）
///
/// 印は helper（tools/computer-use/BackgroundAX.swift）と worker（computer-vision.ts）が読む場所に置く:
///   `<受け渡し場所>/background-<session>.json.handoff`    本人の番（helper は再開を断り、worker は待ち続ける）
///   `<受け渡し場所>/background-<session>.json.interrupted` 送りかけの入力を失効させる（人が触ったときと同じ印）
/// 印には理由の語（handoff）だけを書く。画面も入力文字も書かない。
@MainActor
enum ComputerHandoff {
    enum Intent: Equatable { case take, giveBack }

    /// 決まった言い方だけ。「続けて」だけのような短い語は、本人の番のときだけ受ける（ふだんの会話を奪わない）。
    nonisolated static func intent(_ request: String, handing: Bool) -> Intent? {
        let text = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 40 else { return nil }
        func matches(_ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
        // やり方を訊いている（「自分で操作する方法を教えて」）のは引き継ぎではない
        if matches("方法|やり方|どうやって|どうすれば|教えて|[？?]") { return nil }
        if matches("(?:ここから|ここからは|この先は|あとは|いったん)?\\s*(?:自分で|わたしが|私が|僕が|俺が)\\s*(?:操作する|操作します|やる|やります|触る|入力する)")
            || matches("操作を?(?:代わって|代わる|交代して?|引き継ぐ)") {
            return .take
        }
        guard handing else { return nil }
        if matches("^(?:じゃあ|では)?、?\\s*(?:続き|つづき)(?:を)?\\s*(?:お願い|おねがい|して|やって|進めて)|^(?:続けて|つづけて|再開して|戻して|返す|代わって)(?:ください|いいよ|大丈夫)?[。.!！]?$|^.{0,12}(?:終わった|おわった|できた|済んだ)(?:よ|ので|から)?[、。!！]?\\s*(?:続き|つづき)?.{0,8}$") {
            return .giveBack
        }
        return nil
    }

    static var directoryOverride: URL?
    private static var directory: URL { directoryOverride ?? VisualContextStore.handoverDirectory }

    /// 開いている画面操作（helper の許可ファイル）。
    private static func sessions() -> [URL] {
        let items = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return items.filter { $0.lastPathComponent.hasPrefix("background-") && $0.pathExtension == "json" }
    }

    /// 本人の番になっているか。
    static var handing: Bool {
        sessions().contains { FileManager.default.fileExists(atPath: $0.path + ".handoff") }
    }

    /// 本人の番にする。止めた画面操作の数を返す（0 なら、いま動いている画面操作は無い）。
    @discardableResult
    static func take() -> Int {
        var count = 0
        for session in sessions() {
            let handoff = session.path + ".handoff"
            let interrupted = session.path + ".interrupted"
            guard write("handoff", to: handoff) else { continue }
            // 送りかけの入力を失効させる（人が触ったときと同じ扱い。再開では世代が進み、撮り直してから続く）
            if !FileManager.default.fileExists(atPath: interrupted) { _ = write("human_takeover:handoff", to: interrupted) }
            count += 1
        }
        GenieLog.write("handoff", "take sessions=\(count)")
        return count
    }

    /// 本人の番を終える。戻した数を返す。
    @discardableResult
    static func giveBack() -> Int {
        var count = 0
        for session in sessions() where unlink(session.path + ".handoff") == 0 { count += 1 }
        GenieLog.write("handoff", "give back sessions=\(count)")
        return count
    }

    /// 本人だけが読める印を書く（helper の privateFile と同じく 0600）。
    private static func write(_ text: String, to path: String) -> Bool {
        FileManager.default.createFile(atPath: path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600])
    }

    /// 回答面に出す言葉。
    nonisolated static func answer(for intent: Intent, sessions: Int) -> String {
        switch intent {
        case .take:
            return sessions > 0
                ? "わかりました。Genie の入力を止めました。終わったら「続きお願い」と言ってください。いまの画面を確かめ直してから続けます。"
                : "いま Genie が操作している画面はありません。そのまま操作してください。"
        case .giveBack:
            return sessions > 0
                ? "続きを始めます。古い画面は使わず、いまの画面を撮り直してから進めます。"
                : "引き継いでいる画面操作はありません。"
        }
    }
}
