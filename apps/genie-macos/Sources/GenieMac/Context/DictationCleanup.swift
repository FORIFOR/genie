import Foundation

/// 音声入力の「整える」（本人の決定: 整えるだけ・Mac の中だけ）。
///
/// **言葉は変えない。**消すのは、ほかの意味になり得ない言い淀みだけ（えー・えっと・えーと・うーん など）。
/// 「あの」「その」「まあ」は消さない（「あの資料」「その件」は指示語）。句読点は認識器が付ける
/// （`SpeechTranscriber(punctuate:)`）。
///
/// 端末内の生成モデル（Apple Intelligence）で清書することも試したが、採らなかった
/// （docs/ux-benchmark/compare/dictation-cleanup/ROUND.md）: 「追加してほしい」を「追加しました」に変える、
/// 「明日の天気教えて」に答える、文の中の指示に従って詩を書く。文字の差で弾く検査を足すと、通るものは
/// 言い淀みを残したままで、整える役に立たなかった。
enum DictationCleanup {
    /// ほかの意味になり得ない言い淀み。長いものから順に消す。
    static let fillers = ["えーっと", "えーっとー", "えーと", "えっと", "えー", "うーん", "うーむ", "あー", "あぁ", "んー"]

    /// 区切り（息継ぎの間）で入れる文の終わり。句読点で終わっていなければ「。」を付ける
    /// （続けて入れた区切りがつながって一文に見えないように。macOS の音声入力と同じ）。
    static func terminated(_ text: String) -> String {
        guard let last = text.last else { return text }
        return "。．.！!？?、，,…」』)）".contains(last) ? text : text + "。"
    }

    static func clean(_ text: String) -> String {
        var t = text
        for filler in fillers.sorted(by: { $0.count > $1.count }) {
            // 語の頭（文頭・句読点や空白の後）にある時だけ消す。語の中（「ケーキ」等）は触らない。
            let pattern = "(^|[、。，．,.!?！？\\s])" + NSRegularExpression.escapedPattern(for: filler) + "[ー〜~]*[、，,\\s]*"
            guard let re = try? NSRegularExpression(pattern: pattern) else { continue }
            t = re.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "$1")
        }
        // 消した跡の読点の重なり・文頭の読点を整える。
        t = t.replacingOccurrences(of: "、、", with: "、")
        while let first = t.first, "、，, ".contains(first) { t.removeFirst() }
        t = t.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? text : t
    }
}
