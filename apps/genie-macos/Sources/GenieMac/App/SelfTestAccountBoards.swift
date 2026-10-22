import AppKit
import SwiftUI

extension SelfTest {
    /// 予約・チャット連携・音声入力の設定を、見本のデータで描いて PNG にする（画面は撮らない・サーバに行かない）。
    /// `--selftest accountboards <dir>`
    @MainActor static func accountBoardShots(_ args: [String]) async {
        let directory = args.count > 3 ? args[3] : "/tmp/genie-account-boards"
        let schedules = ScheduleBoard.shared
        let chat = ChatChannelsBoard.shared
        schedules.installForTesting([
            .init(id: "a", name: "毎日 8:00 に「今日の予定をまとめて」を頼む", status: "active", kind: "task",
                  next_run_at: "2026-10-21T23:00:00.000Z", last_error: nil, consecutive_errors: 0),
            .init(id: "b", name: "平日の 18:00 に「日報を書く」をお知らせ", status: "paused", kind: "reminder",
                  next_run_at: nil, last_error: nil, consecutive_errors: 0),
            .init(id: "c", name: "15 分ごとに「メールを確認して」を頼む", status: "disabled", kind: "task",
                  next_run_at: nil, last_error: "仕事を始められませんでした", consecutive_errors: 10),
        ])
        chat.installForTesting(
            status: .init(slack: .init(configured: true, transport: "socket"), line: .init(configured: false)),
            links: [.init(id: "l1", provider: "slack", created_at: "2026-10-20T01:00:00.000Z", last_seen_at: "2026-10-21T02:40:00.000Z")],
            code: .init(provider: "slack", message: "連携 7KQ2-9MXD", expires: Date().addingTimeInterval(600)))
        let now = Date()
        let history: [DictationHistory.Item] = [
            .init(id: "h1", at: now.addingTimeInterval(-120), text: "明日の 10 時から Genie のレビューをお願いします。", original: "えー明日の10時からジーニーのレビューをお願いします", app: "Slack"),
            .init(id: "h2", at: now.addingTimeInterval(-3600), text: "資料は共有フォルダに置きました。", original: nil, app: "メール"),
        ]
        let entries: [DictationVocabulary.Entry] = [
            .init(spoken: "ジーニー", written: "Genie", id: "1"),
            .init(spoken: "カレンダーリンク", written: "https://cal.example.com/me", id: "2"),
            .init(spoken: "オープンクロー", written: "オープンクロー", id: "3"),
        ]
        do {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            var geometry: [[String: Any]] = []
            func shoot<V: View>(_ name: String, width: CGFloat, _ view: (Bool) -> V) throws {
                for dark in [false, true] {
                    let host = NSHostingView(rootView: view(dark).environment(\.colorScheme, dark ? .dark : .light)
                        .frame(width: width).fixedSize(horizontal: false, vertical: true))
                    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: 400),
                                          styleMask: [.borderless], backing: .buffered, defer: false)
                    window.isReleasedWhenClosed = false
                    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                    window.contentView = host
                    let size = host.fittingSize
                    window.setContentSize(size)
                    host.frame = NSRect(origin: .zero, size: size)
                    host.layoutSubtreeIfNeeded()
                    guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { throw URLError(.cannotDecodeContentData) }
                    host.cacheDisplay(in: host.bounds, to: bitmap)
                    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw URLError(.cannotDecodeContentData) }
                    let file = "\(name)-\(dark ? "dark" : "light")"
                    try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent(file + ".png"))
                    geometry.append(["name": file, "width": size.width, "height": size.height])
                    window.close()
                }
            }
            try shoot("tasks-schedules", width: 900) { _ in TasksPane() }
            try shoot("apps-chat", width: 900) { dark in
                ChatChannelsCard(board: chat, dark: dark).padding(28).background(Palette.canvas(dark))
            }
            try shoot("settings-dictation", width: 460) { _ in SettingsView() }
            try shoot("settings-dictation-fixture", width: 460) { _ in
                DictationSettingsSection(fixtureEntries: entries, fixtureHistory: history).padding(24)
            }
            schedules.installForTesting([]); chat.installForTesting(status: nil, links: [], code: nil)
            try JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("geometry.json"))
            print("SELFTEST_OK accountboards: \(geometry.count) offscreen renders; no screen capture, no gateway")
            exit(0)
        } catch { print("SELFTEST_FAIL accountboards: \(error)"); exit(1) }
    }
}
