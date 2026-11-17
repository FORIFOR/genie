import Foundation
import AppKit
import Combine

/// 今日のまとめ（先回り 段階1、読み取り専用）。
///
/// 設定した朝の時刻を過ぎて、まだ今日のまとめが無ければ作る（Mac を開いたときにも見る）。止まっていた日の分を
/// まとめて作り直さない（作るのは今日の 1 枚だけ）。作ったら**黙って**持っておき、Dock を勝手に開かない。
/// 本人が「今日どう？」と聞いたとき・メニューから開いたときに見せる。
///
/// 予定（EventKit）と対応事項（Work）は Mac が持っている範囲だけを渡す。天気・ニュースは端末のサービスが
/// 許可された取得先から取る。どれかが取れなければ「未更新」と書く（推測で埋めない）。
@MainActor
final class BriefStore: ObservableObject {
    static let shared = BriefStore()
    /// この時刻を過ぎたら今日のまとめを作る。
    nonisolated static let morningHour = 8
    static let interestsKey = "genie.brief.interests"

    @Published private(set) var latest: BriefCard?
    @Published private(set) var composing = false
    @Published private(set) var lastFailure: String?
    @Published private(set) var preferences: BriefPreferences
    private var base: String?
    private var token: String?
    private var timer: Timer?
    private var waiters: [(BriefCard?) -> Void] = []
    private var wakeObserver: NSObjectProtocol?
    private var connectionObserver: AnyCancellable?
    private var lastAttempt: Date?
    private var attemptDay = ""
    private var attempts = 0
    private var refreshAfterCurrent = false

    private let fileURL: URL
    private let preferencesURL: URL

    init(fileURL: URL? = nil, preferencesURL: URL? = nil) {
        self.fileURL = fileURL ?? LocalStore.dataRoot.appendingPathComponent("brief-latest.json")
        self.preferencesURL = preferencesURL ?? LocalStore.dataRoot.appendingPathComponent("brief-preferences.json")
        if let data = try? Data(contentsOf: self.preferencesURL),
           let saved = try? JSONDecoder().decode(BriefPreferences.self, from: data), saved.validationMessage == nil {
            preferences = saved.normalized
        } else {
            var value = BriefPreferences()
            value.interests = Array((UserDefaults.standard.stringArray(forKey: Self.interestsKey) ?? []).prefix(3))
            let regionFile = self.preferencesURL.deletingLastPathComponent().appendingPathComponent("current-info.json")
            if let data = try? Data(contentsOf: regionFile),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let region = object["default_region"] as? String, !region.isEmpty { value.region = region }
            preferences = value.validationMessage == nil ? value : BriefPreferences()
        }
        if let data = try? Data(contentsOf: self.fileURL), let body = String(data: data, encoding: .utf8) {
            latest = BriefCard.decode(body)
        }
    }

    var scheduleLabel: String {
        preferences.enabled
            ? String(format: "毎日 %02d:%02d · Genie起動中に更新、スリープ時は復帰後", preferences.hour, preferences.minute)
            : "自動更新はオフ · 更新ボタンで取得できます"
    }

