import Foundation

/// 文字の「今日の予定は？」「今日のまとめ」を、声と同じ今日のまとめで答える（予定は Mac と Google カレンダーから）。
/// 以前は Work の項目だけを見る一般の答えに回り、カレンダーを読まずに「予定はありません」と返していた（askprobe 2026-10-19）。
/// 予定を作る・変える依頼（「今日の予定に会議を入れて」）は拾わない。
enum TodayBriefIntent {
    static func detect(_ request: String) -> Bool {
        let text = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 40 else { return false }
        func matches(_ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
        if matches("追加|入れて|登録|作って|作成|消して|削除|変更|変えて|ずらし|移して|キャンセル|送って|共有") { return false }
        return matches("^(?:今日|きょう|本日)(?:の|は)?(?:予定|スケジュール|まとめ)")
            || matches("(?:今日|きょう|本日)(?:は)?(?:何か)?(?:予定|スケジュール)(?:は|って|ある|入って|どう|を教えて|教えて|[？?]|$)")
            || matches("^(?:朝の)?まとめ(?:を)?(?:教えて|見せて|出して)?[。？?]?$")
    }
}
