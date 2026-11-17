import AppKit
import SwiftUI

/// `--selftest sysshots <outDir> [dark]`: 設定窓と「更新」の面を、RC に描かせて撮る。
///
/// UI Atlas の 6 群（System）のうち、Main / Dock の外にある面はここで撮る:
///   settings-permissions   ⌘, の設定窓（OS 許可の現状と ⌥Space）
///   update-unavailable     「更新を確認…」を確かめられない実行体で出す alert（Genie 自身の面）
///   update-available       Sparkle の「新しい版があります」（`ASTRA_SELFTEST_FEED_URL` の appcast。http か https。
///                          file:// は Sparkle が拒む。capture-rc.sh が 127.0.0.1 で配る）
///
/// Sparkle の面は、配布先と公開鍵の入った .app でだけ撮れる。無い実行体では SKIP と言う
/// （黙って通さない。撮れなかった面は Atlas で CAPTURE_MISSING になる）。
/// 「最新です」は撮らない: 同じプロセスで 2 度目の確認を Sparkle が黙って捨てるので、
/// 撮れるのは 1 セッション 1 面まで（実測。file:// のときは誤りの alert を「最新です」として撮っていた）。
extension SelfTest {
    @MainActor
    static func sysShots(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-sysshots"
        let dark = args.count > i + 3 && args[i + 3] == "dark"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        // 前面のアプリとして描く。シェルから直に起こすと非活性のまま（traffic light が灰、既定ボタンが白）で撮れた（実測）。
        NSApp.activate(ignoringOtherApps: true)

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        typealias Win = (id: CGWindowID, w: CGFloat, h: CGFloat)
        func windows() -> [Win] {
            guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
            return infos.compactMap { info in
                guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                      let num = info[kCGWindowNumber as String] as? CGWindowID,
                      let b = info[kCGWindowBounds as String] as? [String: Any],
                      let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat,
                      w > 20, h > 10 else { return nil }
                return (num, w, h)
            }
        }
        var report: [String] = []
        var failures: [String] = []
        var skipped: [String] = []
        var notes: [String] = []

        /// いま出ている窓を書く。どの窓を撮ったかは寸法で言う（絵と付き合わせられるように）。
        func write(_ name: String, _ win: Win) -> Bool {
            guard let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, win.id, [.boundsIgnoreFraming, .bestResolution]),
                  let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { return false }
            try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
            report.append("\(name) \(Int(win.w))x\(Int(win.h))")
            return true
        }
        /// 条件に合う窓が出るまで待って撮る（modal でない面）。
        @discardableResult
        /// `dwell`: 窓が出てから撮るまでの間。Sparkle の更新窓は release notes を WebView が後から読むので、
        /// 既定の 0.6 秒では回転する indicator のまま撮れた（実測。Atlas に spinner が載った）。
        func shoot(_ name: String, timeout: Double = 8, dwell: Double = 0.6, _ match: (Win) -> Bool) -> Bool {
            let deadline = Date().addingTimeInterval(timeout)
            var found: Win?
            repeat { settle(0.25); found = windows().first(where: match) } while found == nil && Date() < deadline
            settle(dwell)
            // 待っている間に窓が作り直されることがある（Sparkle は notes を読み終えると窓を差し替える。
            // 古い id で撮ると nil = 「撮影不可 窓一覧 [619x402]」）。撮る直前に取り直す。
            found = windows().first(where: match) ?? found
            guard let w = found, write(name, w) else {
                failures.append("\(name)=撮影不可 窓一覧 \(windows().map { "\(Int($0.w))x\(Int($0.h))" })")
                return false
            }
            return true
        }
        /// modal な面（`NSAlert.runModal`）は modal の中から撮る。timer を common modes に入れると
        /// modal の run loop でも動く。撮れたら modal を終える（残すと検査が止まる）。
        /// 面が出た直後は描画が終わっていないことがあるので、3 回続けて見えてから撮る。
        func armShot(_ name: String, timeout: Double, _ match: @escaping (Win) -> Bool) {
            let deadline = Date().addingTimeInterval(timeout)
            var seen = 0
            let t = Timer(timeInterval: 0.2, repeats: true) { timer in
                MainActor.assumeIsolated {
                    if let w = windows().first(where: match) {
                        seen += 1
                        guard seen >= 3 else { return }
                        _ = write(name, w)
                        timer.invalidate()
                        if NSApp.modalWindow != nil { NSApp.abortModal() }
                    } else if Date() > deadline {
                        timer.invalidate()
                        failures.append("\(name)=窓が出なかった 窓一覧 \(windows().map { "\(Int($0.w))x\(Int($0.h))" })")
                        if NSApp.modalWindow != nil { NSApp.abortModal() }
                    }
                }
            }
            RunLoop.main.add(t, forMode: .common)
        }
        func isAlertSized(_ w: Win) -> Bool { w.w >= 220 && w.w <= 720 && w.h >= 90 && w.h <= 440 }

