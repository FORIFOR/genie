import Foundation

/// gateway の本人の操作（予約・チャット連携・辞書）を呼ぶ小さな道具。中身は JSON で、トークンは見せない。
struct GatewayJSON {
    let base: String
    let token: String

    /// 呼んで、状態と本文を返す。つながらなければ nil。
    func call(_ method: String, _ path: String, body: [String: Any]? = nil) async -> (status: Int, data: Data)? {
        guard let url = URL(string: base + path) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body, let data = try? JSONSerialization.data(withJSONObject: body) {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = data
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return nil }
        return (http.statusCode, data)
    }
}

/// 予約の一覧（作業一覧の上に出す）。作るのは会話だけ。ここでは止める・再開・取り消すだけ。
@MainActor
final class ScheduleBoard: ObservableObject {
    static let shared = ScheduleBoard()

    struct Item: Decodable, Identifiable, Equatable {
        let id: String
        let name: String
        let status: String
        let kind: String
        let next_run_at: String?
        let last_error: String?
        let consecutive_errors: Int

        /// 「次は 10/22（木）8:00」/「止めています」/「止まりました（…）」
        var stateLine: String {
            switch status {
            case "paused": return "止めています"
            case "disabled": return "続けて失敗したので止まりました" + (last_error.map { "（\($0)）" } ?? "")
            default:
                guard let next = next_run_at.flatMap(ScheduleBoard.parse) else { return "次の予定はありません" }
                return "次は " + ScheduleBoard.format(next)
            }
        }
    }

    @Published private(set) var items: [Item] = []
    @Published private(set) var problem: String?
    private var api: GatewayJSON?

    func configureBackend(base: String, token: String) {
        api = GatewayJSON(base: base, token: token)
        Task { await refresh() }
    }

    func refresh() async {
        guard let api, let result = await api.call("GET", "/v1/schedules"), result.status == 200 else { return }
        items = Self.decode(result.data)
    }

    /// 検査の撮影用（サーバに行かない）。
    func installForTesting(_ items: [Item]) { self.items = items; problem = nil }

    /// paused / active / cancelled
    func set(_ item: Item, status: String) async {
        guard let api else { return }
        let result = await api.call("PATCH", "/v1/schedules/\(item.id)", body: ["status": status])
        problem = result?.status == 200 ? nil : "予約を変えられませんでした。時間をおいて試してください。"
        await refresh()
    }

    nonisolated static func decode(_ data: Data) -> [Item] {
        struct Response: Decodable { let items: [Item] }
        return (try? JSONDecoder().decode(Response.self, from: data))?.items ?? []
    }

    nonisolated static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// 「10/22（木）8:00」（サーバの formatWhen と同じ形）
    nonisolated static func format(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.month, .day, .weekday, .hour, .minute], from: date)
        let days = ["日", "月", "火", "水", "木", "金", "土"]
        return "\(c.month ?? 0)/\(c.day ?? 0)（\(days[((c.weekday ?? 1) - 1) % 7])）\(c.hour ?? 0):" + String(format: "%02d", c.minute ?? 0)
    }
}

/// Slack・LINE とのつながり（アプリ連携に出す）。トークンや外の利用者 ID は受け取らない。
@MainActor
final class ChatChannelsBoard: ObservableObject {
    static let shared = ChatChannelsBoard()

    struct Status: Decodable, Equatable {
        struct Slack: Decodable, Equatable {
            let configured: Bool
            let transport: String?
        }
        struct Line: Decodable, Equatable { let configured: Bool }
        let slack: Slack
        let line: Line
    }
    struct Link: Decodable, Identifiable, Equatable {
        let id: String
        let provider: String
        let created_at: String
        let last_seen_at: String?
    }
    struct Code: Equatable {
        let provider: String
        let message: String
        let expires: Date
    }

    @Published private(set) var status: Status?
    @Published private(set) var links: [Link] = []
    @Published private(set) var code: Code?
    @Published private(set) var problem: String?
    private var api: GatewayJSON?

    func configureBackend(base: String, token: String) {
        api = GatewayJSON(base: base, token: token)
        Task { await refresh() }
    }

    func refresh() async {
        guard let api, let result = await api.call("GET", "/v1/channels/status"), result.status == 200,
              let decoded = try? JSONDecoder().decode(Status.self, from: result.data) else { return }
        status = decoded
        guard decoded.slack.configured || decoded.line.configured,
              let listed = await api.call("GET", "/v1/channels/links"), listed.status == 200 else {
            links = []; return
        }
        struct Response: Decodable { let items: [Link] }
        links = (try? JSONDecoder().decode(Response.self, from: listed.data))?.items ?? []
    }

    /// 検査の撮影用（サーバに行かない）。
    func installForTesting(status: Status?, links: [Link], code: Code?) {
        self.status = status; self.links = links; self.code = code; problem = nil
    }

    /// 連携コードを出す（10 分・1 回）。チャットで「連携 <コード>」と送ると結ばれる。
    func issueCode(_ provider: String) async {
        guard let api else { return }
        struct Response: Decodable { let message: String; let expires_at: String }
        guard let result = await api.call("POST", "/v1/channels/link-codes", body: ["provider": provider]),
              result.status == 201,
              let decoded = try? JSONDecoder().decode(Response.self, from: result.data),
              let expires = ScheduleBoard.parse(decoded.expires_at) else {
            problem = "連携コードを出せませんでした。"; return
        }
        problem = nil
        code = Code(provider: provider, message: decoded.message, expires: expires)
    }

    func unlink(_ link: Link) async {
        guard let api else { return }
        let result = await api.call("DELETE", "/v1/channels/links/\(link.id)")
        problem = result?.status == 204 ? nil : "連携を解除できませんでした。"
        await refresh()
    }

    static func title(_ provider: String) -> String { provider == "slack" ? "Slack" : "LINE" }
}
