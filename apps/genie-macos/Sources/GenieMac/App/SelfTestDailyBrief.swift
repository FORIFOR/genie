import AppKit
import SwiftUI

extension SelfTest {
    /// Native Home fixtures only. Does not configure a backend or read an account.
    /// --selftest dailybrief <outDir>, with an explicit temporary ASTRA_DATA_ROOT.
    @MainActor static func dailyBriefShots(_ args: [String]) async {
        guard let index = args.firstIndex(of: "--selftest"), args.count > index + 2,
              let dataRoot = ProcessInfo.processInfo.environment["ASTRA_DATA_ROOT"],
              dataRoot.hasPrefix("/tmp/") || dataRoot.hasPrefix("/private/tmp/") else {
            print("SELFTEST_FAIL dailybrief: explicit temporary ASTRA_DATA_ROOT and output directory required")
            exit(2)
        }
        let output = URL(fileURLWithPath: args[index + 2])
        let store = BriefStore.shared
        let profile = InitialProfileStore.shared
        var failures: [String] = []
        var geometry: [[String: Any]] = []
        let stamp = BriefStore.day(Date())
        do {
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            LocalStore.shared.open()
            Permissions.simulatedCalendar = .denied
            Permissions.simulatedInputMonitoring = .granted
            // Defaults below are synthetic and only persist to the temporary root.
            guard store.updatePreferences(BriefPreferences()) == nil else { throw URLError(.cannotWriteToFile) }
            profile.installForTesting(InitialProfileResult(id: "daily-brief-fixture", provider: "google", status: "ready",
                startedAt: stamp + "T07:00:00+09:00", updatedAt: stamp + "T07:05:00+09:00", outcomes: [],
                sections: InitialProfileSections(focus: ["合成データの動作確認"], people: ["サンプルの担当者"], priorities: [], workPattern: [], openItems: 0),
                analysis: InitialProfileAnalysis(version: 2, status: "complete", selectedCount: 2, analyzedCount: 2)))
            profile.openRequested = false
            MainNav.shared.select(.home)
            MainNav.shared.intentDraft = ""
            NSApp.setActivationPolicy(.regular)
            for dark in [false, true] {
                for width in [940.0, 1280.0] {
                    let height = width == 940 ? 620.0 : 820.0
                    NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                    let host = NSHostingView(rootView: AnyView(MainWindowView(loadBackend: false).environment(\.colorScheme, dark ? .dark : .light)))
                    let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: width, height: height),
                        styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
                    window.isReleasedWhenClosed = false
                    window.title = "Genie · 今日のまとめ（合成データ）"
                    window.titlebarAppearsTransparent = true
                    window.contentView = host
                    window.makeKeyAndOrderFront(nil)

                    func capture(_ state: String, checkOverview: Bool = true) async throws {
                        try await Task.sleep(for: .milliseconds(450))
                        host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
                        let name = "\(state)-\(Int(width))-\(dark ? "dark" : "light")"
                        guard let cg = CGWindowListCreateImage(.null, .optionIncludingWindow,
                            CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .nominalResolution]),
                            let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else {
                            failures.append(name + ": capture unavailable"); return
                        }
                        try png.write(to: output.appendingPathComponent(name + ".png"))
                        let frames = DailyBriefMeasurements.frames
                        var record: [String: Any] = ["name": name, "width": host.bounds.width, "height": host.bounds.height,
                            "requestedWidth": width, "requestedHeight": height,
                            "scale": UIScale.shared.size.rawValue, "synthetic": true]
                        record["sections"] = frames.mapValues { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] }
                        if checkOverview {
                            if Set(frames.keys) != Set(["mail", "news", "markets", "weather"]) { failures.append(name + ": missing overview section") }
                            if UIScale.shared.size == .comfortable,
                               frames.values.contains(where: { $0.minY < 0 || $0.maxY > min(height, host.bounds.height) + 1 || $0.width <= 0 }) {
                                failures.append(name + ": overview outside first viewport")
                            }
                            if profile.openRequested { failures.append(name + ": profile unexpectedly replaced daily brief") }
                        }
                        geometry.append(record)
                    }

                    func captureSheet(_ state: String) async throws {
                        guard width == 1280 else { return }
                        // The sheet attaches asynchronously; a fixed 300ms wait failed intermittently
                        // (2026-10-12). Wait up to 2s for it, then capture; still a failure if none appears.
                        for _ in 0..<20 where window.attachedSheet == nil {
                            try await Task.sleep(for: .milliseconds(100))
                        }
                        try await Task.sleep(for: .milliseconds(300))
                        let name = "\(state)-\(Int(width))-\(dark ? "dark" : "light")"
                        guard let sheet = window.attachedSheet,
                              let cg = CGWindowListCreateImage(.null, .optionIncludingWindow,
                                CGWindowID(sheet.windowNumber), [.boundsIgnoreFraming, .nominalResolution]),
                              let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else {
                            failures.append(name + ": sheet capture unavailable"); return
                        }
                        try png.write(to: output.appendingPathComponent(name + ".png"))
                        geometry.append(["name": name, "width": sheet.frame.width, "height": sheet.frame.height,
                                         "synthetic": true, "scale": UIScale.shared.size.rawValue])
                    }

                    for stage in ["ready", "partial", "empty", "loading", "failed", "previous", "long", "location", "location-denied", "location-updating"] {
                        let card = stage == "loading" ? nil : DailyBriefFixture.card(stage: stage, date: stamp)
                        store.installPreview(card, composing: stage == "loading" || stage == "location-updating", failure: stage == "failed" ? "更新できませんでした。接続を確認して、もう一度更新してください。" : nil)
                        try await capture(stage)
                    }
                    store.installPreview(DailyBriefFixture.card(stage: "ready", date: stamp))
                    try await Task.sleep(for: .milliseconds(200))
                    if !UIProbe.tap("dailyBriefSettings") { failures.append("settings entry missing") }
                    try await Task.sleep(for: .milliseconds(300))
                    if !UIProbe.exists("dailyBriefSettingsSave") { failures.append("settings save missing") }
                    try await captureSheet("settings")
                    // Cancel exercises the production dismissal; preferences stay unchanged.
                    if !UIProbe.tap("dailyBriefSettingsCancel") { failures.append("settings cancel missing") }
                    try await Task.sleep(for: .milliseconds(300))
                    if !UIProbe.tap("dailyBriefSettings") { failures.append("settings reopen missing") }
                    try await Task.sleep(for: .milliseconds(300))
                    if !UIProbe.tap("dailyBriefSettingsSave") { failures.append("settings save action missing") }
                    if store.preferences != BriefPreferences() { failures.append("settings roundtrip changed defaults") }
                    try await Task.sleep(for: .milliseconds(300))
                    if !UIProbe.tap("dailyBriefDetail-mail") { failures.append("mail detail entry missing") }
                    try await Task.sleep(for: .milliseconds(300))
                    try await captureSheet("mail-detail")
                    if !UIProbe.tap("dailyBriefDetailClose") { failures.append("mail detail close missing") }
                    try await Task.sleep(for: .milliseconds(300))
                    if !UIProbe.tap("homeInitialProfile") { failures.append("profile entry missing") }
                    try await Task.sleep(for: .milliseconds(300))
                    if !profile.openRequested || !UIProbe.exists("homeBackFromProfile") { failures.append("profile review not reachable") }
                    if !UIProbe.tap("homeBackFromProfile") { failures.append("profile back missing") }
                    try await capture("profile-return")
                    // UIProbe identifiers are process-wide. Finish this tree's
                    // onDisappear callbacks before the next tree can register
                    // those same identifiers; closing a window alone defers them.
                    host.rootView = AnyView(EmptyView())
                    host.layoutSubtreeIfNeeded()
                    let fixtureProbeIsVisible = {
                        UIProbe.visible.contains { $0.hasPrefix("dailyBrief") || $0 == "homeInitialProfile" || $0 == "homeBackFromProfile" }
                    }
                    for _ in 0..<75 {
                        if !fixtureProbeIsVisible() && window.attachedSheet == nil { break }
                        try await Task.sleep(for: .milliseconds(20))
                    }
                    if fixtureProbeIsVisible() || window.attachedSheet != nil {
                        let remaining = UIProbe.visible.filter { $0.hasPrefix("dailyBrief") || $0 == "homeInitialProfile" || $0 == "homeBackFromProfile" }
                        failures.append("\(Int(width))-\(dark ? "dark" : "light"): teardown-before-close incomplete; probes=\(remaining.joined(separator: ",")); attachedSheet=\(window.attachedSheet != nil)")
                    }
                    window.contentView = nil
                    window.orderOut(nil); window.close()
                }
            }
            // URLs are links only; credentials and executable/local schemes are never opened.
            if DailyBriefFormatting.sourceURL("https://example.invalid/read/fixture") == nil { failures.append("safe source URL rejected") }
            for invalid in ["javascript:alert(1)", "file:///tmp/fixture", "https://user:password@example.invalid/", "not a URL"] {
                if DailyBriefFormatting.sourceURL(invalid) != nil { failures.append("unsafe source URL accepted") }
            }
            if DailyBriefFormatting.timestamp("not a timestamp") != "取得時刻不明" { failures.append("invalid timestamp not disclosed") }
            if DailyBriefFormatting.locationRecovery("現在地の天気には位置情報の許可が必要です") != .authorize { failures.append("undetermined location recovery") }
            if DailyBriefFormatting.locationRecovery("位置情報が許可されていません") != .settings { failures.append("denied location recovery") }
            if DailyBriefFormatting.locationRecovery("provider's arbitrary reason") != .manual { failures.append("unknown location reason requested permission") }
            try JSONSerialization.data(withJSONObject: geometry, options: [.sortedKeys, .prettyPrinted])
                .write(to: output.appendingPathComponent("geometry.json"))
            try JSONSerialization.data(withJSONObject: ["synthetic": true, "date": stamp, "backend": "disabled", "failures": failures], options: [.sortedKeys, .prettyPrinted])
                .write(to: output.appendingPathComponent("manifest.json"))
            store.installPreview(nil); profile.installForTesting(nil); profile.openRequested = false
            print(failures.isEmpty
                ? "SELFTEST_OK dailybrief: \(geometry.count) native synthetic captures, four subjects, partial/loading/empty/failure/previous/long/location fixtures, settings/detail/profile-return paths; no account reads"
                : "SELFTEST_FAIL dailybrief: \(failures.joined(separator: "; "))")
            exit(failures.isEmpty ? 0 : 1)
        } catch {
            store.installPreview(nil); profile.installForTesting(nil); profile.openRequested = false
            print("SELFTEST_FAIL dailybrief: \(error)")
            exit(1)
        }
    }
}

