import EventKit
import Foundation

/// カレンダー/リマインダーの読み取り（EventKit）。会議の文脈（今どの予定か）を RAG に渡すため。
///
/// **注意**: 実データの取得は署名済み .app + カレンダー許可(TCC)が要る。`requestFullAccess`
/// が許可プロンプトを出すため headless では取れない。一方、**認可状態の読み取りは TCC 無しで
/// できる**（`status()` は常に有効な列挙を返す）。正本 §3「Calendar/Reminders」。
enum CalendarAccess {
    struct Event: Equatable {
        let title: String
        let startEpoch: Double
        let endEpoch: Double
        let calendar: String
        var location: String? = nil
        var allDay = false
    }

    enum Access: String {
        case notDetermined = "未確認"
        case restricted = "制限"
        case denied = "拒否"
        case granted = "許可済み"
        case writeOnly = "書き込みのみ"
    }

    /// **共有の EKEventStore を保持する。** ローカル変数のままだと、非同期の許可要求が返る前に
    /// store が解放され、completion handler が二度と呼ばれない（プロンプトも成立しない）。Apple も
    /// 単一の長命 store を推奨。
    private static let store = EKEventStore()

    /// 認可状態を読む（プロンプトを出さない）。headless で検証できる。
    static func status() -> Access {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        case .denied: return .denied
        case .writeOnly: return .writeOnly
        case .fullAccess, .authorized: return .granted
        @unknown default: return .notDetermined
        }
    }

    /// 許可を要求する（.app 側でユーザーがダイアログで許す）。
    static func requestAccess(_ done: @escaping (Bool) -> Void) {
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { ok, _ in DispatchQueue.main.async { done(ok) } }
        } else {
            store.requestAccess(to: .event) { ok, _ in DispatchQueue.main.async { done(ok) } }
        }
    }

    /// 今日（0 時から翌 0 時まで）の予定。終わったものも含める（今日のまとめ用）。許可が無ければ空。
    static func today(now: Date = Date(), calendar: Calendar = .current) -> [Event] {
        guard status() == .granted else { return [] }
        let start = calendar.startOfDay(for: now)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: predicate).map { ev in
            Event(
                title: ev.title ?? "(無題)",
                startEpoch: ev.startDate?.timeIntervalSince1970 ?? 0,
                endEpoch: ev.endDate?.timeIntervalSince1970 ?? 0,
                calendar: ev.calendar?.title ?? "",
                location: ev.location,
                allDay: ev.isAllDay
            )
        }.sorted { $0.startEpoch < $1.startEpoch }
    }

    /// 今から `hours` 時間先までの予定を返す。許可が無ければ空（**推測で埋めない**）。
    static func upcoming(hours: Double = 12, now: Date = Date()) -> [Event] {
        guard status() == .granted else { return [] }
        let end = now.addingTimeInterval(hours * 3600)
        let predicate = store.predicateForEvents(withStart: now, end: end, calendars: nil)
        return store.events(matching: predicate).map { ev in
            Event(
                title: ev.title ?? "(無題)",
                startEpoch: ev.startDate?.timeIntervalSince1970 ?? 0,
                endEpoch: ev.endDate?.timeIntervalSince1970 ?? 0,
                calendar: ev.calendar?.title ?? ""
            )
        }
    }
}
