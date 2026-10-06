import Foundation

/// 今日のまとめ（先回り 段階1、読み取り専用）。
///
/// 朝 7 時を過ぎて、まだ今日のまとめが無ければ作る（Mac を開いたときにも見る）。止まっていた日の分を
/// まとめて作り直さない（作るのは今日の 1 枚だけ）。作ったら**黙って**持っておき、Dock を勝手に開かない。
/// 本人が「今日どう？」と聞いたとき・メニューから開いたときに見せる。
///
/// 予定（EventKit）と対応事項（Work）は Mac が持っている範囲だけを渡す。天気・ニュースは端末のサービスが
/// 許可された取得先から取る。どれかが取れなければ「未更新」と書く（推測で埋めない）。
@MainActor
final class BriefStore: ObservableObject {
    static let shared = BriefStore()
    /// この時刻を過ぎたら今日のまとめを作る。
    nonisolated static let morningHour = 7
    static let interestsKey = "genie.brief.interests"

    @Published private(set) var latest: BriefCard?
    @Published private(set) var composing = false
    private(set) var lastFailure: String?
    private var base: String?
    private var token: String?
    private var timer: Timer?
    private var waiters: [(BriefCard?) -> Void] = []

    private var fileURL: URL { LocalStore.dataRoot.appendingPathComponent("brief-latest.json") }

    init() {
        if let data = try? Data(contentsOf: fileURL), let body = String(data: data, encoding: .utf8) {
            latest = BriefCard.decode(body)
        }
    }

    func configureBackend(base: String, token: String) {
        self.base = base; self.token = token
        refreshIfDue()
    }

    /// 10 分ごとに「作る時刻か」を見る（作るのは 1 日 1 回）。
    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { _ in
            Task { @MainActor in BriefStore.shared.refreshIfDue() }
        }
    }

    /// 今日のまとめがあるか（日付が今日のもの）。
    func today(now: Date = Date()) -> BriefCard? {
        guard let latest, latest.date == Self.day(now) else { return nil }
        return latest
    }

    nonisolated static func day(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// 朝の時刻を過ぎていて、今日のまとめがまだ無いか。
    nonisolated static func isDue(latest: BriefCard?, now: Date, calendar: Calendar = .current) -> Bool {
        calendar.component(.hour, from: now) >= morningHour && latest?.date != day(now, calendar: calendar)
    }

    func refreshIfDue(now: Date = Date()) {
        guard Self.isDue(latest: latest, now: now), !composing, base != nil else { return }
        compose()
    }

    /// いま作る（朝の自動・「今日どう？」で今日の分が無いとき）。終わったら `done` を呼ぶ（失敗は nil）。
    func compose(now: Date = Date(), done: ((BriefCard?) -> Void)? = nil) {
        if let done { waiters.append(done) }
        guard !composing else { return }
        guard let base, let token else { finish(nil, failure: "Genie のサービスにつながっていません"); return }
        composing = true
        let input = Self.input(
            now: now,
            calendarStatus: CalendarAccess.status(),
            events: CalendarAccess.today(now: now),
            work: WorkContextStore.shared.context,
            workFailed: WorkContextStore.shared.failure != nil,
            interests: UserDefaults.standard.stringArray(forKey: Self.interestsKey) ?? [])
        guard let json = try? JSONSerialization.data(withJSONObject: input),
              let inputJson = String(data: json, encoding: .utf8) else { finish(nil, failure: "材料を組めませんでした"); return }
        GenieLog.write("brief", "compose: events=\((input["calendar"] as? [String: Any])?["status"] ?? "?")")
        Task.detached {
            do {
                let taskId = try GenieCoreBridge.createTask(base, accessToken: token, kind: "brief.today", inputJson: inputJson)
                let deadline = Date().addingTimeInterval(90)
                var status = try GenieCoreBridge.waitTask(base, accessToken: token, taskId: taskId, timeoutMs: 20_000)
                while !["COMPLETED", "FAILED", "CANCELLED"].contains(status.status), Date() < deadline {
                    status = try GenieCoreBridge.waitTask(base, accessToken: token, taskId: taskId, timeoutMs: 20_000)
                }
                guard status.status == "COMPLETED", !status.resultArtifactId.isEmpty else {
                    throw BriefFailure(message: "まとめの仕事が \(status.status) で終わりました")
                }
                let body = try GenieCoreBridge.artifactContent(base, accessToken: token, artifactId: status.resultArtifactId)
                let card = BriefCard.decode(body)
                await MainActor.run { BriefStore.shared.finish(card, failure: card == nil ? "まとめを読めませんでした" : nil) }
            } catch {
                await MainActor.run { BriefStore.shared.finish(nil, failure: String(describing: error)) }
            }
        }
    }

    private func finish(_ card: BriefCard?, failure: String?) {
        composing = false
        lastFailure = failure
        if let card {
            latest = card
            if let data = card.encoded() {
                try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: fileURL, options: [.atomic])
            }
            GenieLog.write("brief", "ready \(card.date): \(card.sections.map { "\($0.id)=\($0.status)" }.joined(separator: " "))")
        } else {
            GenieLog.write("brief", "failed: \(GenieLog.clip(failure ?? "?", 160))")
        }
        let pending = waiters; waiters = []
        pending.forEach { $0(card) }
    }

    /// サービスへ渡す材料（BriefArgs）。予定は今日の分、対応事項は Work の「返すもの」。
    nonisolated static func input(now: Date, calendarStatus: CalendarAccess.Access, events: [CalendarAccess.Event],
                      work: WorkContext?, workFailed: Bool, interests: [String]) -> [String: Any] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        iso.timeZone = .current
        let stamp = iso.string(from: now)
        let calendarStatusText: String = switch calendarStatus {
        case .granted: "granted"
        case .notDetermined: "notDetermined"
        default: "denied"
        }
        let eventRows: [[String: Any]] = calendarStatus == .granted ? events.prefix(40).map { e in
            var row: [String: Any] = [
                "title": String(e.title.prefix(200)),
                "start": iso.string(from: Date(timeIntervalSince1970: e.startEpoch)),
                "end": iso.string(from: Date(timeIntervalSince1970: e.endEpoch)),
            ]
            if let location = e.location, !location.isEmpty { row["location"] = String(location.prefix(200)) }
            if e.allDay { row["allDay"] = true }
            return row
        } : []
        var attention: [String: Any]
        if let work, work.inferenceEnabled, work.sources.values.reduce(0, +) > 0 {
            attention = ["status": "ok", "fetched_at": work.generatedAt, "items": work.owed.prefix(30).map { item in
                var row: [String: Any] = ["title": String(item.what.prefix(200)), "from": String(item.to.prefix(120)), "ref": item.id]
                if let due = item.dueAt { row["due"] = String(due.prefix(40)) }
                return row
            }]
        } else if workFailed {
            attention = ["status": "stale", "items": [[String: Any]]()]
        } else {
            attention = ["status": "none", "items": [[String: Any]]()]
        }
        return [
            "date": day(now),
            "calendar": ["status": calendarStatusText, "events": eventRows, "fetched_at": stamp],
            "attention": attention,
            "interests": Array(interests.prefix(3)),
        ]
    }
}

private struct BriefFailure: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}