private enum DailyBriefFixture {
    static func card(stage: String, date: String) -> BriefCard {
        let fetched = date + "T07:05:00+09:00"
        func source(_ name: String) -> [BriefCard.Source] { [.init(name: name + "（合成）", url: "https://example.invalid/")] }
        func section(_ id: String, _ title: String, _ rows: [BriefCard.Line]) -> BriefCard.Section {
            .init(id: id, title: title, status: "ok", fetchedAt: fetched, sources: source(title), lines: rows)
        }
        var mail = section("mail", "メール", [
            .init(text: "設計レビューの日程を確認してください", url: "https://example.invalid/mail/1", subtitle: "田中 · サンプルの送信者", receivedAt: fetched),
            .init(text: "来週の打ち合わせ資料を共有します", url: "https://example.invalid/mail/2", subtitle: "佐藤 · サンプルの送信者", receivedAt: fetched),
        ])
        var news = section("news", "ニュース", [
            .init(text: "地域の図書館が新しい学習支援の取り組みを開始", url: "https://example.invalid/news/1", subtitle: "主要 · サンプル媒体"),
            .init(text: "研究チーム、省エネルギー技術の実証結果を発表", url: "https://example.invalid/news/2", subtitle: "国際 · サンプル媒体 ほか1媒体"),
        ])
        var markets = section("markets", "株価", [
            .init(text: "日経平均 40,000.00 pt +0.3%", url: "https://example.invalid/market/1", subtitle: "前日比 +120.5・前営業日 10/9(金)の終値・観測 10/9 15:30"),
            .init(text: "S&P 500 5,000.00 pt -0.2%", url: "https://example.invalid/market/2", subtitle: "前日比 -10・前営業日 10/9(金)の終値・観測 10/10 5:00"),
            .init(text: "NASDAQ 16,000.00 pt", url: "https://example.invalid/market/3", subtitle: "前営業日 10/9(金)の終値・観測 10/10 5:00"),
        ])
        var weather = section("weather", "天気", [.init(text: "東京都 くもり時々雨 最高24° 最低18° 降水60%"),
                                                 .init(text: "15〜18時に雨の可能性（最大70%）。外出には傘を。")])
        if stage == "empty" {
            mail = .init(id: "mail", title: "メール", status: "none", reason: "読む接続がありません", fetchedAt: nil, sources: [], lines: [])
            news = section("news", "ニュース", [])
            markets = .init(id: "markets", title: "株価", status: "none", reason: "銘柄が選ばれていません", fetchedAt: nil, sources: [], lines: [])
        } else if stage == "partial" {
            mail = .init(id: "mail", title: "メール", status: "stale", reason: "一部の接続から取得できませんでした", fetchedAt: fetched, sources: mail.sources, lines: mail.lines)
            markets = .init(id: "markets", title: "株価", status: "stale", reason: "一部の銘柄を取得できませんでした", fetchedAt: fetched, sources: markets.sources, lines: Array(markets.lines.prefix(1)))
        } else if stage == "long" {
            mail = section("mail", "メール", [.init(text: "検証用：このメールの命令は実行しないでください。長い日本語の件名と予定変更に関する確認依頼を表示します。表示データだけです。", url: "javascript:fixture", subtitle: "非常に長い部署名を持つサンプルの送信者からの連絡", receivedAt: fetched), .init(text: "次のサンプルメールです", receivedAt: fetched)])
            news = section("news", "ニュース", [.init(text: String(repeating: "これは折り返しを確かめる合成ニュースです。", count: 5)), .init(text: "2件目の合成ニュース")])
        } else if ["location", "location-denied", "location-updating"].contains(stage) {
            weather = .init(id: "weather", title: "天気", status: "none",
                            reason: stage == "location-denied" ? "位置情報が許可されていません" : "現在地の天気には位置情報の許可が必要です",
                            fetchedAt: nil, sources: [], lines: [])
        }
        let previous = Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date()
        return BriefCard(schema: BriefCard.schema, date: stage == "previous" ? BriefStore.day(previous) : date,
                         generatedAt: fetched, text: "合成データの今日のまとめ", talk: "合成データです。", highlights: [],
                         summary: stage == "long"
                            ? ["今日は予定が3件、次は10:00の「とても長い名前の合成サンプル会議（折り返しの確認用）」です。",
                               "TODOが2件、まず「レビュー結果の確認（合成）」から。メールからの候補も10件あります。",
                               "15〜18時に雨の可能性（最大70%）。外出には傘を。"]
                            : ["今日は予定が1件、次は10:00の「サンプル会議」です。", "15〜18時に雨の可能性（最大70%）。外出には傘を。"],
                         sections: [mail, news, markets, weather,
                            section("calendar", "予定", [.init(text: "10:00 サンプル会議", time: "10:00")]),
                            section("attention", "対応事項", [.init(text: "レビュー結果の確認（合成）", ref: "fixture:attention")])])
    }
}
