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

    private static func normalized(_ text: String) -> String {
        let folded = text.applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? text
        return String(folded.lowercased().unicodeScalars.filter {
            !CharacterSet.whitespacesAndNewlines.contains($0) && !CharacterSet.punctuationCharacters.contains($0)
        }.map(Character.init))
    }
}
