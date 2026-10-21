import AppKit
import Foundation
import UserNotifications

/// サーバに溜まったお知らせ（予約の時間・予約で始めた仕事・予約が止まったこと）を macOS の通知に出す。
///
/// サーバは Mac へ押し込めないので、こちらから取りに行く（20 秒ごとと、スリープ復帰時）。
/// 出したものはサーバに「出した」と返し、二度出さない（`POST /v1/notices/ack`）。
/// 通知の許可は、出すお知らせが実際に来たときにだけ求める（起動時には聞かない）。
@MainActor
final class NoticeInbox {
    static let shared = NoticeInbox()
    /// 通知の id の頭。クリックされたとき、このお知らせだと分かるように。
    static let prefix = "genie.notice."

    struct Item: Decodable, Equatable {
        let id: String
        let kind: String
        let title: String
        let body: String
        let task_id: String?
    }

    /// 出す先（テストでは差し替える）。出せたら true。
    var post: (Item) async -> Bool = NoticeInbox.postSystemNotification
    private var base: String?
    private var token: String?
    private var timer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private var fetching = false

    func configureBackend(base: String, token: String) {
        self.base = base; self.token = token
        Task { await refresh() }
    }

    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { _ in
            Task { @MainActor in await NoticeInbox.shared.refresh() }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in await NoticeInbox.shared.refresh() }
        }
    }

    /// 取りに行き、出し、出したものを返す。重ねて呼ばれたら何もしない。
    @discardableResult
    func refresh() async -> Int {
        guard !fetching, let base, let token, let url = URL(string: "\(base)/v1/notices") else { return 0 }
        fetching = true
        defer { fetching = false }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return 0 }
        let items = Self.decode(data)
        guard !items.isEmpty else { return 0 }
        var shown: [String] = []
        for item in items where await post(item) { shown.append(item.id) }
        if !shown.isEmpty {
            await acknowledge(shown, base: base, token: token)
            GenieLog.write("notice", "shown=\(shown.count) of \(items.count)")
        }
        return shown.count
    }

    nonisolated static func decode(_ data: Data) -> [Item] {
        struct Response: Decodable { let items: [Item] }
        return (try? JSONDecoder().decode(Response.self, from: data))?.items ?? []
    }

    private func acknowledge(_ ids: [String], base: String, token: String) async {
        guard let url = URL(string: "\(base)/v1/notices/ack"),
              let body = try? JSONSerialization.data(withJSONObject: ["ids": ids]) else { return }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        _ = try? await URLSession.shared.data(for: request)
    }

    /// macOS の通知に出す。許可が無ければ出さない（false。サーバに残り、次に許可されたら出る）。
    static func postSystemNotification(_ item: Item) async -> Bool {
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return false }
        let content = UNMutableNotificationContent()
        content.title = item.title
        content.body = item.body
        if item.kind == "reminder" { content.sound = .default }
        content.userInfo = ["kind": item.kind, "task_id": item.task_id ?? ""]
        do {
            try await center.add(UNNotificationRequest(identifier: prefix + item.id, content: content, trigger: nil))
            return true
        } catch {
            NSLog("astra: notice delivery failed")
            return false
        }
    }

    /// 通知をクリックした。仕事のお知らせなら作業一覧、それ以外は Home を開く。
    static func opened(_ notification: UNNotification) {
        let taskId = notification.request.content.userInfo["task_id"] as? String ?? ""
        MainWindowController.shared.showSection(taskId.isEmpty ? .home : .work)
    }
}
