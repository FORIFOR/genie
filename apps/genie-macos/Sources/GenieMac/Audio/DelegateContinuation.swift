import Foundation

/// 依頼の続き: Gemini が言いかけの間で delegate_task を呼んだとき、その後に聞こえた言葉を依頼に足す。
/// 例: 「端末を 120 台にしたら」＋「提案書とスライドも合わせた案を作って」。
enum DelegateContinuation {
    /// 続きを足した依頼。続きが空か、依頼に既に入っていれば、依頼のまま。
    static func merge(_ request: String, continuation: String) -> String {
        let req = request.trimmingCharacters(in: .whitespacesAndNewlines)
        let more = continuation.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "、。,.")))
        guard !more.isEmpty, !normalized(req).contains(normalized(more)) else { return request }
        let joiner = req.hasSuffix("、") || req.hasSuffix(",") ? "" : "、"
        return req + joiner + more
    }

    /// 二つ目の依頼が、先に足した続きと同じ話か（片方がもう片方に含まれる）。
    static func isPart(_ request: String, of continuation: String) -> Bool {
        let a = normalized(request), b = normalized(continuation)
        guard a.count >= 4, b.count >= 4 else { return false }
        return a.contains(b) || b.contains(a)
    }

    /// 「注文したい」だけで、どこで・何をが無い依頼。Gemini は「マクドナルドで注文したい」を間（ま）で
    /// 「マクドナル」「したい」の 2 ターンに分け、後ろだけを渡すことがあった（liveflow 2026-10-16）。
    static func lacksSubject(_ request: String) -> Bool {
        let value = request.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "、。,.!！")))
        return value.range(of: #"^(?:を|で)?(?:注文|デリバリー|宅配|出前|オーダー)(?:を)?(?:して|したい|する|します|お願い(?:します)?|頼みたい)?(?:です|ください)?$"#,
                           options: .regularExpression) != nil
    }

    /// 主語の無い注文の依頼に、直前に聞き取った言葉（同じ依頼の前半）を前に足す。
    /// `heardBefore` は前の依頼の後に聞き取ったすべて。依頼の言葉（「したい」など）より前の短い部分だけを使う。
    static func withSubject(_ request: String, heardBefore: String) -> String {
        guard lacksSubject(request) else { return request }
        var before = heardBefore.trimmingCharacters(in: .whitespacesAndNewlines)
        // 後ろの「したい」「注文したい」（いま頼まれた部分）を除く。
        if let tail = before.range(of: #"[、。\s]*(?:注文|デリバリー|宅配|出前)?(?:を)?(?:して|したい|する|します)?[。.!！]*$"#, options: .regularExpression) {
            before = String(before[..<tail.lowerBound])
        }
        before = before.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "、。,.")))
        // 長い前置き（別の話）は足さない。
        guard !before.isEmpty, before.count <= 20 else { return request }
        let req = request.trimmingCharacters(in: .whitespacesAndNewlines)
        let joiner = before.hasSuffix("で") || before.hasSuffix("を") || req.hasPrefix("で") || req.hasPrefix("を") ? "" : "で"
        return before + joiner + req
    }

    private static func normalized(_ text: String) -> String {
        let folded = text.applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? text
        return String(folded.lowercased().unicodeScalars.filter {
            !CharacterSet.whitespacesAndNewlines.contains($0) && !CharacterSet.punctuationCharacters.contains($0)
        }.map(Character.init))
    }
}