        // 1 設定（許可と ⌥Space）。許可の現状はこの Mac のものだが、「許可…」の在る姿を残すため
        //   予定と ⌥Space は未確認にしておく（検査用の上書き。本番では nil）。
        Permissions.simulatedCalendar = .notDetermined
        Permissions.simulatedInputMonitoring = .notDetermined
        SettingsWindowController.shared.show(pane: .permissions)
        shoot("settings-permissions") { $0.w >= 440 && $0.w <= 480 && $0.h >= 380 && $0.h <= 600 }
        NSApp.windows.first { $0.title == "Genie 設定" }?.orderOut(nil)
        Permissions.simulatedCalendar = nil
        Permissions.simulatedInputMonitoring = nil
        settle(0.5)

        // 3 Sparkle の 2 面。差し替えた appcast を**本物の Sparkle** に読ませ、その窓を撮る。
        let env = ProcessInfo.processInfo.environment
        if let feed = env["ASTRA_SELFTEST_FEED_URL"], !feed.isEmpty, SoftwareUpdate.shared.startIfConfigured() {
            SoftwareUpdate.shared.setSelfTestFeed(feed)
            // 起動後の 1 回目の確認は Sparkle が窓を出さずに終える（実測: 2〜6 秒待っても同じ。2 回目は出る）。
            // 1 回目を捨て、Sparkle が確認を受け付ける状態に戻るまで待ってから本番の確認を頼む。
            let t0 = Date()
            SoftwareUpdate.shared.checkNow()
            settle(1.0)
            while !SoftwareUpdate.shared.canCheckForUpdates, Date().timeIntervalSince(t0) < 40 { settle(0.25) }
            notes.append("sparkle-warmup \(Int(Date().timeIntervalSince(t0) * 1000))ms canCheck=\(SoftwareUpdate.shared.canCheckForUpdates)")
            SoftwareUpdate.shared.checkNow()
            // 「新しい版があります」: Sparkle の窓（modal ではない）。alert より大きい。
            // Sparkle の窓は alert より大きいが、失敗したときは alert（260 幅）が出る。どちらも撮って絵で言う。
            shoot("update-available", timeout: 25, dwell: 3.0) { $0.w >= 220 && $0.w < 900 && $0.h >= 90 }
            // 「あとで」に相当する閉じ方（performClose → Sparkle が remind-later として片付ける）。
            // close() では窓が残り、次の確認が始まらなかった（実測: 同じ窓をもう一度撮っていた）。
            for w in NSApp.windows where w.isVisible && w.title != "Genie 設定" && w.frame.width >= 220 && w.frame.width < 900 {
                w.performClose(nil)
            }
            let t1 = Date()
            while !SoftwareUpdate.shared.canCheckForUpdates, Date().timeIntervalSince(t1) < 15 { settle(0.25) }
        } else {
            skipped.append("update-available: 配布先と公開鍵の入った .app と ASTRA_SELFTEST_FEED_URL（http）が要る")
        }

        // 4 更新を確かめられない。Genie 自身の alert。理由は実行体の事実（揃っていれば「確認が起動していない」）。
        let reason = SoftwareUpdate.misconfiguration() ?? "更新の確認が起動していません"
        armShot("update-unavailable", timeout: 6, isAlertSized)
        StatusBarController.presentUpdateUnavailable(reason: reason)
        settle(0.6)

        print("SYSSHOTS_DIR \(outDir)")
        // `open -W` からは stdout が読めないので、結果をファイルにも残す（0 枚だった run の理由が分からなかった）。
        try? (["SYSSHOTS_DIR \(outDir)"] + report.map { "SYSSHOT \($0)" } + notes.map { "SYSSHOT_NOTE \($0)" }
              + skipped.map { "SYSSHOT_SKIP \($0)" } + failures.map { "SYSSHOT_FAIL \($0)" })
            .joined(separator: "\n").write(toFile: "\(outDir)/sysshots-report.txt", atomically: true, encoding: .utf8)
        for line in report { print("SYSSHOT \(line)") }
        for n in notes { print("SYSSHOT_NOTE \(n)") }
        for s in skipped { print("SYSSHOT_SKIP \(s)") }
        if failures.isEmpty {
            print("SELFTEST_OK sysshots: \(report.count) 面を RC に描かせて撮影"
                  + (skipped.isEmpty ? "" : "（\(skipped.count) 組は撮れない実行体）"))
            exit(0)
        } else {
            print("SELFTEST_FAIL sysshots: \(failures.joined(separator: ", "))")
            exit(2)
        }
    }
}
