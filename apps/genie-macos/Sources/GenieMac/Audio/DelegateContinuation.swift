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

    /// 呼ばれた後に手元で文字にした音（`tail`）を依頼の後ろに足す。文字にした音は依頼の終わりと重なることがある
    /// （「チーズバーガーのM」+「Mセットを注文して」）。重なった分は足さない。
    static func appendTail(_ request: String, tail: String) -> String {
        let req = request.trimmingCharacters(in: .whitespacesAndNewlines)
        let more = Array(tail.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "、。,."))))
        guard !more.isEmpty else { return request }
        let head = normalized(req)
        guard !head.contains(normalized(String(more))) else { return request }
        // 依頼の終わりと同じ書き出しを、長い方から探す。
        var cut = 0
        for k in stride(from: more.count, through: 1, by: -1) where head.hasSuffix(normalized(String(more.prefix(k)))) && !normalized(String(more.prefix(k))).isEmpty {
            cut = k; break
        }
        // 重ならないが同じ書き出し（手元の認識が言い方を少し違えて全体を拾った）なら、手元の全体を使う。
        if cut == 0, head.count >= 2, normalized(String(more)).hasPrefix(String(head.prefix(2))),
           normalized(String(more)).count > head.count {
            return String(more)
        }
        let rest = String(more.dropFirst(cut)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rest.isEmpty else { return request }
        return req + rest
    }

    /// 手元で文字にした `local` が、Gemini の聞き取り `heard` より言葉が多ければ、それを返す（切れていた）。
    /// 2 文字以上多く、聞き取った言葉の書き出しと重なるときだけ（別の音を拾っただけのものは渡さない）。
    static func longerHearing(_ local: String, than heard: String) -> String? {
        let a = normalized(local), b = normalized(heard)
        guard !a.isEmpty, a.count >= b.count + 2 else { return nil }
        guard b.isEmpty || a.contains(b) || a.hasPrefix(String(b.prefix(2))) else { return nil }
        return local.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Gemini が黙ったときに渡す、手元の聞き取り。Gemini と同じ言葉なら nil（黙ったのは Gemini の判断）。
    /// 黙った後なので、書き出しが違う（聞き違えた）ものも渡す。1 文字だけの音は渡さない。
    static func differentHearing(_ local: String, than heard: String) -> String? {
        let a = normalized(local), b = normalized(heard)
        guard a.count >= 2, a != b, !b.contains(a) else { return nil }
        return local.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `earlier` が `request` をすべて含むか（同じ依頼の呼び直し）。短すぎる言葉（「ひとつ」）は同じとみなさない。
    static func covers(_ earlier: String, _ request: String) -> Bool {
        let a = normalized(earlier), b = normalized(request)
        guard b.count >= 4 else { return false }
        return a.contains(b)
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
