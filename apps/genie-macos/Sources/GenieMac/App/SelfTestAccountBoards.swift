import AppKit
import SwiftUI

extension SelfTest {
    /// 予約・チャット連携・音声入力の設定を、見本のデータで描いて PNG にする（画面は撮らない・サーバに行かない）。
    /// `--selftest accountboards <dir>`
    @MainActor static func accountBoardShots(_ args: [String]) async {
        let directory = args.count > 3 ? args[3] : "/tmp/genie-account-boards"
        let schedules = ScheduleBoard.shared
        let chat = ChatChannelsBoard.shared
        let agents = AgentSessionsBoard.shared
        schedules.installForTesting([
            .init(id: "a", name: "毎日 8:00 に「今日の予定をまとめて」を頼む", status: "active", kind: "task",
                  next_run_at: "2026-10-21T23:00:00.000Z", last_error: nil, consecutive_errors: 0),
            .init(id: "b", name: "平日の 18:00 に「日報を書く」をお知らせ", status: "paused", kind: "reminder",
                  next_run_at: nil, last_error: nil, consecutive_errors: 0),
            .init(id: "c", name: "15 分ごとに「メールを確認して」を頼む", status: "disabled", kind: "task",
                  next_run_at: nil, last_error: "仕事を始められませんでした", consecutive_errors: 10),
        ])
        agents.installForTesting([
            .init(id: "s1", source: "claude_code", project: "genie", title: "Dock にセッションの一覧を出す", state: "working",
                  waiting_reason: nil, user_policy: "watch", attention: "working", last_activity_at: "2026-10-28T05:00:00.000Z"),
            .init(id: "s2", source: "claude_code", project: "api", title: "決済の webhook を直す", state: "waiting_user",
                  waiting_reason: "permission", user_policy: "watch", attention: "needs_user", last_activity_at: "2026-10-28T04:58:00.000Z"),
            .init(id: "s3", source: "claude_code", project: "docs", title: "README を書き直す", state: "idle",
                  waiting_reason: nil, user_policy: "paused_by_user", attention: "paused", last_activity_at: "2026-10-28T04:00:00.000Z"),
            .init(id: "s4", source: "claude_code", project: "ios", title: "ログイン画面を直す", state: "idle",
                  waiting_reason: nil, user_policy: "watch", attention: "idle", last_activity_at: "2026-10-28T04:30:00.000Z",
                  check_state: "passed"),
            .init(id: "s5", source: "claude_code", project: "design", title: "ヘッダの案を作る", state: "waiting_user",
                  waiting_reason: "permission", user_policy: "paused_by_user", attention: "held",
                  last_activity_at: "2026-10-28T03:00:00.000Z"),
        ])
        WorkOverviewBoard.shared.installForTesting(.init(
            counts: .init(running: 2, needs_user: 2, suspected: 0, held: 1, done_today: 1),
            attention: ["Claude Code（api）が承認を待っています（12 分前から）", "「旅程の予約」があなたの承認を待っています"]))
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
            // 権限の札が隣に重ならないか（長い権限名で札が横に伸びていた。2026-10-23）
            PluginRuntimeStore.shared.load()
            try shoot("apps-plugins", width: 1100) { dark in PluginsPane().background(Palette.canvas(dark)) }
            try shoot("apps-chat", width: 900) { dark in
                ChatChannelsCard(board: chat, dark: dark).padding(28).background(Palette.canvas(dark))
            }
            for pane in SettingsPane.allCases {
                try shoot("settings-\(pane.rawValue)", width: 460) { _ in
                    // 窓の地（設定の窓は窓の地の上に描かれる。透明のまま撮ると暗い面で字が見えない）
                    settingsFixture(pane: pane).background(Color(nsColor: .windowBackgroundColor))
                }
            }
            try shoot("settings-dictation-fixture", width: 460) { _ in
                DictationSettingsSection(fixtureEntries: entries, fixtureHistory: history).padding(24)
            }
            schedules.installForTesting([]); agents.installForTesting([]); chat.installForTesting(status: nil, links: [], code: nil)
            let tall = geometry.filter { ($0["name"] as? String ?? "").hasPrefix("settings-")
                && !($0["name"] as? String ?? "").hasPrefix("settings-dictation-fixture")
                && ($0["height"] as? CGFloat ?? 0) > settingsPaneMaxHeight }
            try JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("geometry.json"))
            if !tall.isEmpty {
                print("SELFTEST_FAIL accountboards: 設定の面が \(Int(settingsPaneMaxHeight))pt を超えた \(tall)"); exit(2)
            }
            print("SELFTEST_OK accountboards: \(geometry.count) offscreen renders; settings panes ≤ \(Int(settingsPaneMaxHeight))pt; no screen capture, no gateway")
            exit(0)
        } catch { print("SELFTEST_FAIL accountboards: \(error)"); exit(1) }
    }
}