    /// Device location is only handed to the local execution service. A remote
    /// connection can still fetch public weather for an explicitly chosen region.
    nonisolated static func permitsDeviceWeather(base: String) -> Bool {
        guard let url = URLComponents(string: base), ["http", "https"].contains(url.scheme ?? ""),
              url.user == nil, url.password == nil else { return false }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host?.lowercased() ?? "")
    }

    /// 保存と更新は明示操作。取得条件の変更中も、前回の紙面は残す。
    @discardableResult func updatePreferences(_ value: BriefPreferences) -> String? {
        let value = value.normalized
        if let error = value.validationMessage { return error }
        do {
            try Self.save(JSONEncoder().encode(value), to: preferencesURL)
            preferences = value
            if base != nil {
                if composing { refreshAfterCurrent = true } else { compose() }
            }
            return nil
        } catch { return "設定を保存できませんでした。もう一度お試しください。" }
    }

    /// 隔離したselftestの描画用。保存や外部取得は行わない。
    func installPreview(_ card: BriefCard?, composing: Bool = false, failure: String? = nil) {
        latest = card; self.composing = composing; lastFailure = failure
    }

    private static func save(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func configureBackend(base: String, token: String) {
        self.base = base; self.token = token
        refreshIfDue()
    }

    /// 1分ごととスリープ復帰時に確認する。過去の日の分は作り直さない。
    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshIfDue() }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshIfDue() }
        }
        connectionObserver = ConnectorState.shared.$connected.removeDuplicates().dropFirst().sink { [weak self] connected in
            guard let self, self.preferences.enabled, !connected.isEmpty, !self.composing, self.base != nil,
                  let mail = self.today()?.sections.first(where: { $0.id == "mail" }), mail.status != "ok" else { return }
            self.compose()
        }
        refreshIfDue()
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
    nonisolated static func isDue(latest: BriefCard?, now: Date, calendar: Calendar = .current,
                                 preferences: BriefPreferences = BriefPreferences()) -> Bool {
        preferences.enabled && calendar.component(.hour, from: now) * 60 + calendar.component(.minute, from: now)
            >= preferences.hour * 60 + preferences.minute && latest?.date != day(now, calendar: calendar)
    }

    func refreshIfDue(now: Date = Date()) {
        guard preferences.enabled, !composing, base != nil else { return }
        let today = today(now: now)
        let repair = today?.sections.contains(where: { $0.status == "stale" }) == true
            || (today != nil && today?.sections.contains(where: { $0.id == "mail" }) == false)
        guard Self.isDue(latest: latest, now: now, preferences: preferences) || repair else { return }
        if attemptDay != Self.day(now) { attempts = 0 }
        guard attempts < 3, lastAttempt.map({ now.timeIntervalSince($0) >= 1800 }) ?? true else { return }
        compose(now: now)
    }

    /// いま作る（朝の自動・「今日どう？」で今日の分が無いとき）。終わったら `done` を呼ぶ（失敗は nil）。
    func compose(now: Date = Date(), allowLocationPrompt: Bool = false, done: ((BriefCard?) -> Void)? = nil) {
        if let done { waiters.append(done) }
        guard !composing else { return }
        guard let base, let token else { finish(nil, failure: "Genie のサービスにつながっていません"); return }
        composing = true
        lastFailure = nil
        if attemptDay != Self.day(now) { attempts = 0; attemptDay = Self.day(now) }
        attempts += 1; lastAttempt = now
        let conditions = preferences
        Task { [weak self] in
            guard let self else { return }
            var input = Self.input(
                now: now,
                calendarStatus: CalendarAccess.status(),
                events: CalendarAccess.today(now: now),
                work: WorkContextStore.shared.context,
                workFailed: WorkContextStore.shared.failure != nil,
                interests: conditions.interests)
            input["region"] = conditions.region
            input["watchlist"] = conditions.watchlist
            if conditions.useCurrentLocation {
                input["weather_location"] = Self.permitsDeviceWeather(base: base)
                    ? await BriefWeatherLocation.input(allowPrompt: allowLocationPrompt)
                    : ["status": "none", "reason": "現在地の天気はこのMacのサービス接続で利用できます。地域を指定してください"]
            }
            guard let json = try? JSONSerialization.data(withJSONObject: input),
                  let inputJson = String(data: json, encoding: .utf8) else { finish(nil, failure: "材料を組めませんでした"); return }
            GenieLog.write("brief", "compose: current-location=\(conditions.useCurrentLocation)")
            do {
                let card = try await Task.detached {
                    let taskId = try GenieCoreBridge.createTask(base, accessToken: token, kind: "brief.today", inputJson: inputJson)
                    let deadline = Date().addingTimeInterval(90)
                    var status = try GenieCoreBridge.waitTask(base, accessToken: token, taskId: taskId, timeoutMs: 20_000)
                    while !["COMPLETED", "FAILED", "CANCELLED"].contains(status.status), Date() < deadline {
                        status = try GenieCoreBridge.waitTask(base, accessToken: token, taskId: taskId, timeoutMs: 20_000)
                    }
                    guard status.status == "COMPLETED", !status.resultArtifactId.isEmpty else {
                        throw BriefFailure(message: "まとめの取得を完了できませんでした")
                    }
                    let body = try GenieCoreBridge.artifactContent(base, accessToken: token, artifactId: status.resultArtifactId)
                    return BriefCard.decode(body)
                }.value
                finish(card, failure: card == nil ? "まとめを読めませんでした" : nil)
            } catch {
                finish(nil, failure: "今日のまとめを更新できませんでした。接続を確認して、もう一度更新してください。")
            }
        }
    }

    /// この明示操作だけでOSの位置情報許可を求める。毎朝のバックグラウンド取得では求めない。
    func authorizeWeatherLocation() { compose(allowLocationPrompt: true) }

    private func finish(_ card: BriefCard?, failure: String?) {
        composing = false
        lastFailure = failure
        if let card {
            latest = card
            if let data = card.encoded() {
                do { try Self.save(data, to: fileURL) }
                catch { lastFailure = "表示は更新しましたが、このMacに保存できませんでした。" }
            }
            GenieLog.write("brief", "ready \(card.date): \(card.sections.map { "\($0.id)=\($0.status)" }.joined(separator: " "))")
        } else {
            GenieLog.write("brief", "failed: \(GenieLog.clip(failure ?? "?", 160))")
        }
        let pending = waiters; waiters = []
        pending.forEach { $0(card) }
        if refreshAfterCurrent {
            refreshAfterCurrent = false
            compose()
        }
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
                // 冒頭の要約で名指すのは本人が確かめた TODO だけ（推測の候補は件数だけ）。
                if item.confirmed == true { row["confirmed"] = true }
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
