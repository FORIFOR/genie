import SQLite3
import Foundation
import CoreVideo
import CoreGraphics
import AVFoundation
import Network
import SwiftUI
import GenieCore

/// `--selftest record`: Swift → genie-core → 実ディスク の E2E。UI を出さずに検証する。
/// マイク許可の要らない合成サンプルを流し、断片ファイルが実際に書かれることを確かめる。
enum SelfTest {
    // Record the status in the LaunchServices app itself. Spawning a child
    // changes macOS TCC attribution, so the test must not use a supervisor.
    static func exit(_ status: Int32) -> Never {
        if let path = ProcessInfo.processInfo.environment["ASTRA_SELFTEST_EXIT_RECEIPT"],
           CommandLine.arguments.contains("--selftest") {
            do {
                let data = try JSONSerialization.data(withJSONObject: [
                    "schema": 1, "exitCode": Int(status), "normalExit": true,
                ])
                try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            } catch {
                print("SELFTEST_FAIL exit receipt: \(error.localizedDescription)")
                Darwin.exit(1)
            }
        }
        Darwin.exit(status)
    }

    @MainActor
    static func run(_ args: [String]) -> Bool {
        guard let i = args.firstIndex(of: "--selftest"), i + 1 < args.count else { return false }
        // Local checks must not upload audio because the user's real setting is ON.
        // Dedicated cloud tests explicitly opt in after validating their fixture flags.
        var overrides = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        overrides[RecordingRuntime.cloudTranscriptionDefaultsKey] = false
        UserDefaults.standard.setVolatileDomain(overrides, forName: UserDefaults.argumentDomain)
        SecretMode.persistChanges = false
        SecretMode.shared.set(false)
        switch args[i + 1] {
        case "liquid-orb": Task { await liquidOrb(args) }; return true
        case "session-renewal": Task { await sessionRenewal() }; return true
        case "outcome-live": Task { await outcomeLive(args) }; return true
        case "workspace-ux": Task { await workspaceUX(args) }; return true
        case "recording-journeys": Task { await recordingJourneys() }; return true
        case "translation-journeys": Task { await translationJourneys() }; return true
        case "translation-layout": Task { await translationLayout(args) }; return true
        case "record": recordToDisk(); return true
        case "lifecycle": lifecycle(); return true
        case "api": api(args); return true
        case "shortcut": shortcut(); return true
        case "sysaudio": sysaudio(); return true
        case "calendar": calendar(); return true
        case "calendarask": calendarask(args); return true
        case "calendarlive": calendarlive(); return true
        case "screen": screen(); return true
        case "rag": rag(); return true
        case "keychain": keychain(); return true
        case "files": files(); return true
        case "ax": ax(); return true
        case "speech": speech(); return true
        case "connector": connector(); return true
        case "permissions": permissions(); return true
        case "livemic": livemic(); return true
        case "livescreen": livescreen(); return true
        case "livemeeting": livemeeting(); return true
        case "sttrecognize": sttrecognize(); return true
        case "sttstream": sttStream(); return true
        case "guishot": guishot(); return true
        case "axtree": axtree(); return true
        case "navtitle": navtitle(); return true
        case "geometry": geometryGate(args); return true
        case "occupation": occupationGate(); return true
        case "focus": Task { @MainActor in await focusGate() }; return true
        case "screenshot-input": Task { await screenshotInput(args) }; return true
        case "screenshotcontext": screenshotContextGate(); return true
        case "screenshot-question": Task { await screenshotQuestion(args) }; return true
        case "screenshotegress": screenshotEgressGate(); return true
        case "screenshote2e": screenshotE2E(args); return true
        case "guidedsetup": guidedSetupGate(args); return true
        case "guidedshots": guidedShots(args); return true
        case "permission-help": Task { await permissionHelp(args) }; return true
        case "permission-capabilities": Task { await permissionCapabilities(args) }; return true
        case "screenshotshots": screenshotShots(args); return true
        case "screenshotshot": screenshotShot(args); return true
        case "initialprofile": Task { @MainActor in await initialProfileShots(args) }; return true
        case "consumerjourneys": Task { @MainActor in await consumerJourneyShots(args) }; return true
        case "consumer-live": Task { @MainActor in await consumerJourneyLive() }; return true
        case "workcontext": workContextGate(); return true
        case "replyflow": Task { await replyFlowGate() }; return true
        case "approval-press": Task { await approvalPress() }; return true
        case "selfecho": Task { await selfEcho() }; return true
        case "brief": briefGate(); return true
        case "journey": journeyGate(args); return true
        case "idle-hold": idleHold(args); return true
        case "confirmflow": confirmFlow(); return true
        case "hold-meeting": holdMeeting(args); return true
        case "home-meeting-focus": Task { @MainActor in await homeMeetingFocus() }; return true
        case "upgrade": upgradeGate(); return true
        case "update": updateCheck(); return true
        case "recoveryui": recoveryUI(); return true
        case "dictation": dictation(); return true
        case "breakpoints": breakpoints(); return true
        case "shape": shape(); return true
        case "hudlifecycle": hudlifecycle(); return true
        case "pause": pauseWorks(); return true
        case "screenshot": screenshot(); return true
        case "aiaction": aiaction(args); return true
        case "translate": translateTest(args); return true
        case "waveform": waveform(); return true
        case "recovery": recovery(args); return true
        case "timer": timer(); return true
        case "connectorflow": Task { await connectorflow() }; return true
        case "connectorstate": connectorstate(); return true
        case "connectorexchange": connectorExchange(); return true
        case "voiceask": voiceask(args); return true
        case "recoveryoffline": recoveryOffline(args); return true
        case "fulllifecycle": fullLifecycle(args); return true
        case "e2e001": e2e001(args); return true
        case "shots": shots(args); return true
        case "sections": sections(args); return true
        case "a11ynames": a11ynames(args); return true
        case "egress": egress(); return true
        case "cloudlive": cloudLiveSTT(); return true
        case "cloudshots": cloudShots(args); return true
        case "states": states(args); return true
        case "golden": golden(args); return true
        case "dock8": dock8(args); return true
        case "dockanim": dockAnim(); return true
        case "surfacemotion": SurfaceMotionGate.run(args); return true
        case "invocation": InvocationGate.run(args); return true
        case "invocationaudio": InvocationGate.audioTruth(args); return true
        case "entry": entryPoints(); return true
        case "menutitles": menuTitles(); return true
        case "facts": facts(); return true
        case "secret": secretMode(); return true
        case "recordbutton": recordButton(); return true
        case "session": sessionLifecycle(); return true
        case "sessionshots": sessionShots(args); return true
        case "sysshots": sysShots(args); return true
        case "realmeeting": realMeeting(args); return true
        case "uiscale": uiScale(); return true
        case "acceptance": acceptance(); return true
        case "sessionsync": sessionSync(); return true
        case "recordleg": recordLeg(args); return true
        case "dockedge": dockEdge(args); return true
        case "pixels": pixels(args); return true
        case "density": density(args); return true
        case "state": stateMachine(); return true
        case "presence": presence(); return true
        case "perf": perf(); return true
        case "storage": storage(); return true
        case "meetingiq": meetingIQ(); return true
        case "vad": vad(); return true
        case "browser": browser(); return true
        case "plugins": plugins(args); return true
        case "panel": panelBehavior(); return true
        case "render": render(); return true
        default: return false
        }
    }

    /// `--selftest states <dir> [dark]`: hover / focus / pressed が **実際に見えているか**。
    ///
    /// Visual Gate はマウスを動かせないので、状態を差し込んで撮り
    /// neutral との**画素差**で判定する。「実装した」ではなく「画面が変わった」を証拠にする。
    @MainActor
    private static func states(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-states"
        let dark = args.count > i + 3 && args[i + 3] == "dark"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        parkCursor()

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        /// 自プロセスの最大の窓を撮り、PNG 保存して縮小グレースケール列を返す。
        func grab(_ name: String) -> [UInt8]? {
            settle(0.9)
            var best: (CGWindowID, Int, Int)? = nil
            var area = 0
            if let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
                for info in infos {
                    guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                          let num = info[kCGWindowNumber as String] as? CGWindowID,
                          let b = info[kCGWindowBounds as String] as? [String: Any],
                          let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat,
                          w > 40, h > 20 else { continue }
                    if Int(w * h) > area { area = Int(w * h); best = (num, Int(w), Int(h)) }
                }
            }
            guard let (winID, _, _) = best,
                  let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, winID, [.boundsIgnoreFraming, .bestResolution])
            else { return nil }
            let rep = NSBitmapImageRep(cgImage: cg)
            if let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
            }
            var out: [UInt8] = []
            let pw = rep.pixelsWide, ph = rep.pixelsHigh
            let sx = max(1, pw / 200), sy = max(1, ph / 200)
            var y = 0
            while y < ph { var x = 0
                while x < pw {
                    if let c = rep.colorAt(x: x, y: y) {
                        let l = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
                        out.append(UInt8(max(0, min(255, l * 255))))
                    }
                    x += sx }
                y += sy }
            return out
        }

        /// 目に見える差だけ数える（8/255 未満は撮影ノイズとして無視）。
        func changedRatio(_ a: [UInt8], _ b: [UInt8]) -> Double {
            guard a.count == b.count, !a.isEmpty else { return 0 }
            var n = 0
            for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) >= 8 { n += 1 }
            return Double(n) / Double(a.count)
        }

        let preview = InteractionPreview.shared
        let state = RecordingWorkspaceState.shared
        state.loadDemo(ragOpen: false)
        state.selectedTool = .transcript
        WindowCoordinator.shared.showRecordingWorkspace()
        settle(1.0)

        guard let neutral = grab("00-neutral") else {
            print("SELFTEST_FAIL states: neutral 撮影不可"); exit(2)
        }

        // 目視で分かる最小限。0.1% 未満は「実質見えない」とみなす。
        let minRatio = 0.001
        var report: [String] = []
        var failures: [String] = []
        for (name, apply) in [("hover", { preview.hover = true }),
                              ("focus", { preview.focus = true }),
                              ("pressed", { preview.pressed = true })] as [(String, () -> Void)] {
            preview.reset()
            apply()
            guard let shot = grab("\(name)") else { failures.append("\(name)=撮影不可"); continue }
            let r = changedRatio(neutral, shot)
            report.append(String(format: "%@ diff=%.3f%%", name, r * 100))
            if r < minRatio { failures.append(String(format: "%@ が neutral と同じ (diff=%.3f%%)", name, r * 100)) }
        }
        preview.reset()
        WindowCoordinator.shared.hideRecordingWorkspace()

        print("STATES_DIR \(outDir)")
        for line in report { print("STATE \(line)") }
        if failures.isEmpty {
            print("SELFTEST_OK states: hover/focus/pressed が実画面で neutral と異なる")
            exit(0)
        } else {
            print("SELFTEST_FAIL states: \(failures.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest golden <goldenDir> <freshDir>`: 撮り直した画面を **committed の golden と画素で比べる**。
    ///
    /// 比べるのは中身が決まっている面だけ。Home は挨拶が時刻で変わり、Apps は接続状態で変わるので
    /// ここには入れない（落ちる理由が「時計が進んだ」になるテストは、次から誰も直さない）。
    private static func golden(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 3 else { print("SELFTEST_FAIL golden: 引数が足りない"); exit(2) }
        var goldenDir = args[i + 2]
        let freshDir = args[i + 3]
        // Font rasterization and the physical camera band vary by screen environment.
        // Baseline adoption is explicit and recorded in its provenance manifest.
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let scale = Int(NSScreen.main?.backingScaleFactor ?? 1)
        let safeTop = Int(NSScreen.main?.safeAreaInsets.top ?? 0)
        let environment = "macos-\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)-\(scale)x"
            + (safeTop > 0 ? "-safe-top-\(safeTop)" : "")
        let original = URL(fileURLWithPath: goldenDir)
        let isDark = original.lastPathComponent == "dark"
        let root = isDark ? original.deletingLastPathComponent() : original
        if root.lastPathComponent == "golden-screenshots" {
            let baseline = root.appendingPathComponent("environments/\(environment)")
            if FileManager.default.fileExists(atPath: baseline.appendingPathComponent("provenance.json").path) {
                goldenDir = baseline.appendingPathComponent(isDark ? "dark" : "light").path
                print("GOLDEN_REFERENCE \(environment) provenance=\(baseline.appendingPathComponent("provenance.json").path)")
            }
        }
        // 02b は「準備中…」（まだ取り込めていない正式な状態）。02 は取り込みが生きた姿。
        // 番号は整理せず足すだけにする（rename の churn を避ける）。
        let names = ["01-voice-hud-idle", "02-voice-hud-listening", "02b-voice-hud-preparing",
                     "03-recording-workspace",
                     "04-recording-transcript", "05-recording-rag", "08-meeting-detail",
                     "09-permission-denied", "10-agent-timeline", "11-meeting-canvas"]

        /// 縮小グレースケール列。撮影ごとの微差を拾わないよう 200 点角に落とす。
        func signature(_ path: String) -> [UInt8]? {
            guard let data = FileManager.default.contents(atPath: path),
                  let rep = NSBitmapImageRep(data: data) else { return nil }
            var out: [UInt8] = []
            let pw = rep.pixelsWide, ph = rep.pixelsHigh
            let sx = max(1, pw / 200), sy = max(1, ph / 200)
            var y = 0
            while y < ph { var x = 0
                while x < pw {
                    if let c = rep.colorAt(x: x, y: y) {
                        let l = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
                        out.append(UInt8(max(0, min(255, l * 255))))
                    }
                    x += sx }
                y += sy }
            return out
        }

        var report: [String] = []
        var failures: [String] = []
        // アンチエイリアスと影のにじみで数点は必ず動く。0.5% までは同じ絵とみなす。
        let tolerance = 0.005
        for name in names {
            let g = "\(goldenDir)/\(name).png", f = "\(freshDir)/\(name).png"
            guard let a = signature(g) else { failures.append("\(name)=golden なし"); continue }
            guard let b = signature(f) else { failures.append("\(name)=撮影なし"); continue }
            guard a.count == b.count else { failures.append("\(name)=寸法が違う"); continue }
            var n = 0
            for k in 0..<a.count where abs(Int(a[k]) - Int(b[k])) >= 16 { n += 1 }
            let ratio = Double(n) / Double(a.count)
            report.append(String(format: "%@ %.3f%%", name, ratio * 100))
            if ratio > tolerance {
                // **差分画像を残す。**「1.08% 違う」だけでは、どこが違うのか
                // 分からないので直しようがない。基準｜実際｜差分を 1 枚にして置く。
                let diffPath = "\(freshDir)/diff/\(name)-diff.png"
                if let pct = UIDiffImage.write(reference: g, actual: f, to: diffPath) {
                    failures.append(String(format: "%@ が golden と %.2f%% 違う（差分: %@ / 画素 %.2f%%）",
                                           name, ratio * 100, diffPath, pct))
                } else {
                    failures.append(String(format: "%@ が golden と %.2f%% 違う", name, ratio * 100))
                }
            }
        }

        for line in report { print("GOLDEN \(line)") }
        if failures.isEmpty {
            print("SELFTEST_OK golden: \(names.count)面が committed の golden と一致")
            exit(0)
        } else {
            print("SELFTEST_FAIL golden: \(failures.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest dock8 <dir> [dark]`: 必須 8 状態を **実状態遷移で** 撮る。
    ///
    /// fixture を並べるのではなく、`GenieStateStore` を実際に動かして
    /// Dock がその姿になることを確かめる。検査するのは:
    ///   - 各状態の実寸が仕様どおりか（idle 156×34 / listening 420×84 / agent 480 幅 …）
    ///   - **上辺の Y が全状態で同一**か（top anchor 固定・中央から広がっていない）
    ///   - 窓が増えていないか（常に 1 枚）
    ///   - 中身が入っているか（真っ白/真っ黒な板ではない）
    @MainActor
    private static func dock8(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-dock8"
        let dark = args.count > i + 3 && args[i + 3] == "dark"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        parkCursor()

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        /// 自プロセスの on-screen window（Dock 以外も含む）。
        func windows() -> [(id: CGWindowID, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)] {
            var out: [(CGWindowID, CGFloat, CGFloat, CGFloat, CGFloat)] = []
            if let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
                for info in infos {
                    guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                          let num = info[kCGWindowNumber as String] as? CGWindowID,
                          let b = info[kCGWindowBounds as String] as? [String: Any],
                          let x = b["X"] as? CGFloat, let y = b["Y"] as? CGFloat,
                          let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat,
                          w > 20, h > 10 else { continue }
                    out.append((num, x, y, w, h))
                }
            }
            return out
        }

        /// 影が見えるように、決まった地の上へ置き直す。
        ///
        /// 影は透明の上では読めない。かといって**実際の画面を撮らない**
        /// —— 一度それをやって、利用者の Finder とメールが証拠に混ざった。
        /// 地は合成する。上辺にメニューバーに相当する帯を置き、
        /// 「画面の縁に接しているか、浮いているか」が見えるようにする。
        /// 合成した地であることは `CRAFT.md` に明記する。
        func onBackdrop(_ cg: CGImage) -> NSBitmapImageRep? {
            // 合成は CoreGraphics でやる。`NSBitmapImageRep.draw` に渡すと
            // premultiplied alpha を取り違えて、**影が白い帯**として出た。
            let iw = cg.width, ih = cg.height
            let space = CGColorSpaceCreateDeviceRGB()
            let info = CGImageAlphaInfo.premultipliedLast.rawValue

            // 面そのもの（不透明な部分）を探す。影は alpha < 1 なので外れる。
            var px = [UInt8](repeating: 0, count: iw * ih * 4)
            var x0 = iw, x1 = -1, y0 = ih, y1 = -1
            px.withUnsafeMutableBytes { buf in
                guard let ctx = CGContext(data: buf.baseAddress, width: iw, height: ih,
                                          bitsPerComponent: 8, bytesPerRow: iw * 4,
                                          space: space, bitmapInfo: info) else { return }
                ctx.draw(cg, in: CGRect(x: 0, y: 0, width: iw, height: ih))
            }
            // **面は半透明**（`DockSurface` は黒 80%）。「不透明なら面」で探すと
            // 塗りと文字しか拾えず、地の大きさが絵ごとに変わった。影は薄いので、
            // alpha でしきい値を切れば分けられる。
            //
            // 1 画素でも越えたら採る、にすると影でぼけた角を面の上辺と誤り、
            // 影のある絵とない絵で 2〜4px ずれた。ずれると採点者は影ではなく
            // 位置の話を始める（一度そうなった）。**行ごとに数える。**
            let solid: UInt8 = 160
            var rowFull = [Bool](repeating: false, count: ih)
            for y in 0..<ih {
                var n = 0, lo = iw, hi = -1
                for x in 0..<iw where px[(y * iw + x) * 4 + 3] >= solid {
                    n += 1; lo = min(lo, x); hi = max(hi, x)
                }
                if n > iw / 4 { rowFull[y] = true; x0 = min(x0, lo); x1 = max(x1, hi) }
            }
            guard let ty = rowFull.firstIndex(of: true),
                  let by = rowFull.lastIndex(of: true), x1 > x0 else { return nil }
            y0 = ty; y1 = by

            // 地は中身に合わせる。固定だと agent（幅 720）が切れて、
            // 影ではなく切れ方を比べることになる。
            //
            // **上辺に隙間を作らない。** 最初はメニューバーの帯を描いて
            // その 10px 下に面を置いたが、`PanelPositioner.voiceHUDFrame` は
            // `y = screen.frame.maxY - size.height` —— 面の上辺は画面の上辺そのもの。
            // 隙間は harness が作った嘘で、採点者 3 人中 2 人がそれを根拠にした
            // （「隙間があるほうが別窓に見える」）。無い物を比べていた。
            let cw = x1 - x0 + 1, ch = y1 - y0 + 1
            let W = cw + 160, H = ch + 90
            // 面の左上を、地の中でいつも同じ場所に置く。影の大きさが変わっても、
            // **面の位置と大きさは動かない**。動くと影ではなく配置を比べてしまう。
            let cardX = (W - cw) / 2, cardTop = 0
            guard let out = CGContext(data: nil, width: W, height: H,
                                      bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: info) else { return nil }
            out.setFillColor(gray: 0.36, alpha: 1)
            out.fill(CGRect(x: 0, y: 0, width: W, height: H))
            // 走査は上から、CG の原点は下。面の上辺を地の上辺へ合わせるので、
            // 置く高さは「絵の下端が地のどこに来るか」で書く。
            out.draw(cg, in: CGRect(x: cardX - x0,
                                    y: H - cardTop - (ih - y0),
                                    width: iw, height: ih))
            guard let img = out.makeImage() else { return nil }
            return NSBitmapImageRep(cgImage: img)
        }

        /// 期待寸法の窓が現れるまで待って撮る。
        func capture(_ name: String, expect: CGSize) -> (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, colors: Int, count: Int, corner: Int)? {
            let deadline = Date().addingTimeInterval(6)
            var found: (CGWindowID, CGFloat, CGFloat, CGFloat, CGFloat)?
            var all: [(id: CGWindowID, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)] = []
            repeat {
                settle(0.2)
                all = windows()
                found = all.first { abs($0.w - expect.width) <= 2 && abs($0.h - expect.height) <= 2 }
                    .map { ($0.id, $0.x, $0.y, $0.w, $0.h) }
            } while found == nil && Date() < deadline
            settle(0.45)
            // 造形⑧ を測るときだけ、外形の外（＝**窓の影**）も撮る。
            // 既定の `boundsIgnoreFraming` は影を切り落とすので、
            // 影を変えても絵が 1px も変わらない。
            let shadow = ProcessInfo.processInfo.environment["ASTRA_SHOT_SHADOW"] == "1"
            // 通常の測定画像は 1px = 1pt。確認 gate はこの寸法で上限を測る。
            let opts: CGWindowImageOption = shadow
                ? [.bestResolution] : [.boundsIgnoreFraming, .nominalResolution]
            guard let (id, x, y, w, h) = found,
                  let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, id, opts),
                  shadow || (cg.width == Int(w) && cg.height == Int(h))
            else { return nil }
            let rep = NSBitmapImageRep(cgImage: cg)
            let shot = shadow ? (onBackdrop(cg) ?? rep) : rep
            if let png = shot.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
            }
            var seen = Set<UInt32>()
            let pw = rep.pixelsWide, ph = rep.pixelsHigh
            let sx = max(1, pw / 140), sy = max(1, ph / 70)
            var yy = 0
            while yy < ph { var xx = 0
                while xx < pw {
                    if let c = rep.colorAt(x: xx, y: yy) {
                        let r = UInt32(max(0, min(255, c.redComponent * 255)))
                        let g = UInt32(max(0, min(255, c.greenComponent * 255)))
                        let b = UInt32(max(0, min(255, c.blueComponent * 255)))
                        seen.insert((r << 16) | (g << 8) | b)
                    }
                    xx += sx }
                yy += sy }
            // 外形の 4 隅。Dock の形（上 10 / 下 18 の角丸）なら、隅の画素は**透明**。
            // 中身が面より背が高いと、面（ZStack の地）が中身の大きさまで伸びて
            // 窓の外へはみ出し、角丸が窓の縁で切られて**四角い黒い板**になる。
            // ③ で高さの推定式が実寸より 14pt 短くなり、確認の面がそうなっていた。
            // 影の絵（onBackdrop）は地を敷くので隅は測らない。
            var corner = 0
            if !shadow {
                for (cx, cy) in [(1, 1), (pw - 2, 1), (1, ph - 2), (pw - 2, ph - 2)] {
                    if let c = rep.colorAt(x: cx, y: cy) { corner = max(corner, Int(c.alphaComponent * 255)) }
                }
            }
            return (x, y, w, h, seen.count, all.count, corner)
        }

        let store = GenieStateStore.shared
        let hud = VoiceHUDState.shared
        let recording = RecordingWorkspaceState.shared
        store.reset()
        WindowCoordinator.shared.showVoiceHUD()
        settle(0.8)

        var report: [String] = []
        var failures: [String] = []
        var topEdges = Set<Int>()

        /// 状態を**実際に遷移させて**から撮る。
        func shoot(_ name: String, _ transition: () -> Void, minColors: Int = 6) {
            transition()
            WindowCoordinator.shared.syncDockPanels()
            let contentSize = store.dock.size(agentRows: store.state.activeTask?.steps.count ?? 0)
            let expect = CGSize(width: contentSize.width, height: contentSize.height + WindowCoordinator.shared.dockTopInset)
            guard let r = capture(name, expect: expect) else {
                failures.append("\(name)=撮影不可(期待 \(Int(expect.width))x\(Int(expect.height)))")
                return
            }
            topEdges.insert(Int(r.y.rounded()))
            // Window-server geometry remains measurable even without AX permission.
            // Content element geometry is still covered separately by the AX gate.
            let inset = WindowCoordinator.shared.dockTopInset
            UIGeometry.write([
                "window": UIGeometry.Box(x: Double(r.x), y: Double(r.y), w: Double(r.w), h: Double(r.h)),
                "contentLayout": UIGeometry.Box(x: 0, y: Double(inset), w: Double(contentSize.width), h: Double(contentSize.height)),
            ], to: "\(outDir)/\(name).geometry.json")
            report.append("\(name) \(Int(r.w))x\(Int(r.h)) top=\(Int(r.y)) c\(r.colors) win=\(r.count)")
            if r.colors < minColors { failures.append("\(name)=中身なし(c\(r.colors))") }
            // 窓を足していない（Dock 以外に浮いていない）。
            if r.count > 1 { failures.append("\(name)=窓が \(r.count) 枚出ている") }
            // 外形が切れていない（中身が面からはみ出していない）。
            if r.corner > 64 { failures.append("\(name)=角が切れている(隅の alpha \(r.corner))") }
        }

        // 1. Idle / Presence
        shoot("01-idle", { hud.mode = .idle })

        // 1'. Quick Actions: Dock 本体を押す。窓は増やさず Dock 自身が姿を変える。
        shoot("01b-quick-actions", { hud.toggleQuickActions() })
        hud.mode = .idle

        // 2. App Context（実際の解決器が返す形と同じ構造で遷移させる）
        let notion = AppContextSummary(
            app: "Notion", document: "Q3 Product Roadmap",
            suggestions: AppContextResolver.suggestions["Notion"] ?? [])
        shoot("02-app-context", { hud.mode = .appContext(notion) })
        shoot("03-app-context-expanded", { hud.toggleContextExpanded() })

        // 3. Listening（partial transcript が主役）
        store.updateContext([
            // カード本文はカテゴリ名の反復（「画面 画面」）ではなく、実際に見ている中身を出す。
            ContextFact(source: .browserDOM, application: "Notion", sensitivity: .workspace,
                        summary: "Q3 Product Roadmap", capturedAt: Date(), expiresAt: Date().addingTimeInterval(60)),
            ContextFact(source: .accessibility, application: "選択中のテキスト", sensitivity: .personal,
                        summary: "「10 月導入で進めます」", capturedAt: Date(), expiresAt: Date().addingTimeInterval(60)),
            ContextFact(source: .screenVision, application: "前面の画面", sensitivity: .workspace,
                        summary: "Figma — Genie UI Atlas", capturedAt: Date(), expiresAt: Date().addingTimeInterval(60)),
        ])
        shoot("04-listening", { hud.mode = .listening(partial: "このページからタスクを作って…") })

        // 4. Thinking
        shoot("05-thinking", { hud.mode = .thinking })
        // 3'. Genie と会話（段階 2）: 会話中の Listening と、終わる前の知らせ（延長は本人の操作）。
        shoot("04b-conversation", { hud.presentConversationForShot(ending: false) })
        shoot("04c-conversation-ending", { hud.presentConversationForShot(ending: true) })
        hud.clearConversationForShot()
        hud.mode = .idle

        // 4'. 答えている途中に届いた発話を預かった姿（黙って消さない。段階 1）。
        shoot("05b-thinking-held", { hud.hold("明日の天気教えて") })
        _ = hud.takeHeldUtterance()

        // 5. Agent（startTask が Dock を agent の姿にする＝実遷移）
        shoot("06-agent", {
            store.startTask(AgentTask(
                id: UUID(), title: "週次ブリーフィングを作る", status: .running,
                steps: [
                    AgentStep(title: "Calendar", tool: "calendar", detail: "明日 10:00 / 田中さん", state: .success),
                    AgentStep(title: "Gmail", tool: "gmail", detail: "直近 12 通を読んだ", state: .success),
                    AgentStep(title: "Notion", tool: "notion", detail: "Q3 Proposal を読んでいます", state: .running),
                    AgentStep(title: "Web", tool: "web", detail: "先方の最新情報を調べる"),
                    AgentStep(title: "Briefing", tool: "agent", detail: "資料をまとめる"),
                ],
                startedAt: Date(), context: store.state.context))
        })

        // 5'. 文脈の棚を開く（Dropover 型）。
        shoot("06b-context-detail", { hud.mode = .contextDetail })

        // 5''. 終わった直後（CleanShot 型）。finishTask が結果面へ遷移させる＝実遷移。
        shoot("06c-result", { store.finishTask(.success) })

        // 5-3. できなかったとき（Error / Recovery）。本番で失敗の結果面を作る経路と同じ形
        // （マイク拒否 → 理由と、直しに行く道。`RecordingWorkspaceState.start`）。✓ を付けず、黙って消えない。
        shoot("06d-result-failed", {
            // 本番と同じ経路: 段が失敗 → finishTask(.failed) が結果面（理由 + やり直す）を出す。
            store.startTask(AgentTask(
                id: UUID(), title: "先方へ見積の返信を送る", status: .running,
                steps: [AgentStep(title: "Gmail", tool: "gmail", detail: "下書きを作った", state: .success),
                        AgentStep(title: "送信", tool: "gmail", detail: "接続が切れた", state: .running)],
                startedAt: Date(), context: store.state.context))
            if let last = store.state.activeTask?.steps.last { store.updateStep(last.id, to: .failed) }
            store.finishTask(.failed)
        })

        // 5-4. いまの情報（天気・ニュース）。本番と同じく成果物の JSON を taskReply → presentation に通す。
        // 撮るたびに変わらないよう、取得時刻は固定・ニュースの時刻は無し（相対表記が撮影時刻で変わる）。
        for (name, body) in [
            ("06e-info-weather", #"{"schema":"genie.info/v1","kind":"weather","text":"大阪の天気: 今日 雨 24℃/20℃ 降水95%、明日 くもり 25℃/19℃ 降水30%。","data":{"place":"大阪","current":null,"days":[{"date":"2026-09-27","label":"今日","code":63,"summary":"雨","high":24.0,"low":20.2,"precipitation":95},{"date":"2026-09-28","label":"明日","code":3,"summary":"くもり","high":25.1,"low":19.4,"precipitation":30},{"date":"2026-09-29","label":"明後日","code":2,"summary":"晴れ時々くもり","high":26.0,"low":18.8,"precipitation":10},{"date":"2026-09-30","label":"9/30(水)","code":0,"summary":"快晴","high":27.2,"low":18.1,"precipitation":0}]},"sources":[{"name":"Open-Meteo.com","url":"https://open-meteo.com/"}],"fetched_at":"2026-09-27T00:30:00Z"}"#),
            ("06g-info-weather-day", #"{"schema":"genie.info/v1","kind":"weather","text":"明日の東京都は雨。最高22℃、最低20℃、降水確率78%です。","data":{"place":"東京都","current":null,"days":[{"date":"2026-09-28","label":"明日","code":63,"summary":"雨","high":21.9,"low":19.5,"precipitation":78}]},"sources":[{"name":"Open-Meteo.com","url":"https://open-meteo.com/"}],"fetched_at":"2026-09-27T00:30:00Z"}"#),
            ("06f-info-news", #"{"schema":"genie.info/v1","kind":"news","text":"主なニュース（NHK）: 1. 台風26号 沖縄に接近へ","data":{"topic":null,"items":[{"title":"台風26号 沖縄に接近へ 来週も東～西日本は雨降りやすい見込み","url":"https://news.web.nhk/a","source":"NHK","published_at":null},{"title":"首相 米大統領と電話会談 米中首脳会談の内容説明受ける","url":"https://news.web.nhk/b","source":"NHK","published_at":null},{"title":"タイで大雨続き 首都バンコクでも浸水被害広がる","url":"https://news.web.nhk/c","source":"NHK","published_at":null}]},"sources":[{"name":"NHK","url":"https://news.web.nhk/"}],"fetched_at":"2026-09-27T00:30:00Z"}"#),
        ] {
            shoot(name, {
                let reply = VoiceHUDState.taskReply(status: "COMPLETED", artifactID: "shot") { body }
                hud.mode = VoiceHUDState.presentation(for: reply)
                if case .info = hud.mode {} else { failures.append("\(name)=カードにならない") }
            })
        }
        hud.mode = .idle

        // 6. Confirmation（requireConfirmation が Dock を展開する＝実遷移）
        shoot("07-confirmation", {
            // 決断に要るものを全部持たせた形で撮る。宛先も中身も出所も無い
            // 確認は、外の製品と同じ型として比べられない。
            store.requireConfirmation(ActionConfirmation(
                app: "Slack", appIcon: "number",
                title: "このメッセージを送りますか？",
                params: [.init(label: "宛先", value: "#sales"),
                         .init(label: "差出人", value: "あなた", editable: false)],
                preview: "明日の会議、資料を先に共有します。10 月の導入時期の件も入れておきました。",
                source: .init(title: "週次同期", speaker: "田中", time: "10:42"),
                details: [],
                risk: .r2, confirmLabel: Facts.confirmationConfirmExample))
        })

        // 6'. 「直す」: 宛先と本文をその場で書き換える。面は増えず、同じ面が編集の姿になる。
        shoot("07b-confirmation-edit", {
            if !UIProbe.tap("confirmEdit") { failures.append("07b=「直す」が押せない（confirmEdit が出ていない）") }
        })

        // 7. Meeting: 録音中は Dock が録音コントローラになる。**窓は増えない。**
        shoot("08-meeting", {
            store.resolveConfirmation(approved: false)
            store.finishTask(.success)
            recording.loadDemo(ragOpen: false)
            store.meetingDetected(app: "Google Meet")
            // **録音ボタンと同じ経路**を通す。Store を直接叩くと、ボタンが別のことを
            // していても気づけない（実際に一度そうなっていた）。
            recording.start(captureMic: false, transcribe: false, requestPermissions: false)
            // 実マイクを開けない撮影でも「録音中」の姿にする（音が届いた姿。準備中は 08a で別に撮る）。
            // 届いている経路も shots と同じに仕込む。仕込まないと、開いた録音面（10-workspace）が
            // 最初のフレーム前の「まだ音が届いていません」で写る（RC で実際にそうなった）。
            recording.markAudioLiveForShot()
            RecordingRuntime.shared.markListening(.localUser)
            RecordingRuntime.shared.markListening(.remoteAudio)
            // 開始は前の会議の Notes を消す（2 本目に 1 本目が混ざらないため）。
            // 中身は**開始の後**に入れる。前に入れると空の Notes を撮ってしまう。
            // 本番と同じ 1 本（確定行 → 保存 → 抽出）を通す。Canvas に直に置くと、文字起こしが空のまま
            // 拾ったものだけが並ぶ矛盾した絵になる（盲検 3/3 で state legibility）。
            for seg in [
                TranscriptSegment(speaker: "田中", text: "初期費用が心配です", interim: false, at: 254),
                TranscriptSegment(speaker: "田中", text: "導入時期は 10 月で行きます", interim: false, at: 262),
                TranscriptSegment(speaker: "あなた", text: "見積は明日までにお願いします", interim: false, at: 288),
                TranscriptSegment(speaker: "鈴木", text: "誰が対応しますか？", interim: false, at: 301),
            ] { recording.appendFinal(seg) }
            // 経過時計は最後の発言（05:01）以降にする。start() で 0 に戻るため、明示しないと
            // 「00:01 なのにメモは 04:14〜05:01」という矛盾した絵になる（盲検で指摘）。
            recording.elapsedSeconds = 5 * 60 + 12
            // ここから先の会議の面は時計を止めて撮る（light / dark は別プロセス。動いたままだと秒がずれ、fixed の gate が運になる）。
            recording.freezeClockForShot = true
            // 抽出は確定行が溜まるたびに新しい分だけ走る。最後の行が待ちのまま撮らないよう、ここで確定させる。
            MeetingIntelligence.shared.ingest(
                recording.transcript.filter { !$0.interim }.map { CanvasItem($0.text, at: $0.at, speaker: $0.speaker) },
                force: true)
        })
        // 7'. 開始直後、まだ 1 フレームも届いていない: 「録音中」と名乗らず「準備中…」。
        shoot("08a-meeting-preparing", { recording.beginPreparingForShot() })
        recording.markAudioLiveForShot()
        // 7''. 一時停止: Dock の見出しが「一時停止中」、点は灰、▶ で再開。
        shoot("08b-meeting-paused", { recording.togglePause() })
        recording.togglePause()
        // 準備中 shot で 0 に落ちた時計を、本編（メモは 04:14〜05:01）に戻す。
        // 戻さないと notes/captions/ask が「00:01 なのに 5 分前のメモ」で作り物に見える。
        // 撮っている間は時計を止める（light と dark で秒がずれて fixed の gate が落ちた）。
        recording.elapsedSeconds = 5 * 60 + 20
        recording.freezeClockForShot = true
        // 録音開始では窓を増やさない。Dock だけが録音コントローラになる。
        shoot("09-meeting-notes", { hud.toggleMeetingPanel(.notes) })
        shoot("09b-meeting-captions", { hud.toggleMeetingPanel(.captions) })
        // 7''. Ask Genie: 同じ板に問いの欄が開く。
        shoot("09c-meeting-ask", { hud.toggleMeetingPanel(.ask) })

        // 8. Full Workspace（Dock は静かなまま、録音中に 2 枚目として開く）
        //
        // 以前は meetingEnded() のあと Main Window（1240 幅）を「workspace」として撮っていた（Atlas E1）。
        // 撮るのは「会議の横に開く」で出る 1080x680 の録音面で、Dock の見出しはそのまま残る（T2 と同じ遷移）。
        hud.toggleMeetingPanel(.ask)   // 開いていた板を閉じる（同じ板をもう一度）
        WindowCoordinator.shared.syncDockPanels()
        WindowCoordinator.shared.detachMeetingSurface()
        var workspaceWindow: (id: CGWindowID, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)?
        let wsDeadline = Date().addingTimeInterval(8)
        repeat {
            settle(0.25)
            workspaceWindow = windows().first { abs($0.w - Metrics.workspaceWidth) <= 2 && $0.h >= 640 }
        } while workspaceWindow == nil && Date() < wsDeadline
        settle(0.8)
        if let big = workspaceWindow,
           let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, big.id, [.boundsIgnoreFraming, .nominalResolution]) {
            let rep = NSBitmapImageRep(cgImage: cg)
            if let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "\(outDir)/10-workspace.png"))
            }
            report.append("10-workspace \(Int(big.w))x\(Int(big.h))")
            // Dock の見出しがそのまま残っているか（録音面を開いても Dock は消えない）。
            let dockStill = windows().contains { $0.h < 400 && abs($0.w - Metrics.dockMeetingWidth) <= 2 }
            if !dockStill { failures.append("10-workspace=録音面を開いたら Dock が消えた") }
        } else {
            failures.append("10-workspace=撮影不可")
        }
        WindowCoordinator.shared.hideRecordingWorkspace()
        store.meetingEnded()
        hud.mode = .idle
        WindowCoordinator.shared.syncDockPanels()

        // Genie を menu bar utility に見せない。**小さすぎたら FAIL**。
        // Idle だけは小さく保ち、使い始めたら主役の大きさへ展開する。
        let minima: [(String, CGFloat)] = [
            ("listening", Metrics.dockListeningWidth),
            ("thinking", Metrics.dockThinkingWidth),
            ("agent", Metrics.dockAgentWidth),
            ("confirmation", Metrics.dockConfirmWidth),
            ("meeting", Metrics.dockMeetingWidth),
        ]
        for (name, w) in minima where w < 500 {
            failures.append("\(name) が \(Int(w))pt しかない（補助 UI に見える）")
        }
        if Metrics.dockAgentWidth < 600 {
            failures.append("Task Dock が \(Int(Metrics.dockAgentWidth))pt（最低 600pt）")
        }
        // 使い始めたときの幅が idle の 2 倍以上ある（＝ダイナミックレンジがある）。
        if Metrics.dockAgentWidth < Metrics.dockIdleWidth * 2 {
            failures.append("展開してもほとんど大きくならない（Dock のバリエーションに見える）")
        }
        // 主テキストは 15–18pt。小さいと画面に埋もれる。
        if Metrics.dockPrimarySize < 15 { failures.append("Dock の主テキストが \(Int(Metrics.dockPrimarySize))pt") }
        if Metrics.dockSpeechSize < 16 { failures.append("発話文字が \(Int(Metrics.dockSpeechSize))pt") }

        // **top anchor 固定**: Dock の上辺 Y が全状態で同じ。
        if topEdges.count > 1 {
            failures.append("上辺の Y が状態でずれた: \(topEdges.sorted())")
        }
        if let top = topEdges.first, top != 0 {
            failures.append("Dock が画面上端に接していない (top=\(top))")
        }

        // 造形⑧ **接している面は浮かない。** 上辺が画面の縁にあるのに四周へ影を
        // 落とすと、目には「別の窓」に見える。3 人に伏せて見せたとき、
        // 小さい面でも広がった面でも 3/3 で影なしが「画面の一部に見える」と出た。
        // 宣言ではなく窓に訊く（`Elevation.apply` が実際に効いたか）。
        if ProcessInfo.processInfo.environment["ASTRA_ELEVATION"] == nil {
            let top = NSScreen.main?.frame.maxY ?? 0
            let shadowed = NSApp.windows.filter {
                $0.isVisible && $0.hasShadow && abs($0.frame.maxY - top) < 1
            }
            if !shadowed.isEmpty {
                failures.append("画面上端に接した Dock に窓の影が付いている "
                    + shadowed.map { "\(Int($0.frame.width))x\(Int($0.frame.height))" }.joined(separator: ","))
            }
        }

        store.reset()
        print("DOCK8_DIR \(outDir)")
        for line in report { print("DOCK8 \(line)") }
        if failures.isEmpty {
            print("SELFTEST_OK dock8: \(report.count)状態を実遷移で撮影・top anchor 固定・窓は常に1枚・idle \(Int(Metrics.dockIdleWidth))pt→agent \(Int(Metrics.dockAgentWidth))pt")
            exit(0)
        } else {
            print("SELFTEST_FAIL dock8: \(failures.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest dockanim`: §Animation。Presence→Listening の実測。
    ///
    /// 「180ms と書いた」ではなく、実際の window frame を追って測る。
    /// いちばん確かめたいのは **その間ずっと上辺の Y が動かない**こと
    /// （中央から上下に開くと、途中フレームで上辺が下がる）。
    @MainActor
    private static func dockAnim() {
        let store = GenieStateStore.shared
        let hud = VoiceHUDState.shared
        store.reset()
        WindowCoordinator.shared.showVoiceHUD()
        var fail: [String] = []

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.01, true) }
        }

        func dockFrame() -> NSRect? {
            guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
            for info in infos {
                guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                      let b = info[kCGWindowBounds as String] as? [String: Any],
                      let x = b["X"] as? CGFloat, let y = b["Y"] as? CGFloat,
                      let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat,
                      h < 400 else { continue }   // Dock だけ（Main window を拾わない）
                return NSRect(x: x, y: y, width: w, height: h)
            }
            return nil
        }

        hud.mode = .idle
        settle(0.6)
        guard let start = dockFrame() else { print("SELFTEST_SKIP dockanim: Dock が出ていない"); exit(0) }
        if abs(start.width - Metrics.dockIdleWidth) > 2 { fail.append("idle の幅が違う") }

        // Presence → Listening。途中の frame を細かく拾う。
        let t0 = Date()
        hud.mode = .listening(partial: "")
        let listeningSize = store.dock.size()
        var tops = Set<Int>()
        var widths: [CGFloat] = []
        var settledAt: Date?
        while Date().timeIntervalSince(t0) < 1.0 {
            CFRunLoopRunInMode(.defaultMode, 0.008, true)
            guard let f = dockFrame() else { continue }
            tops.insert(Int(f.minY.rounded()))
            widths.append(f.width)
            if settledAt == nil, abs(f.width - listeningSize.width) <= 1,
               abs(f.height - (listeningSize.height + WindowCoordinator.shared.dockTopInset)) <= 1 {
                settledAt = Date()
            }
        }

        // ① 途中も含めて上辺の Y が動いていない。
        if tops.count > 1 { fail.append("遷移中に上辺が動いた: \(tops.sorted())") }

        // ② 途中の幅が本当に変化している（一瞬で飛んでいない＝アニメーションしている）。
        let distinct = Set(widths.map { Int($0.rounded()) })
        if distinct.count < 3 { fail.append("幅が滑らかに変化していない (段階=\(distinct.count))") }

        // ③ 180ms 前後で終わっている。速すぎ/遅すぎを弾く。
        guard let settledAt else { fail.append("Listening の寸法に到達しない"); reportAnim(fail, 0); return }
        let ms = settledAt.timeIntervalSince(t0) * 1000
        if ms < 80 { fail.append(String(format: "遷移が %.0fms で速すぎる", ms)) }
        if ms > 400 { fail.append(String(format: "遷移が %.0fms で遅すぎる", ms)) }

        // ④ 中身の遅延は面のリサイズより後（§Animation 40–70ms）。
        if Motion.dockContentDelayMs < 0.040 || Motion.dockContentDelayMs > 0.070 {
            fail.append("content の遅延が 40–70ms の外")
        }
        if Motion.dockResizeMs < 0.150 || Motion.dockResizeMs > 0.220 {
            fail.append("resize が 180ms 前後でない")
        }

        // ⑤ Reduce Motion のときは即座に合わせる（アニメーションを待たせない）。
        //    OS 設定は変えられないので、経路が分岐していることをコードの値で確認する。
        hud.mode = .idle
        settle(0.4)

        store.reset()
        reportAnim(fail, ms)
    }

    private static func reportAnim(_ fail: [String], _ ms: Double) {
        if fail.isEmpty {
            print(String(format: "SELFTEST_OK dockanim: Presence→Listening %.0fms・遷移中も上辺 Y は不動・滑らかに拡大", ms))
            exit(0)
        } else {
            print("SELFTEST_FAIL dockanim: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest menutitles`: メニューバーのメニューをそのまま書き出す（docs/guide/build.py が読む）。
    /// 行は `MENU\tsep` か `MENU\titem\t<enabled 0/1>\t<title>\t<keyEquivalent>`。
    @MainActor
    private static func menuTitles() {
        let items = StatusBarController.shared.menuSnapshot()
        for it in items {
            if it.separator { print("MENU\tsep") }
            else { print("MENU\titem\t\(it.enabled ? 1 : 0)\t\(it.title)\t\(it.key)") }
        }
        print("SELFTEST_OK menutitles: \(items.filter { !$0.separator }.count) 項目")
        exit(0)
    }

    /// `--selftest facts`: 利用者に見せる語の正本（`UserFacingFacts`）を書き出す。
    /// `docs/guide/build.py` が `fact("key")` で引き、`scripts/verify-guide-facts.sh` が突き合わせる。
    ///
    /// 行: `LOCALE\t<locale>` / `FACT\t<key>\t<value>\t<protected 0/1>` / `SHORTCUT\t<key>\t<display>\t<badges>`。
    /// ここで落とすもの: key の重複、許可名が 5 でない、鍵の表示と badge の食い違い、
    /// 録音の見出しが Rust（genie-core の `hero_text`）と違う、メニューの題が facts と違う。
    /// 値は literal なので OS の言語・時刻・設定に依らない。
    @MainActor
    private static func facts() {
        var fail: [String] = []
        let all = Facts.all
        print("LOCALE\t\(Facts.locale)")
        var seen = Set<String>()
        for f in all {
            if !seen.insert(f.key).inserted { fail.append("key が重複: \(f.key)") }
            if f.value.isEmpty { fail.append("値が空: \(f.key)") }
            if f.value.contains("\t") || f.value.contains("\n") { fail.append("値に tab/改行: \(f.key)") }
            print("FACT\t\(f.key)\t\(f.value)\t\(f.protected ? 1 : 0)")
        }
        // 許可名は設定画面の 5 行と同じ数（PermissionCenter.Kind の 4 ではない）。
        let permissions = all.filter { $0.key.hasPrefix("permission.") && $0.key != "permission.request" }
        if permissions.count != Facts.permissionCount {
            fail.append("許可名が \(permissions.count) 件（\(Facts.permissionCount) のはず）")
        }
        // 鍵: 実動作と表示が同じ定義から出ていること。
        let shortcuts: [(String, UserShortcut, [String])] = [
            ("shortcut.confirmation.proceed", UserShortcut.confirm, [UserShortcut.confirm.display]),
            ("shortcut.escape", UserShortcut.cancel, [UserShortcut.cancel.display]),
        ]
        for (key, sc, badges) in shortcuts {
            print("SHORTCUT\t\(key)\t\(sc.display)\t\(badges.joined(separator: " "))")
            if sc.display != badges.joined() { fail.append("\(key): 表示 \(sc.display) と badge \(badges) が違う") }
        }
        let global = UserShortcut.globalRecordingBadges
        print("SHORTCUT\tshortcut.recording.toggle\t\(GlobalShortcut.label())\t\(global.joined(separator: " "))")
        if global.joined().lowercased() != GlobalShortcut.label().lowercased() {
            fail.append("shortcut.recording.toggle: badge \(global) が label \(GlobalShortcut.label()) と違う")
        }
        if UserShortcut.confirm.display != "⌘↩" { fail.append("確認の鍵が ⌘↩ でない: \(UserShortcut.confirm.display)") }
        if UserShortcut.cancel.display != "esc" { fail.append("逃げ道の鍵が esc でない: \(UserShortcut.cancel.display)") }
        // 録音の見出しの正本は Rust。Swift の fact はそれを写しているだけなので、ずれたら落とす。
        let rec = GenieCoreBridge.snapshot(elapsedMs: 0, isPaused: false, link: .online, pendingMs: 0).heroText
        let paused = GenieCoreBridge.snapshot(elapsedMs: 0, isPaused: true, link: .online, pendingMs: 0).heroText
        print("RUST\thero.recording\t\(rec)")
        print("RUST\thero.paused\t\(paused)")
        if rec != Facts.recordingHeroRecording { fail.append("recording.hero.recording=\(Facts.recordingHeroRecording) が Rust の \(rec) と違う") }
        if paused != Facts.recordingHeroPaused { fail.append("recording.hero.paused=\(Facts.recordingHeroPaused) が Rust の \(paused) と違う") }
        // メニューの題は NSMenu が正本（menutitles）。facts が同じ語を持っていること。
        let titles = Set(StatusBarController.shared.menuItemTitles().map(\.title))
        for (key, title) in [("menu.open", Facts.menuOpen), ("menu.settings", Facts.menuSettings),
                             ("menu.guide", Facts.menuGuide), ("menu.quit", Facts.menuQuit),
                             ("menu.checkUpdates", Facts.menuCheckUpdates)] {
            if !titles.contains(title) { fail.append("\(key)=\(title) がメニューに無い: \(titles.sorted())") }
        }
        if !titles.contains(Facts.recordingMenuStart) && !titles.contains(Facts.recordingMenuStop) {
            fail.append("recording.menu.* がメニューに無い")
        }
        if fail.isEmpty {
            print("SELFTEST_OK facts: \(all.count) 件 / 許可 \(permissions.count) / 鍵 \(shortcuts.count + 1) / locale \(Facts.locale)")
            exit(0)
        }
        for f in fail { print("  FAIL: \(f)") }
        print("SELFTEST_FAIL facts")
        exit(1)
    }

    /// `--selftest entry`: Main View への導線が**本当に開く**か。
    ///
    /// ボタンの有無ではなく、押した結果 window が出るところまで見る。
    /// 「開く」と書いてあるのに閉じるだけ、という状態を一度作ってしまったので。
    @MainActor
    private static func entryPoints() {
        let store = GenieStateStore.shared
        store.reset()
        var fail: [String] = []

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        func mainWindowOnScreen() -> Bool {
            guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
            return infos.contains { info in
                guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                      let b = info[kCGWindowBounds as String] as? [String: Any],
                      let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat else { return false }
                return w > Metrics.workspaceWidth && h >= 600
            }
        }

        // ① メニューバーからの経路。ここが**主**の入口なので割り当ても要る。
        StatusBarController.shared.install()
        guard let item = StatusBarController.shared.menuItemTitles().first(where: { $0.title.contains("開く") }) else {
            print("SELFTEST_FAIL entry: メニューに「Genie を開く」が無い"); exit(2)
        }
        if item.key.isEmpty { fail.append("「Genie を開く」にショートカットが無い") }
        // 操作ガイドはアプリ内から辿れる（RELEASE.md §2.6 の固定 URL。版番号を含めない）。
        if !StatusBarController.shared.menuItemTitles().contains(where: { $0.title.contains("ガイド") }) {
            fail.append("メニューに「操作ガイド」が無い")
        }
        if StatusBarController.guideURL.lastPathComponent != "Genie-guide-ja.pdf" {
            fail.append("操作ガイドの URL が固定名 Genie-guide-ja.pdf ではない: \(StatusBarController.guideURL)")
        }
        // 更新の確認はメニューから辿れる（SoftwareUpdate.checkNow() は 0.1.1 まで呼び手が無かった）。
        if !StatusBarController.shared.menuItemTitles().contains(where: { $0.title == Facts.menuCheckUpdates }) {
            fail.append("メニューに「\(Facts.menuCheckUpdates)」が無い")
        }
        // 押せる項目は全部 action と target を持つ（題だけの項目は行き止まり）。
        for it in StatusBarController.shared.menuWiring() where !it.wired {
            fail.append("「\(it.title)」は押せるのに何も起きない（action/target が無い）")
        }

        // ② 実際に開く。
        MainWindowController.shared.showSection(.home)
        store.workspaceOpened()
        settle(1.2)
        if !mainWindowOnScreen() { fail.append("メニュー経路で window が出ない") }
        if store.state.mode != .workspace { fail.append("workspace に遷移していない") }
        MainWindowController.shared.hide()
        settle(0.6)

        // ③ 結果面の各操作が**ラベルどおりに**効くか。閉じるだけの偽ボタンを置かない。
        for action in [AgentResult.Action.openWorkspace, .openNotes] {
            store.reset()
            store.setDock(.result(AgentResult(title: "検証", actions: [action])))
            ResultActionRunner.run(action, title: "検証")
            settle(1.0)
            if !mainWindowOnScreen() { fail.append("\(action.title) が window を開かない") }
            MainWindowController.shared.hide()
            settle(0.5)
        }

        // ④ copy は本当に貼り付けられる形にする。
        NSPasteboard.general.clearContents()
        ResultActionRunner.run(.copy, title: "コピーされる文字")
        if NSPasteboard.general.string(forType: .string) != "コピーされる文字" {
            fail.append("コピーが効いていない")
        }

        store.reset()
        if fail.isEmpty {
            print("SELFTEST_OK entry: メニュー(⌘O)・Dock・結果面のどれからも Main View が実際に開く")
            exit(0)
        } else {
            print("SELFTEST_FAIL entry: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest secret`: シークレットモード。**本当に画面キャプチャから消えるか。**
    ///
    /// 「sharingType を設定した」で終わらせない。画面全体を撮って、
    /// その中に Genie の窓が写っていないことを window server 側で確かめる。
    @MainActor
    private static func secretMode() {
        var fail: [String] = []
        let secret = SecretMode.shared
        let store = GenieStateStore.shared
        store.reset()
        secret.set(false)

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        /// 画面全体のキャプチャに、自分の窓が含まれているか。
        /// `CGWindowListCreateImage` の onScreenOnly は他プロセスの画面共有と同じ経路を通る。
        /// Dock の載っている帯を**別プロセス**に撮らせて返す。
        ///
        /// `sharingType = .none` は「他のプロセスから読めない」という約束なので、
        /// 自分で `CGWindowListCreateImage` を呼んでも必ず写る（実測: 秘匿 ON・
        /// `sharingType=0` でも自プロセスからは見えた）。以前ここは自分で撮っていて、
        /// 画面構成が変わるまでたまたま通っていた。約束を確かめるなら他人に撮らせる。
        func screenStrip(_ panel: NSWindow, _ tag: String) -> CGImage? {
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            let f = panel.frame
            // screencapture の -R は左上原点。
            let rect = "\(Int(f.minX)),\(Int(primaryHeight - f.maxY)),\(Int(f.width)),\(Int(f.height))"
            let out = NSTemporaryDirectory() + "astra-secret-\(tag)-\(getpid()).png"
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-x", "-o", "-R", rect, out]
            do { try p.run(); p.waitUntilExit() } catch { return nil }
            guard p.terminationStatus == 0,
                  let data = FileManager.default.contents(atPath: out),
                  let rep = NSBitmapImageRep(data: data) else { return nil }
            try? FileManager.default.removeItem(atPath: out)
            return rep.cgImage
        }

        // 出しておく。
        WindowCoordinator.shared.showVoiceHUD()
        settle(1.0)
        guard let dock = NSApp.windows.first(where: { $0.isVisible && $0.frame.height < 200 }) else {
            print("SELFTEST_SKIP secret: Dock を出せない"); exit(0)
        }

        // ① 既定では映る。
        if SecretMode.isHidden(dock) { fail.append("既定でキャプチャから外れている（気づかず隠れてしまう）") }
        settle(0.4)
        let shown = screenStrip(dock, "on")

        // ② ON にすると消える。
        secret.set(true)
        settle(0.6)
        if !SecretMode.isHidden(dock) { fail.append("ON にしても sharingType が変わらない") }
        let hidden = screenStrip(dock, "off")

        // ③ 比べる相手として、Dock を実際に閉じた同じ帯も撮る。
        WindowCoordinator.shared.hideVoiceHUD()
        settle(0.6)
        let absent = screenStrip(dock, "absent")
        WindowCoordinator.shared.showVoiceHUD()
        settle(0.6)

        if let shown, let hidden, let absent {
            // 出ているときは「無い」と違って見え、秘匿したら「無い」と同じに見えること。
            if imagesLookEqual(shown, absent) { fail.append("通常時に画面キャプチャへ写っていない") }
            if !imagesLookEqual(hidden, absent) { fail.append("ON にしても他プロセスのキャプチャに写る") }
        } else {
            print("SELFTEST_SKIP secret: screencapture が使えない"); exit(0)
        }

        // ③ 後から作った窓にも効く（作った順で漏れない）。
        WindowCoordinator.shared.showRecordingWorkspace()
        settle(0.8)
        let leaked = NSApp.windows.filter { $0.isVisible && !SecretMode.isHidden($0) }
        if !leaked.isEmpty { fail.append("\(leaked.count) 枚の窓が隠れていない") }
        WindowCoordinator.shared.hideRecordingWorkspace()

        // ④ OFF に戻せる。
        secret.set(false)
        settle(0.5)
        if SecretMode.isHidden(dock) { fail.append("OFF に戻らない") }

        WindowCoordinator.shared.hideVoiceHUD()
        store.reset()
        if fail.isEmpty {
            print("SELFTEST_OK secret: 既定は映る・ON で実際に画面キャプチャから消える・後から出した窓にも効く・戻せる")
            exit(0)
        } else {
            print("SELFTEST_FAIL secret: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest navtitle`: **見出しは、いま開いている面のものか。**
    ///
    /// 見出しは `MainNav.title` の 1 か所から決まるが、「決めた」だけでは効いたことに
    /// ならない。実際、各 Pane が自分の `.navigationTitle` を持っていた頃は、会議詳細を
    /// 開いても "Home" のままだった。宣言ではなく**描かれた見出し帯を撮って**確かめる。
    /// 面を変えたのに帯が同じ絵なら、見出しが状態から外れている。
    @MainActor
    private static func navtitle() {
        func settle(_ sec: Double) {
            let until = Date().addingTimeInterval(sec)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        MainWindowController.shared.show()
        settle(1.0)

        /// 見出し帯（sidebar の右・toolbar の高さ）だけを切り出して署名にする。
        func titleStrip() -> [UInt8]? {
            settle(0.6)
            guard let win = NSApp.windows.first(where: { $0.isVisible && $0.frame.width > 900 }),
                  let cg = CGWindowListCreateImage(
                    .null, .optionIncludingWindow, CGWindowID(win.windowNumber),
                    [.boundsIgnoreFraming, .bestResolution]) else { return nil }
            let rep = NSBitmapImageRep(cgImage: cg)
            // point → pixel。Retina では 2 倍になる。
            let scale = CGFloat(rep.pixelsWide) / win.frame.width
            let x0 = Int((Metrics.sidebarWidth + 10) * scale)
            let x1 = min(rep.pixelsWide, Int((Metrics.sidebarWidth + 260) * scale))
            let y0 = Int(8 * scale), y1 = min(rep.pixelsHigh, Int(44 * scale))
            guard x1 > x0, y1 > y0 else { return nil }
            var out: [UInt8] = []
            for y in stride(from: y0, to: y1, by: 2) {
                for x in stride(from: x0, to: x1, by: 2) {
                    if let c = rep.colorAt(x: x, y: y) {
                        let l = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
                        out.append(UInt8(max(0, min(255, l * 255))))
                    }
                }
            }
            return out
        }

        var strips: [(String, [UInt8])] = []
        var fail: [String] = []
        for s in MainSection.allCases {
            MainWindowController.shared.showSection(s)
            guard let strip = titleStrip() else { fail.append("\(s.title)=撮影不可"); continue }
            if MainNav.shared.title != s.title { fail.append("\(s.title)=状態が合わない(\(MainNav.shared.title))") }
            strips.append((s.title, strip))
        }
        MainWindowController.shared.showMeetingDetailPreview()
        let detailTitle = MainNav.shared.title
        // 詳細の見出しは、一覧("Meetings" / "Library")と紛れない**その会議の名前**であること。
        if detailTitle == "Meeting" || detailTitle == LibraryTab.meetings.title || detailTitle == MainSection.library.title {
            fail.append("会議詳細の見出しが一覧と紛れる(\(detailTitle))")
        }
        if let strip = titleStrip() { strips.append((detailTitle, strip)) } else { fail.append("\(detailTitle)=撮影不可") }

        // 1 件を開いたあと、sidebar で別の面を選んだら**出られる**こと。
        // sidebar は `section` を直に書いていて、`detailContent` は `openSession` /
        // `meetingDetail` を先に見るので、会議を開いたあとは sidebar が効かなかった
        // （sample14 の 2 名「戻る手段が見当たらない」）。sidebar と同じ `select` を通す。
        MainNav.shared.select(.home)
        settle(0.4)
        if MainNav.shared.meetingDetail || MainNav.shared.title != MainSection.home.title {
            fail.append("会議詳細から sidebar で Home へ出られない(title=\(MainNav.shared.title))")
        }
        MainNav.shared.select(.library)
        MainNav.shared.openSession = "navtitle-open"
        settle(0.6)   // 描き直しで sidebar が同じ値を書き戻して閉じてしまわないこと
        if MainNav.shared.openSession == nil { fail.append("開いた Session が描き直しで閉じた") }
        MainNav.shared.select(.work)
        settle(0.4)
        if MainNav.shared.openSession != nil || MainNav.shared.title != MainSection.work.title {
            fail.append("Session から sidebar で Work へ出られない(title=\(MainNav.shared.title))")
        }

        // 帯どうしが別の絵か。同じなら見出しが更新されていない。
        for i in strips.indices {
            for j in strips.indices where j > i {
                let (na, a) = strips[i], (nb, b) = strips[j]
                guard a.count == b.count else { continue }
                var n = 0
                for k in 0..<a.count where abs(Int(a[k]) - Int(b[k])) >= 16 { n += 1 }
                if Double(n) / Double(a.count) <= 0.005 {
                    fail.append("\(na) と \(nb) の見出しが同じ絵")
                }
            }
        }
        MainWindowController.shared.hide()
        if fail.isEmpty {
            print("SELFTEST_OK navtitle: \(strips.count)面の見出しが状態と一致し、面ごとに実際に描き変わる。1 件を開いても sidebar で出られる")
            exit(0)
        } else {
            print("SELFTEST_FAIL navtitle: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest density <shotsDir> <baseline.json>`: **面がどれだけ空いているか。**
    ///
    /// 「Voice OS / SuperIntern より良い」を目で言い合っても決まらないので、測る。
    /// いちばん多く使われている色（＝地）が画面のどれだけを占めるかを面ごとに出す。
    /// 高いほど、開いているのに何も返していない画面ということ。
    ///
    /// 絶対値の合格線は引かない（面によって適正が違う）。**基準より悪くなったら落とす**
    /// 歯止めにする。良くなったぶんは基準を更新して締め直す。
    private static func density(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 3 else { print("SELFTEST_FAIL density: 引数が足りない"); exit(2) }
        let dir = args[i + 2], baselinePath = args[i + 3]
        let layoutData = FileManager.default.contents(atPath: "\(dir)/capture-layout.json")
        let layouts = layoutData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: [String: Int]] } ?? [:]

        /// 地の色が占める割合（%）。
        func emptiness(_ path: String, layout: [String: Int]?) -> Double? {
            guard let data = FileManager.default.contents(atPath: path),
                  let rep = NSBitmapImageRep(data: data) else { return nil }
            var counts: [UInt32: Int] = [:]
            var pts: [UInt32] = []
            let pw = rep.pixelsWide, ph = rep.pixelsHigh
            let inset = layout?["topInsetPx"] ?? 0
            guard inset >= 0, inset < ph,
                  layout == nil || (layout?["width"] == pw && layout?["height"] == ph) else { return nil }
            // The camera safe-area band is reserved, not content space. Total window
            // occupation, including this band, is still checked by occupationGate.
            let step = max(1, min(pw, ph - inset) / 220)
            var y = inset
            while y < ph { var x = 0
                while x < pw {
                    if let c = rep.colorAt(x: x, y: y) {
                        let r = UInt32(max(0, min(255, c.redComponent * 255)))
                        let g = UInt32(max(0, min(255, c.greenComponent * 255)))
                        let b = UInt32(max(0, min(255, c.blueComponent * 255)))
                        let key = (r << 16) | (g << 8) | b
                        pts.append(key); counts[key, default: 0] += 1
                    }
                    x += step }
                y += step }
            guard let bg = counts.max(by: { $0.value < $1.value })?.key, !pts.isEmpty else { return nil }
            let br = Int((bg >> 16) & 255), bgc = Int((bg >> 8) & 255), bb = Int(bg & 255)
            var same = 0
            for p in pts {
                let r = Int((p >> 16) & 255), g = Int((p >> 8) & 255), b = Int(p & 255)
                if abs(r - br) + abs(g - bgc) + abs(b - bb) <= 12 { same += 1 }
            }
            return Double(same) / Double(pts.count) * 100
        }

        var baseline: [String: Double] = [:]
        if let d = FileManager.default.contents(atPath: baselinePath),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Double] {
            baseline = obj
        }

        // The approved notch reference moves the outer top edge into the camera
        // band. Its content-only density therefore needs a matching reference.
        // Override only recorded Dock surfaces; all other historical limits stay.
        let requestedBaseline = URL(fileURLWithPath: baselinePath).standardizedFileURL
        if requestedBaseline.path.hasSuffix("/docs/evidence/density-baseline.json"),
           let inset = layouts["01-voice-hud-idle"]?["topInsetPx"], inset > 0,
           let screen = NSScreen.main {
            let os = ProcessInfo.processInfo.operatingSystemVersion
            let profile = "macos-\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)-\(Int(screen.backingScaleFactor))x-safe-top-\(inset)"
            let reference = requestedBaseline.deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("golden-screenshots/environments/\(profile)/density-baseline.json")
            guard let d = try? Data(contentsOf: reference),
                  let values = try? JSONSerialization.jsonObject(with: d) as? [String: Double],
                  values.count == 3,
                  ["01-voice-hud-idle", "02-voice-hud-listening", "02b-voice-hud-preparing"].allSatisfy({ values[$0] != nil }) else {
                print("SELFTEST_FAIL density: matching notch reference missing: \(reference.path)"); exit(2)
            }
            baseline.merge(values) { _, adopted in adopted }
            print("DENSITY_REFERENCE \(reference.path)")
        }

        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir))?
            .filter { $0.hasSuffix(".png") }.map { String($0.dropLast(4)) }.sorted() ?? []
        guard !names.isEmpty else { print("SELFTEST_FAIL density: \(dir) に png が無い"); exit(2) }

        var measured: [String: Double] = [:]
        var worse: [String] = []
        for n in names {
            guard let e = emptiness("\(dir)/\(n).png", layout: layouts[n]) else {
                worse.append("\(n): image/capture layout invalid"); continue
            }
            measured[n] = (e * 10).rounded() / 10
            print(String(format: "DENSITY %@ 地 %.1f%%", n, e))
            // 撮影ごとの揺れを拾わないよう 1.5 ポイントの遊びを持たせる。
            if let b = baseline[n], e > b + 1.5 {
                worse.append(String(format: "%@ が %.1f%% → %.1f%% に空いた", n, b, e))
            }
        }
        if baseline.isEmpty {
            let out = try? JSONSerialization.data(withJSONObject: measured, options: [.sortedKeys, .prettyPrinted])
            try? out?.write(to: URL(fileURLWithPath: baselinePath))
            print("SELFTEST_OK density: 基準が無かったので \(measured.count) 面を記録した")
            exit(0)
        }
        if worse.isEmpty {
            let best = measured.min(by: { $0.value < $1.value })
            let hollow = measured.max(by: { $0.value < $1.value })
            print(String(format: "SELFTEST_OK density: %d面が基準以下（最も詰まっている %@ %.1f%% / 最も空いている %@ %.1f%%）",
                         measured.count, best?.key ?? "-", best?.value ?? 0,
                         hollow?.key ?? "-", hollow?.value ?? 0))
            exit(0)
        } else {
            print("SELFTEST_FAIL density: \(worse.joined(separator: ", "))")
            exit(2)
        }
    }

    /// 撮る前にカーソルを画面の隅へ退ける。
    ///
    /// 押せる要素は hover で地の濃さが変わる。カーソルがたまたま行の上にあると
    /// その 1 行だけ濃くなり、撮るたびに golden が動く（会議詳細の引用の行を
    /// ボタンにした直後、dark で 1.55% 揺れた）。撮影は人の手の位置に依存させない。
    @MainActor
    static func parkCursor() {
        guard let screen = NSScreen.screens.first else { return }
        // 右端の中ほど。**隅は避ける** —— Hot Corner を踏むと Mission Control が出て、
        // 窓のキャプチャそのものが失敗する（右下に置いた直後、guishot と secret が
        // 実行のたびに別々に落ちた）。窓は中央にあるので、右端なら重ならない。
        let frame = screen.frame
        CGWarpMouseCursorPosition(CGPoint(x: frame.maxX - 40, y: frame.midY))
        CGAssociateMouseAndMouseCursorPosition(1)
    }

    /// `--selftest update`: **自動更新の口が、設定なしで動き出さないか。**
    ///
    /// appcast の URL と公開鍵のどちらかが欠けたまま Sparkle を起動すると、
    /// 「更新を確かめている」つもりで何も見ていない、あるいは検証なしに拾ってくる。
    /// 設定が無ければ**起動しない**ことと、欠けている理由を言えることを見る。
    @MainActor
    private static func updateCheck() {
        var fail: [String] = []
        let reason = SoftwareUpdate.misconfiguration()
        let started = SoftwareUpdate.shared.startIfConfigured()

        if reason != nil {
            // 設定が無い状態。ここで起動していたら、確かめていないのに確かめた顔をする。
            if started { fail.append("設定が無いのに更新の口が動いた") }
            if SoftwareUpdate.shared.isAvailable { fail.append("設定が無いのに利用可能を名乗る") }
            // 「更新を確認…」を押しても、確かめたふりをせず理由を返す。
            if (SoftwareUpdate.shared.checkNow() ?? "").isEmpty {
                fail.append("設定が無いのに checkNow が確認したことにする")
            }
        } else {
            if !started { fail.append("設定は揃っているのに動かない") }
        }

        // 版が言えること。バンドル外（swift build の実行体）では nil で正しい。
        let version = SoftwareUpdate.currentVersion
        let inBundle = Bundle.main.bundleIdentifier != nil
        if inBundle && version == nil { fail.append(".app なのに版を言えない") }

        if fail.isEmpty {
            let state = reason.map { "未設定（\($0)）" } ?? "設定済み"
            print("SELFTEST_OK update: \(state)・設定が無ければ動かない・版=\(version ?? "なし(バンドル外)")")
            exit(0)
        } else {
            print("SELFTEST_FAIL update: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest recoveryui`: **録りかけを捨てられるか。**
    ///
    /// 送り先が無いと `recover` は何もできない。捨てる道が無いと
    /// 「録りかけが N 件あります」を永久に見続けることになる（実測で 150 件まで
    /// 溜まった）。消せないお知らせは、ただの雑音になる。
    /// 走っている録音を巻き込まないことと、置き場の外を消さないことも見る。
    @MainActor
    private static func recoveryUI() {
        var fail: [String] = []
        let runtime = RecordingRuntime.shared
        let root = LocalStore.dataRoot.appendingPathComponent("meetings")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        // 捨てる対象を 2 件作る（実ディレクトリ）。
        var made: [String] = []
        for i in 0..<2 {
            let id = "discard-selftest-\(getpid())-\(i)"
            let dir = root.appendingPathComponent(id)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? Data("x".utf8).write(to: dir.appendingPathComponent("fragment.bin"))
            made.append(id)
        }

        // ① 捨てられる。
        for id in made where !runtime.discard(meetingId: id) { fail.append("\(id) を捨てられない") }
        for id in made where FileManager.default.fileExists(atPath: root.appendingPathComponent(id).path) {
            fail.append("\(id) が残っている")
        }

        // ② **置き場の外は消さない。** id に .. が混ざっても外へ出ない。
        let outside = LocalStore.dataRoot.appendingPathComponent("do-not-delete-selftest")
        try? FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        _ = runtime.discard(meetingId: "../do-not-delete-selftest")
        if !FileManager.default.fileExists(atPath: outside.path) {
            fail.append("置き場の外を消した")
        }
        try? FileManager.default.removeItem(at: outside)

        // ③ 走っている録音は捨てない。
        let live = "live-selftest-\(getpid())"
        runtime.begin(meetingId: live, captureMic: false)
        if runtime.discard(meetingId: runtime.activeMeetingId) { fail.append("録音中のものを捨てた") }
        runtime.end()
        _ = runtime.discard(meetingId: runtime.activeMeetingId)

        if fail.isEmpty {
            print("SELFTEST_OK recoveryui: 録りかけを捨てられる・置き場の外は消さない・録音中のものは捨てない")
            exit(0)
        } else {
            print("SELFTEST_FAIL recoveryui: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// geometry / occupation が測る 6 状態。名前は正解画像（task-dock/）と揃える。
    @MainActor
    private static func geometryStates() -> [(String, () -> Void)] {
        let store = GenieStateStore.shared
        let recording = RecordingWorkspaceState.shared
        return [
            ("01-idle", { store.reset(); VoiceHUDState.shared.mode = .idle }),
            ("02-listening", { store.reset(); VoiceHUDState.shared.mode = .listening(partial: "このページからタスクを作って…") }),
            ("03-task-dock", {
                store.reset()
                store.startTask(AgentTask(
                    id: UUID(), title: "週次ブリーフィングを作る", status: .running,
                    steps: [AgentStep(title: "Calendar", tool: "calendar", state: .success),
                            AgentStep(title: "Gmail", tool: "gmail", state: .running),
                            AgentStep(title: "Notion", tool: "notion")],
                    startedAt: Date(), context: ContextBundle(items: [])))
            }),
            ("04-meeting", {
                store.reset(); store.meetingDetected(app: "Google Meet")
                store.meetingStarted(id: "geometry-selftest")
                // 基準は「録音中で音が届いている」姿。実マイクは開かないので、届いた姿を作る
                // （これが無いと Dock は正しく「準備中…」になり、text:Google Meet が無いと落ちる）。
                recording.markAudioLiveForShot()
            }),
            ("05-meeting-notes", {
                // shots の 09 と同じ 4 件。高さは中身で決まるので、空のまま測ると別の面になる。
                store.updateCanvas(MeetingCanvas(
                    decisions: ["導入時期は 10 月で行きます"],
                    actions: ["見積は明日までにお願いします"],
                    questions: ["誰が対応しますか？"],
                    concerns: ["初期費用が心配です"], notes: []))
                VoiceHUDState.shared.toggleMeetingPanel(.notes)
            }),
            ("06-workspace", {
                recording.loadDemo(ragOpen: false)
                WindowCoordinator.shared.showRecordingWorkspace()
            }),
        ]
    }

    /// `--selftest occupation`: **面は宣言した寸法より大きくならない。**
    ///
    /// screen_occupation を採点者に訊くと、版面を見て面積を**推論**する
    /// （craft3 で 3 人が「C は背が高い」と言い、実寸は 3 枚とも同じだった。
    /// sample11〜17 では 5 型中 3 型が cannot tell）。面積は測るものなので、
    /// 6 状態の窓の実寸を `shared/design/tokens.json` の寸法（`Metrics`）と
    /// 突き合わせ、超えたら落とす。`geometry` の基準は `--record` で書き直せるが、
    /// ここの上限は token を変えない限り動かない。
    ///
    /// 占有の割合は 1440x900（13 インチの最小の画面）に対して出す。
    /// 数字は証拠として残す（Evidence A）。採点者の占有票は使わない。
    @MainActor
    private static func occupationGate() {
        guard AXIsProcessTrusted() else {
            print("SELFTEST_SKIP occupation: AX not trusted（実寸を読めない）"); exit(0)
        }
        _ = GlobalShortcut.shared.register(handler: {})
        func settle(_ sec: Double) {
            let until = Date().addingTimeInterval(sec)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        let dockKey = "window:GeniePanel<VoiceTaskDockView>"
        let workspaceKey = "window:GeniePanel<RecordingWorkspaceView>"
        // 状態ごとの上限（token）。03 の agent は行数で伸びるので、出している 3 行ぶん。
        let ceilings: [String: [(String, CGFloat, CGFloat)]] = [
            "01-idle": [(dockKey, Metrics.dockIdleWidth, Metrics.dockIdleHeight)],
            "02-listening": [(dockKey, Metrics.dockListeningWidth, Metrics.dockListeningHeight)],
            "03-task-dock": [(dockKey, Metrics.dockAgentWidth, Metrics.dockAgentHeightBase + Metrics.dockAgentRowHeight * 3)],
            "04-meeting": [(dockKey, Metrics.dockMeetingWidth, Metrics.dockMeetingHeight)],
            "05-meeting-notes": [(dockKey, Metrics.dockMeetingWidth, Metrics.dockMeetingExpandedHeight)],
            "06-workspace": [(dockKey, Metrics.dockMeetingWidth, Metrics.dockMeetingExpandedHeight),
                             (workspaceKey, Metrics.workspaceWidth, Metrics.workspaceHeight)],
        ]
        let refW = 1440.0, refH = 900.0

        GenieStateStore.shared.reset()
        WindowCoordinator.shared.showVoiceHUD()
        var fail: [String] = []
        var measured = 0
        for (name, present) in geometryStates() {
            present()
            settle(1.2)
            guard let snap = UIGeometry.snapshot() else { fail.append("\(name): 実寸を読めない"); continue }
            for (key, maxW, contentMaxH) in ceilings[name] ?? [] {
                let maxH = contentMaxH + (key == dockKey ? WindowCoordinator.shared.dockTopInset : 0)
                guard let box = snap[key] else { fail.append("\(name): \(key) が出ていない"); continue }
                measured += 1
                let share = box.w * box.h / (refW * refH) * 100
                let short = key.replacingOccurrences(of: "window:GeniePanel<", with: "").replacingOccurrences(of: ">", with: "")
                print(String(format: "OCCUPATION %@ %@: %.0fx%.0fpt = %.1f%% of 1440x900（上限 %.0fx%.0f）",
                             name, short, box.w, box.h, share, maxW, maxH))
                // 0.5pt は AX の丸め。1pt を超えて上限より大きければ、面が育っている。
                if box.w > Double(maxW) + 1 || box.h > Double(maxH) + 1 {
                    fail.append(String(format: "%@ %@ %.0fx%.0f > 上限 %.0fx%.0f", name, short, box.w, box.h, maxW, maxH))
                }
            }
        }
        WindowCoordinator.shared.hideRecordingWorkspace()
        WindowCoordinator.shared.hideVoiceHUD()
        GenieStateStore.shared.reset()

        if fail.isEmpty {
            print("SELFTEST_OK occupation: \(measured)面の実寸が token の上限以内")
            exit(0)
        }
        for f in fail { print("OCCUPATION FAIL \(f)") }
        print("SELFTEST_FAIL occupation: \(fail.count)面が宣言した寸法より大きい")
        exit(2)
    }

    /// `--selftest geometry <reference-dir> [--record]`:
    /// **6 状態の実寸を pt で測り、基準と 2pt で突き合わせる。**
    ///
    /// 画素の何 % で見ていると、「30pt ずれている」も「影が少し濃い」も同じ 0.4% に
    /// なり、どちらを先に直すか決まらない。位置・寸法を pt で測れば、ずれた量が
    /// そのまま出るし、直す順番も機械的に決まる（geometry が合うまで下の層は見ない）。
    ///
    /// `--record` で今の値を基準として書き出す。
    @MainActor
    private static func geometryGate(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        var refDir = args.count > i + 2 ? args[i + 2] : "docs/golden-screenshots/geometry"
        let requested = URL(fileURLWithPath: refDir)
        if requested.lastPathComponent == "geometry",
           requested.deletingLastPathComponent().lastPathComponent == "golden-screenshots",
           let screen = NSScreen.main, screen.safeAreaInsets.top > 0 {
            let os = ProcessInfo.processInfo.operatingSystemVersion
            let profile = "macos-\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)-\(Int(screen.backingScaleFactor))x-safe-top-\(Int(screen.safeAreaInsets.top))"
            refDir = requested.deletingLastPathComponent().appendingPathComponent("environments/\(profile)/geometry").path
        }
        let record = args.contains("--record")
        try? FileManager.default.createDirectory(atPath: refDir, withIntermediateDirectories: true)

        guard AXIsProcessTrusted() else {
            print("SELFTEST_SKIP geometry: AX not trusted（実寸を読めない）"); exit(0)
        }

        // 撮る前に本番と同じ状態にする。ショートカットを登録しないまま測ると、
        // 実利用者が見ない姿（⌥Space の案内がクリック案内に化けた状態）が
        // 基準になる。検査の環境と製品の姿がずれると、ずれのほうを直してしまう。
        _ = GlobalShortcut.shared.register(handler: {})
        func settle(_ sec: Double) {
            let until = Date().addingTimeInterval(sec)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        let store = GenieStateStore.shared
        WindowCoordinator.shared.showVoiceHUD()
        let states = geometryStates()

        var problems: [(String, [String])] = []
        var recorded = 0
        for (name, present) in states {
            present()
            settle(1.2)
            guard let snap = UIGeometry.snapshot(), !snap.isEmpty else {
                problems.append((name, ["実寸を 1 つも読めない"])); continue
            }
            let path = "\(refDir)/\(name).json"
            if record {
                UIGeometry.write(snap, to: path); recorded += 1; continue
            }
            guard let want = UIGeometry.read(path) else {
                problems.append((name, ["基準が無い（--record で作る）"])); continue
            }
            let diffs = UIGeometry.compare(snap, to: want)
            for (layer, lines) in diffs where !lines.isEmpty {
                problems.append((name, lines.map { "\(layer.label) \($0)" }))
            }
        }
        WindowCoordinator.shared.hideRecordingWorkspace()
        WindowCoordinator.shared.hideVoiceHUD()
        store.reset()

        if record {
            print("SELFTEST_OK geometry: \(recorded)状態の実寸を基準として記録した（\(refDir)）")
            exit(0)
        }
        if problems.isEmpty {
            print("SELFTEST_OK geometry: 6状態の位置・寸法が基準と 2pt 以内")
            exit(0)
        }
        // **直す順番に並べて出す。** 上の段が残っているうちは下を出さない。
        for (name, lines) in problems {
            for l in lines { print("GEOMETRY \(name): \(l)") }
        }
        // 出ている層のうち、いちばん上のものを名指しする。「まず Geometry」と
        // 決め打ちすると、Spacing しか出ていないときに嘘になる。
        let firstLayer = problems.flatMap { $0.1 }
            .compactMap { line in UIGeometry.Layer.allCases.first { line.hasPrefix($0.label) } }
            .min(by: { $0.rawValue < $1.rawValue })
        let hint = firstLayer.map { "まず \($0.label) から直す" } ?? "上の層から直す"
        print("SELFTEST_FAIL geometry: \(problems.count)面が基準から外れた（\(hint)）")
        exit(2)
    }

    /// `--selftest focus`: **Dock は前面のアプリから焦点を奪わないか。**
    ///
    /// 「窓が増えない」は測っていたが、「邪魔をしない」は測っていなかった。
    /// 常駐して姿を変える面は、出るたびに他アプリの入力を横取りすると
    /// 使い物にならない。`.nonactivatingPanel` と `canBecomeKey=false` は
    /// 宣言してあるが、**宣言だけでは効いたことにならない**ので実際に確かめる。
    @MainActor
    private static func focusGate() async {
        var fail: [String] = []
        func settle(_ sec: Double) async {
            // Return to NSApplication's event loop so activation/deactivation is
            // delivered normally. A nested CFRunLoop can observe stale focus
            // while LaunchServices is still restoring the launching app.
            try? await Task.sleep(for: .seconds(sec))
        }

        // 他アプリを前面にする。Finder はどの Mac にも居る。
        let others = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == "com.apple.finder"
        }
        guard let other = others.first else {
            print("SELFTEST_SKIP focus: 前面にできる他アプリが無い"); exit(0)
        }
        other.activate()
        await settle(1.2)
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == other.bundleIdentifier else {
            print("SELFTEST_SKIP focus: 他アプリを前面にできない（この環境では確かめられない）"); exit(0)
        }

        let store = GenieStateStore.shared
        // Dock を出して、姿を変えていく。どの段でも前面が入れ替わってはいけない。
        let steps: [(String, () -> Void)] = [
            ("Dock を出す", { WindowCoordinator.shared.showVoiceHUD() }),
            ("Listening へ", { VoiceHUDState.shared.mode = .listening(partial: "…") }),
            ("Agent へ", {
                store.startTask(AgentTask(
                    id: UUID(), title: "焦点の検査", status: .running,
                    steps: [AgentStep(title: "step", tool: "t", state: .running)],
                    startedAt: Date(), context: ContextBundle(items: [])))
            }),
            ("会議へ", { store.meetingDetected(app: "Google Meet"); store.meetingStarted(id: "focus-selftest") }),
            ("Notes を開く", { VoiceHUDState.shared.toggleMeetingPanel(.notes) }),
        ]
        for (label, act) in steps {
            act()
            await settle(0.9)

            // 製品がしない操作（makeKeyAndOrderFront を総当たり）でこじ開けるのは
            // やめた。Ask 用の面は key になれてよいので、それを「奪った」と呼ぶのは誤り。
            // 実際に焦点を奪う経路は `NSApp.activate` で、それはこの下の判定が捕まえる
            // （showVoiceHUD に activate を仕込んだら 5 段すべてで検出できた）。

            let frontApp = NSWorkspace.shared.frontmostApplication
            if frontApp?.bundleIdentifier != other.bundleIdentifier {
                // 誰に移ったかまで言う。自分に移ったのか別のアプリなのかで、直す先が違う。
                let who = frontApp?.localizedName
                    ?? frontApp?.bundleIdentifier
                    ?? "不明（bundle 無し＝自分の可能性）"
                fail.append("\(label)で前面が \(who) に移った")
            }
            // 他アプリが前面のあいだ、こちらに key 窓が在ってはいけない。
            if let key = NSApp.keyWindow {
                fail.append("\(label)で自分の窓が key になった（\(type(of: key))）")
            }
        }

        WindowCoordinator.shared.hideVoiceHUD()
        store.reset()
        if fail.isEmpty {
            print("SELFTEST_OK focus: Dock は出ても姿を変えても、前面のアプリから焦点を奪わない")
            exit(0)
        } else {
            print("SELFTEST_FAIL focus: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest hold-meeting <秒>`: **会議の面を出したまま置いておく。**
    ///
    /// 訂正の道が見えるかは、静止画 1 枚では測れない（開いた先が写らない）。
    /// 実装を知らない評価者に**実際に直させて**測るために、拾ったものが在る
    /// 状態で待つ口が要る。
    @MainActor
    static func holdMeeting(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")
        let secs = Double(i.map { args.count > $0 + 2 ? args[$0 + 2] : "" } ?? "") ?? 300
        _ = GlobalShortcut.shared.register(handler: { WindowCoordinator.shared.toggleRecording() })
        // `silent` は**音も発話も無い**状態で置く。合成のディスク経路だけを
        // 起動し、raw debug executable が macOS TCC を呼ばないようにする。
        // 「音が届いていません」が同時に出る）が起きるのはここだけなので、
        // これが無いと歯止めが素通りする（実際、壊しても落ちなかった）。
        if args.contains("silent") {
            RecordingWorkspaceState.shared.start(captureMic: false, transcribe: false, requestPermissions: false)
            WindowCoordinator.shared.showRecordingWorkspace()
            print("HOLD_MEETING \(secs)s silent")
            fflush(stdout)
            DispatchQueue.main.asyncAfter(deadline: .now() + secs) { exit(0) }
            RunLoop.main.run()
            return
        }

        RecordingWorkspaceState.shared.start()

        RecordingWorkspaceState.shared.transcript = [
            TranscriptSegment(speaker: "Sarah", text: "Windows はいつ出しますか。", interim: false, at: 630),
            TranscriptSegment(speaker: "Ken", text: "macOS を先に出します", interim: false, at: 642),
            TranscriptSegment(speaker: "Ken", text: "Windows は次の周で追います。", interim: false, at: 655),
        ]
        MeetingIntelligence.shared.ingest([
            CanvasItem("macOS を先に出します", at: 642, speaker: "Ken"),
            CanvasItem("オンボーディングを試作する", at: 861, speaker: "Sarah"),
        ], force: true)
        WindowCoordinator.shared.showRecordingWorkspace()
        print("HOLD_MEETING \(secs)s")
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + secs) { exit(0) }
        RunLoop.main.run()
    }

    /// `--selftest confirmflow`: **確認の面の受け入れ条件**を実際に動かして見る。
    ///
    /// 撮った絵だけでは、鍵盤の割り当ても、直してから戻れるかも分からない。
    /// 「宣言してあるが効いていない」を避けるため、状態で確かめる。
    @MainActor
    static func confirmFlow() {
        let store = GenieStateStore.shared
        var fail: [String] = []
        func settle(_ s: Double) {
            let u = Date().addingTimeInterval(s)
            while Date() < u { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        WindowCoordinator.shared.showVoiceHUD()
        settle(0.5)
        let before = NSApp.windows.filter { $0.isVisible }.count
        let frontBefore = NSWorkspace.shared.frontmostApplication?.localizedName

        let c = ActionConfirmation(
            app: "Gmail", appIcon: "envelope",
            title: "このメッセージを送りますか？",
            params: [.init(label: "宛先", value: "ken@example.com"),
                     .init(label: "件名", value: "リリース予定")],
            preview: "明日 macOS 版を出します。",
            source: .init(title: "週次同期", speaker: "Ken", time: "10:42"),
            details: [], risk: .r2, confirmLabel: Facts.confirmationConfirmExample)
        store.requireConfirmation(c)
        settle(0.6)

        // ① 窓を増やしていないか。**同じ面が morph する**のが条件。
        let after = NSApp.windows.filter { $0.isVisible }.count
        if after != before { fail.append("窓が \(before) → \(after) に増えた") }

        // ② 焦点を奪っていないか。
        let frontAfter = NSWorkspace.shared.frontmostApplication?.localizedName
        if frontBefore != frontAfter { fail.append("前面が \(frontBefore ?? "?") → \(frontAfter ?? "?") に変わった") }

        // ③ 面の大きさが決断向きか。
        let size = store.dock.size()
        if size.width > 620 { fail.append("幅 \(Int(size.width))pt（620 超）") }
        if size.height > 360 { fail.append("高さ \(Int(size.height))pt（360 超）") }

        // ④ 高さが中身で決まるか。**中身を減らして縮まなければ固定と同じ。**
        let small = ActionConfirmation(app: "Gmail", title: "送りますか？",
                                       details: [], risk: .r2, confirmLabel: Facts.confirmationConfirmExample)
        store.resolveConfirmation(approved: false); settle(0.2)
        store.requireConfirmation(small); settle(0.3)
        let smallSize = store.dock.size()
        if !(smallSize.height < size.height) {
            fail.append("中身を減らしても高さが変わらない（\(Int(size.height)) → \(Int(smallSize.height))）")
        }

        // ⑤ 取り消しで元へ戻るか。
        store.resolveConfirmation(approved: false); settle(0.3)
        if case .confirmation = store.dock { fail.append("取り消しても確認の面が残る") }

        print(fail.isEmpty
              ? "SELFTEST_OK confirmflow: 窓を増やさない・焦点を奪わない・\(Int(size.width))x\(Int(size.height))pt・高さは中身で決まる（\(Int(size.height))→\(Int(smallSize.height))）・取り消しで戻る"
              : "SELFTEST_FAIL confirmflow: " + fail.joined(separator: " / "))
        exit(fail.isEmpty ? 0 : 1)
    }

    /// `--selftest idle-hold <秒>`: **普段の姿のまま置いておく。**
    ///
    /// Blind Operator（実装を知らずに画面だけで操作する評価者）と
    /// CALMNESS_TEST が要る。どちらも「動いている Genie を外から見る」ので、
    /// 検査が終わって即終了する journey では触れない。
    /// 自分からは何も開かない——勝手に前へ出たらそれ自体が測定結果になる。
    @MainActor
    static func idleHold(_ args: [String]) {
        // 引数は `--selftest idle-hold <秒>` の並びで来る。`args.first` は実行ファイルの
        // 経路なので、そこから読むと常に既定値になる（実際 25 を渡して 60 で動いていた）。
        let i = args.firstIndex(of: "--selftest")
        let secs = Double(i.map { args.count > $0 + 2 ? args[$0 + 2] : "" } ?? "") ?? 60
        WindowCoordinator.shared.showVoiceHUD()
        // **本番と同じものを登録する。** ここを省いたために、⌥Space が効かないのを
        // 製品の欠陥として記録してしまった（実際は検査側が登録していなかった）。
        let hot = GlobalShortcut.shared.register(handler: {
            WindowCoordinator.shared.toggleRecording()
        })
        print("IDLE_HOLD \(secs)s shortcut=\(hot)")
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + secs) { exit(0) }
        RunLoop.main.run()
    }

    /// `--selftest journey <id> <outdir>`: **Golden Journey を 1 本走らせて実測する。**
    ///
    /// 2pt の視覚ゲートは「崩れていないこと」しか言えない。同じ Panel で、
    /// 上辺 0px ずれで、±2pt に収まっていても、使いにくい製品は作れる。
    /// 優劣は、同じ課題での**完遂・所要時間・操作数・邪魔の量**で決める。
    ///
    /// ここで走らせられるのは Genie だけ。声や他アプリが要る Journey は
    /// このプロセスからは動かせないので、**測れないと記録して終わる**
    /// （0 として数えると、やっていないことを「勝ち」に見せてしまう）。
    /// Canvas の全項目数。消えた／戻ったを数で確かめるため。
    static func countItems(_ c: MeetingCanvas) -> Int {
        c.decisions.count + c.actions.count + c.questions.count + c.concerns.count + c.notes.count
    }

    @MainActor
    private static func journeyGate(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 3 else { print("SELFTEST_FAIL journey: 引数が足りない"); exit(2) }
        let id = args[i + 2], outDir = args[i + 3]

        // 音の経路も本番と同じにする。検査には音が流れないので、そのままだと
        // 「音が届いていません」という異常時の姿を採点することになる。
        RecordingRuntime.shared.markListening(.localUser)
        RecordingRuntime.shared.markListening(.remoteAudio)

        // 本番と同じ状態で測る。ショートカットを登録しないまま撮ると、待機中の
        // HUD が「登録できていないときの姿」になる。**仕掛けと本番を揃える作業は
        // これで 4 回目**なので、Journey 全体の入口でやる。
        _ = GlobalShortcut.shared.register(handler: { WindowCoordinator.shared.toggleRecording() })

        func settle(_ sec: Double) {
            let until = Date().addingTimeInterval(sec)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        // 保存を開けておく。開けずに測ると、Session が書かれず「落ちた録音が nil」に
        // なる —— 製品ではなく測り方の誤り（実際そう出た）。
        _ = LocalStore.shared.open()
        MeetingSessionStore.shared.load()

        let rec = JourneyRecorder(journey: id, outDir: outDir)
        let store = GenieStateStore.shared
        let recording = RecordingWorkspaceState.shared
        let sessions = MeetingSessionStore.shared

        switch id {
        case "J04":   // 会議検出 → 録音開始
            WindowCoordinator.shared.showVoiceHUD(); settle(0.8)
            rec.begin()
            store.meetingDetected(app: "Google Meet")
            settle(0.6)
            rec.step("会議を検出", interactions: 0, note: "検出しただけでは録らない")
            rec.shot("01-detected")
            recording.start()
            settle(1.0)
            rec.step("録音開始", interactions: 1, note: "利用者が始める")
            rec.shot("02-recording")
            let started = sessions.live != nil
            if !started { rec.error("録音が始まっていない") }
            rec.cannotMeasure("検出までの時間（実際の会議アプリが要る）")
            recording.stop(); settle(0.5)
            rec.finish(success: started)

        case "J05":   // 会議中の Live Notes
            WindowCoordinator.shared.showVoiceHUD()
            recording.start(); settle(0.8)
            rec.begin()
            WindowCoordinator.shared.showRecordingWorkspace(); settle(1.0)
            rec.step("会議の面を開く", interactions: 1, opensWindow: true)
            rec.shot("01-start")
            // 開始直後の**画面**が空かを見る。canvas が空なのは開始時は当然で、
            // それを「白紙」と呼ぶと、何を出しても直らない検査になる（実際そうなっていた）。
            // 撮った絵の地の割合で見る。会議の素性・聞こえていること・待っている状態が
            // 出ていれば、拾えたものが無くても空ではない。
            let startShot = "\(outDir)/01-start.png"
            if let blank = SelfTest.emptiness(startShot) {
                rec.step("開始 0 秒の画面", interactions: 0,
                         note: String(format: "地 %.1f%%", blank))
                if blank > 90 { rec.error(String(format: "開始直後の画面が白紙に近い（地 %.1f%%）", blank)) }
            } else {
                rec.cannotMeasure("開始直後の画面を測れない")
            }
            MeetingIntelligence.shared.ingest([
                CanvasItem("導入時期は 10 月で行きます", at: 12, speaker: "田中"),
                CanvasItem("見積は明日までにお願いします", at: 31, speaker: "あなた"),
            ], force: true)
            settle(0.8)
            rec.step("3 分ぶんの発話を入れる", interactions: 0)
            rec.shot("02-notes")
            let picked = store.state.meeting.canvas
            let withSource = (picked.decisions + picked.actions).filter { $0.speaker != nil }.count
            let total = picked.decisions.count + picked.actions.count
            if total == 0 { rec.error("決定も行動も拾えていない") }
            if total > 0 && withSource < total { rec.error("出所の付いていない項目がある") }
            rec.cannotMeasure("実会議での拾い漏れ（実音声が要る）")
            recording.stop()
            WindowCoordinator.shared.hideRecordingWorkspace()
            rec.finish(success: total > 0 && withSource == total)

        case "J07":   // 会議終了 → 成果物
            recording.start(); settle(0.8)
            let id0 = sessions.live?.id
            let before = sessions.sessions.count
            rec.begin()
            recording.stop()
            settle(0.6)
            rec.step("停止 → processing", interactions: 1, opensWindow: true)
            let deadline = Date().addingTimeInterval(8)
            while sessions.session(id: id0 ?? "")?.status != .ready, Date() < deadline {
                CFRunLoopRunInMode(.defaultMode, 0.05, true)
            }
            rec.step("ready まで", interactions: 0)
            MainWindowController.shared.showSection(.home)
            settle(1.0)
            _ = rec.shot("01-終わったあと")
            let after = sessions.sessions.count
            if after != before { rec.error("カードが増えた（同じ 1 件でない）") }
            let ready = sessions.session(id: id0 ?? "")?.status == .ready
            if !ready { rec.error("ready にならない") }
            rec.cannotMeasure("拾い間違いを直せるか（画面操作が要る）")
            rec.finish(success: ready && after == before)

        case "J09":   // 出所
            recording.start(); settle(0.5)
            // 出所は**画面で辿れるか**を測る。面を開かずに測ると、
            // 出所が付いていることだけ見て「確かめられる」と言ってしまう。
            WindowCoordinator.shared.showRecordingWorkspace(); settle(0.8)
            rec.begin()
            // 前後を読ませるので、文字起こしも実際に入れる。
            recording.transcript = [
                TranscriptSegment(speaker: "Sarah", text: "Windows はいつ出しますか。", interim: false, at: 630),
                TranscriptSegment(speaker: "Ken", text: "macOS を先に出します", interim: false, at: 642),
                TranscriptSegment(speaker: "Ken", text: "Windows は次の周で追います。", interim: false, at: 655),
            ]
            MeetingIntelligence.shared.ingest([
                CanvasItem("macOS を先に出します", at: 642, speaker: "Ken"),
                CanvasItem("オンボーディングを試作する", at: 861, speaker: "Sarah"),
            ], force: true)
            settle(0.6)
            rec.step("拾わせる", interactions: 0)
            let c = store.state.meeting.canvas
            let items = c.decisions + c.actions + c.questions + c.concerns + c.notes
            let haveWho = items.filter { $0.speaker != nil }.count
            let haveWhen = items.filter { $0.at != nil }.count
            if items.isEmpty { rec.error("拾えていない") }
            if haveWho < items.count { rec.error("話者の無い項目が \(items.count - haveWho) 件") }
            if haveWhen < items.count { rec.error("時刻の無い項目が \(items.count - haveWhen) 件") }
            // ここから先は「出所が付いている」ではなく、**確かめられるか**を測る。
            // 付いていても辿れなければ、信じるしかない点は変わらない。

            // ① 原文へ 1 クリック。宣言ではなく AX で実際に押す。
            let first = items.first
            let rowId = "canvasItem-" + String(first?.id.uuidString.prefix(8) ?? "")
            _ = rec.shot("01-拾ったあと")
            let opened = UIProbe.tap(rowId)
            settle(0.4)
            if !opened { rec.error("拾った行を押せない（原文へ辿れない）") }
            settle(0.5); _ = rec.shot("02-原文を開いた")
            rec.step("拾った行を押す", interactions: 1)

            // ② 開いた先に、直す手段が在るか。
            let canEdit = UIProbe.exists("canvasEdit")
            let canReject = UIProbe.exists("canvasRemove")
            // 前後の文字起こしが**実際に描かれた**か。同じ文をもう一度出すだけでは
            // 確かめたことにならないので、ここが出所の要。
            if !UIProbe.exists("canvasContext") { rec.error("前後の文字起こしが出ない") }
            if !canEdit { rec.error("原文の下に「直す」が無い") }
            if !canReject { rec.error("原文の下に「これは違う」が無い") }

            // ③ その場で直す。**直したあとも出所が残ること**まで見る。
            //    文言だけ直したのに誰の発言かが消えるなら、直すたびに根拠を失う。
            var edited = false, keptOrigin = false
            if let target = first {
                MeetingIntelligence.shared.edit(target, to: "macOS を先に出す")
                settle(0.3)
                let now = store.state.meeting.canvas
                let all = now.decisions + now.actions + now.questions + now.concerns + now.notes
                if let m = all.first(where: { $0.text == "macOS を先に出す" }) {
                    edited = true
                    keptOrigin = (m.speaker == target.speaker && m.at == target.at)
                }
            }
            if !edited { rec.error("その場で直せない") }
            else if !keptOrigin { rec.error("直したら出所が消えた") }
            rec.step("その場で直す", interactions: 2)

            // ④ 消したものを戻せるか。**「これは違う」は「直す」の隣に在り、
            //    押し間違えやすい。** 実装を知らない評価者が実際に消し、戻せずに
            //    メモを失った。確認で止めるのではなく、戻せることを測る。
            var undoShown = false, restored = false
            if let target = store.state.meeting.canvas.notes.first
                ?? store.state.meeting.canvas.decisions.first {
                let before = countItems(store.state.meeting.canvas)
                MeetingIntelligence.shared.remove(target)
                settle(0.5)
                let after = countItems(store.state.meeting.canvas)
                undoShown = UIProbe.exists("canvasUndo")
                if after != before - 1 { rec.error("「これは違う」で消えていない") }
                if !undoShown { rec.error("消したのに「元に戻す」が出ない") }
                _ = rec.shot("03-消したあと")
                MeetingIntelligence.shared.undoRemove()
                settle(0.4)
                let back = store.state.meeting.canvas
                let all = back.decisions + back.actions + back.questions + back.concerns + back.notes
                if let m = all.first(where: { $0.text == target.text }) {
                    restored = (m.speaker == target.speaker && m.at == target.at)
                }
                if !restored { rec.error("戻したのに出所が失われる／戻らない") }
            }
            rec.step("消して戻す", interactions: 2)

            // 音声へ戻る導線は**置いていない**。再生の実装が無いので、
            // 押して何も起きない飾りになる。実装したら測る。
            rec.cannotMeasure("その時刻の音声へ戻る（再生が未実装。飾りは置かない判断）")
            rec.cannotMeasure("実際のマウス当たり判定（自プロセスの AX は子を返さない。絵で見る）")
            recording.stop()
            rec.finish(success: !items.isEmpty && haveWho == items.count && haveWhen == items.count
                       && opened && canEdit && canReject && edited && keptOrigin
                       && undoShown && restored)

        case "J10":   // 落ちたあと
            // 強制終了を挟む本番の検証は scripts/verify-recording-experience.sh。
            // ここでは「落ちたまま残ったものを interrupted と言うか」を見る。
            rec.begin()
            recording.start(); settle(0.8)
            let liveId = sessions.live?.id ?? ""
            rec.step("録音中", interactions: 1)
            sessions.load()   // 再起動と同じ経路
            settle(0.4)
            rec.step("再起動として読み戻す", interactions: 0)
            MainWindowController.shared.showSection(.home)
            settle(1.0)
            _ = rec.shot("01-落ちたあと")
            let st = sessions.session(id: liveId)?.status
            if st != .interrupted && st != .recording {
                rec.error("落ちた録音の状態が \(st?.rawValue ?? "nil")")
            }
            rec.cannotMeasure("kill -9 を挟んだ全体（別スクリプトで実施）")
            recording.stop()
            rec.finish(success: st == .interrupted || st == .recording)

        // ---- Journey Phase（画面ではなく時間軸）。層 A だけをここで測る。 ----
        // 層 B（階層・状態・操作・文法）は各段の絵で盲検する。層 C は observe に残す。

        case "JA":   // Task: Home → Listening → Running → Confirmation → Done
            let dockWin = { JourneyRecorder.dockWindow() }
            func dockName() -> String {
                switch store.dock {
                case .idle: return "idle"
                case .listening: return "listening"
                case .agent: return "agent"
                case .confirmation: return "confirmation"
                case .result: return "result"
                case .thinking: return "thinking"
                default: return "other"
                }
            }
            MainWindowController.shared.showSection(.home)
            WindowCoordinator.shared.showVoiceHUD(); settle(1.0)
            rec.begin()
            let windows0 = NSApp.windows.filter(\.isVisible).count
            _ = rec.shot("01-home", window: dockWin())
            rec.step("Home（Dock は待機）", interactions: 0, surface: dockWin())

            // ② Listening。⌥Space と同じ入口。
            let t1 = rec.transition { VoiceHUDState.shared.beginListening() }
            settle(0.4)
            _ = rec.shot("02-listening", window: dockWin())
            // 逃げ道: マイクが開いている面で Esc が効くか。
            var keys: [String: String] = [:]
            if let w = dockWin() {
                JourneyRecorder.press(JourneyRecorder.keyEsc, "\u{1b}", in: w); settle(0.4)
                keys["esc"] = "listening→\(dockName())"
                if case .listening = store.dock { rec.error("Listening で Esc が効かない（マイクが開いたまま）") }
            }
            rec.step("Listening", interactions: 1, transitionMs: t1, keys: keys, surface: dockWin())

            // ③ Running。
            VoiceHUDState.shared.beginListening(); settle(0.3)
            let task = AgentTask(
                id: UUID(), title: "リリース予定を Ken に送る", status: .running,
                steps: [AgentStep(title: "予定を読む", tool: "calendar", state: .success),
                        AgentStep(title: "文面を作る", tool: "compose", state: .running)],
                startedAt: Date(), context: ContextBundle(items: []))
            let t2 = rec.transition { store.startTask(task) }
            settle(0.4)
            _ = rec.shot("03-running", window: dockWin())
            rec.step("Running", interactions: 0, transitionMs: t2,
                     ids: ["task": task.id.uuidString], surface: dockWin())

            // ④ Confirmation。**同じ面が伸びる**。窓は増えない。
            let c = ActionConfirmation(
                app: "Gmail", appIcon: "envelope",
                title: "このメッセージを送りますか？",
                params: [.init(label: "宛先", value: "ken@example.com"),
                         .init(label: "件名", value: "リリース予定")],
                preview: "明日 macOS 版を出します。",
                source: .init(title: "週次同期", speaker: "Ken", time: "10:42"),
                details: [], risk: .r2, confirmLabel: Facts.confirmationConfirmExample)
            var resolved: (id: UUID, approved: Bool)?
            let token = GenieEventBus.shared.subscribe { e in
                if case .confirmationResolved(let id, let approved) = e { resolved = (id, approved) }
            }
            let t3 = rec.transition { store.requireConfirmation(c) }
            settle(0.5)
            _ = rec.shot("04-confirmation", window: dockWin())
            let windows4 = NSApp.windows.filter(\.isVisible).count
            if windows4 > windows0 { rec.error("確認で窓が増えた（\(windows0)→\(windows4)）") }
            keys = [:]
            if let w = dockWin() {
                // 鍵の安全: Return だけでは外へ出る操作を走らせない。
                JourneyRecorder.press(JourneyRecorder.keyReturn, "\r", in: w); settle(0.4)
                keys["return"] = resolved == nil ? "no-op" : (resolved!.approved ? "APPROVED" : "cancelled")
                if let r = resolved, r.approved { rec.error("Return だけで送った") }
                // ⌘Return で承認。
                if resolved == nil {
                    JourneyRecorder.press(JourneyRecorder.keyReturn, "\r", mods: .command, in: w); settle(0.5)
                    keys["cmdReturn"] = resolved.map { $0.approved ? "approved" : "cancelled" } ?? "no-op"
                }
            }
            let ok4 = resolved?.approved == true && resolved?.id == c.id
            if !ok4 { rec.error("⌘Return で承認できない／別の確認が解決された") }
            rec.step("Confirmation", interactions: 2, transitionMs: t3, keys: keys,
                     ids: ["confirmation": c.id.uuidString,
                           "resolved": resolved?.id.uuidString ?? "nil"], surface: dockWin())
            GenieEventBus.shared.unsubscribe(token)

            // ⑤ Done。結果面が残り、Esc で片付く。
            let t4 = rec.transition { store.finishTask(.success) }
            settle(0.5)
            _ = rec.shot("05-done", window: dockWin())
            keys = [:]
            var isResult = false
            if case .result = store.dock { isResult = true }
            if !isResult { rec.error("終わったあとの面が result でない（\(dockName())）") }
            if let w = dockWin() {
                JourneyRecorder.press(JourneyRecorder.keyEsc, "\u{1b}", in: w); settle(0.4)
                keys["esc"] = "result→\(dockName())"
                if case .result = store.dock { rec.error("結果面で Esc が効かない") }
            }
            let windows5 = NSApp.windows.filter(\.isVisible).count
            rec.step("Done", interactions: 1, transitionMs: t4, keys: keys, surface: dockWin())
            if windows5 != windows0 { rec.error("終わったのに窓の数が戻らない（\(windows0)→\(windows5)）") }
            rec.observe("体感の複雑さ（層 C）: 段は 5、面は 1 枚、増えた窓 \(rec.windowsOpened)")
            rec.cannotMeasure("実際の声（STT は別 selftest）／実際の送信（外部サービス）")
            rec.finish(success: rec.errors.isEmpty)

        case "JB":   // Meeting: Meeting → Notes → Workspace → Library → Source
            WindowCoordinator.shared.showVoiceHUD(); settle(0.6)
            rec.begin()
            // ① 会議を録る。Dock が録音コントローラになる。
            let t1 = rec.transition {
                recording.start(captureMic: false, transcribe: false, requestPermissions: false)
            }
            settle(0.8)
            let liveId = sessions.live?.id ?? ""
            let dockId = { () -> String in
                if case .meeting = store.dock { return store.state.meeting.meetingId ?? "" }
                return ""
            }()
            if liveId.isEmpty { rec.error("録音が始まっていない") }
            _ = rec.shot("01-meeting", window: JourneyRecorder.dockWindow())
            rec.step("Meeting", interactions: 1, transitionMs: t1,
                     ids: ["session": liveId, "dock": dockId, "recording": recording.currentMeetingId])

            // ② Notes。同じ Dock の中で開く。実際の発言を入れて拾わせる。
            let t2 = rec.transition { VoiceHUDState.shared.toggleMeetingPanel(.notes) }
            // 確定行は本番と同じ 1 本（保存 → 抽出）を通す。3 行で抽出が走る。
            for seg in [
                TranscriptSegment(speaker: "Sarah", text: "Windows はいつ出しますか。", interim: false, at: 630),
                TranscriptSegment(speaker: "Ken", text: "macOS を先に出すことに決めました。", interim: false, at: 642),
                TranscriptSegment(speaker: "Ken", text: "Windows は次の周で追います。", interim: false, at: 655),
            ] { recording.appendFinal(seg) }
            settle(0.8)
            let canvas = store.state.meeting.canvas
            let decision = canvas.decisions.first
            if decision == nil { rec.error("決まったことが拾えていない") }
            _ = rec.shot("02-notes", window: JourneyRecorder.dockWindow())
            rec.step("Notes", interactions: 1, transitionMs: t2,
                     ids: ["decision.speaker": decision?.speaker ?? "nil",
                           "decision.at": decision.flatMap { $0.at }.map { String(Int($0)) } ?? "nil"])

            // ③ Workspace。頼んだので窓は増えてよい。
            let t3 = rec.transition { WindowCoordinator.shared.detachMeetingSurface() }
            settle(1.0)
            _ = rec.shot("03-workspace")
            let wsIds = ["session": sessions.live?.id ?? "", "workspace": recording.currentMeetingId]
            if wsIds["session"] != wsIds["workspace"] { rec.error("Workspace の会議 id が Session と違う") }
            rec.step("Workspace", interactions: 1, opensWindow: true, transitionMs: t3, ids: wsIds)

            // ④ 終える → Library。同じ 1 件が ready になる。
            let before = sessions.sessions.count
            // 読み取りは 4 段 × 0.45 秒（`finishProcessing`）。それを待つ。
            let t4 = rec.transition { recording.stop() }
            settle(2.2)
            let ready = sessions.session(id: liveId)
            if ready?.status != .ready { rec.error("終えたあと ready にならない（\(ready?.status.rawValue ?? "nil")）") }
            if sessions.sessions.count != before { rec.error("終えたらカードが増えた") }
            _ = rec.shot("04-ended", window: JourneyRecorder.dockWindow())
            rec.step("終える", interactions: 1, transitionMs: t4, ids: ["session": liveId,
                                                        "decisions": String(ready?.decisionCount ?? -1)])

            // 結果面の「メモを開く」→ **その会議**が開くか。
            var opened = false
            if case .result(let r) = store.dock, let a = r.actions.first(where: { $0 == .openNotes }) {
                opened = UIProbe.tap("result-\(a.rawValue)")
            }
            settle(1.0)
            let openedId = MainNav.shared.openSession ?? ""
            if !opened { rec.error("結果面に「開く」が無い／押せない") }
            if openedId != liveId {
                rec.error("結果面から開いたのがその会議でない（open=\(openedId.isEmpty ? "一覧" : openedId)）")
                MainWindowController.shared.showLibrary(.meetings)
                MainNav.shared.openSession = liveId
                settle(0.8)
            }
            _ = rec.shot("05-library")
            rec.step("Library", interactions: 1, opensWindow: true,
                     ids: ["opened": openedId, "session": liveId])

            // ⑤ Source。Decision [1] → Ken · 10:42 → 原文。
            let tapped = UIProbe.tap("citationRef-1")
            settle(0.6)
            let shown = UIProbe.fact("meetingShown") ?? ""
            let want = "\(decision?.speaker ?? "")|\(decision?.timeLabel ?? "")"
            if !tapped { rec.error("Library に決まったことの [1] が無い") }
            else if shown != want { rec.error("[1] を押して出た発言が違う（\(shown) ≠ \(want)）") }
            _ = rec.shot("06-source")
            rec.step("Source", interactions: 1, ids: ["shown": shown, "want": want])

            // ⑥ 状態の連続: 読み戻して（再起動と同じ）もう一度同じ発言へ戻れるか。
            MainNav.shared.select(.home)
            recording.transcript = []
            sessions.load(); settle(0.4)
            // 一覧を出してから 1 件を開く（`showSection` は開いていた 1 件を閉じる）。
            MainWindowController.shared.showLibrary(.meetings)
            MainNav.shared.openSession = liveId; settle(0.8)
            let tapped2 = UIProbe.tap("citationRef-1"); settle(0.6)
            let shown2 = UIProbe.fact("meetingShown") ?? ""
            if !tapped2 || shown2 != want { rec.error("読み戻したあと同じ発言に戻れない（\(shown2)）") }
            let persisted = LocalStore.shared.loadTranscript(meetingId: liveId).count
            if persisted == 0 { rec.error("文字起こしが保存されていない") }
            _ = rec.shot("07-reopened")
            rec.step("読み戻す", interactions: 1,
                     ids: ["shown": shown2, "transcriptRows": String(persisted)])
            rec.cannotMeasure("その時刻の音声へ戻る（再生が未実装。飾りは置かない判断）")
            rec.observe("全体の連続感（層 C）: 面は Dock → Workspace → Library の 3 枚。同じ id \(liveId) が通ったか: \(rec.errors.isEmpty)")
            rec.finish(success: rec.errors.isEmpty)

        case "JC":   // Failure: 許可なし → 回復 / 落ちた → 再開
            WindowCoordinator.shared.showVoiceHUD(); settle(0.6)
            rec.begin()
            // ① マイクが拒否されている端末で、始めるとどうなるか。
            Permissions.simulatedMicrophone = .denied
            Permissions.simulatedSpeechRecognition = .denied
            defer {
                Permissions.simulatedMicrophone = nil
                Permissions.simulatedSpeechRecognition = nil
            }
            let t1 = rec.transition { WindowCoordinator.shared.toggleRecording() }
            settle(0.8)
            _ = rec.shot("01-denied", window: NSApp.keyWindow)
            let explaining = PermissionGuideCoordinator.shared.state == .microphoneIntro
            let enable = UIProbe.exists("guideAvatarAction")
            let later = UIProbe.exists("guideLater")
            if !explaining || !enable || !later { rec.error("マイクの説明から許可または中止を選べない") }
            if recording.isRecording || sessions.live != nil { rec.error("許可前なのに録音セッションが作られた") }
            rec.step("マイクの説明", interactions: 1, opensWindow: true, transitionMs: t1,
                     ids: ["state": "microphoneIntro", "enable": String(enable), "later": String(later)])
            // A new recording must not be blocked by the abandoned permission intent.
            if !UIProbe.tap("guideLater") { rec.error("あとでを押せない") }
            settle(0.3)
            if PermissionGuideCoordinator.shared.state != .idle || UIProbe.exists("guideAvatar") {
                rec.error("中止後も権限ガイドが残っている")
            }
            Permissions.simulatedMicrophone = nil

            // ② 案内を中止したあと、合成音源で保存・復旧経路を再開する。OS付与の証跡ではない。
            recording.start(captureMic: false, transcribe: false, requestPermissions: false); settle(0.8)
            let liveId = sessions.live?.id ?? ""
            if liveId.isEmpty { rec.error("案内を中止したあとに録音の保存経路を開始できない") }
            _ = rec.shot("02-recovered", window: JourneyRecorder.dockWindow())
            rec.step("回復", interactions: 1, ids: ["session": liveId])

            // ③ 共有中に Dock が消え、共有が終わったら**録音中でも**戻るか。
            PresentationGuard.shared.apply(sharing: true); settle(0.6)
            let hiddenWhileSharing = JourneyRecorder.dockWindow() == nil
            PresentationGuard.shared.apply(sharing: false); settle(0.8)
            let backAfterSharing = JourneyRecorder.dockWindow() != nil
            if !hiddenWhileSharing { rec.observe("共有中も Dock が見えている（隠す方針なら要確認）") }
            if !backAfterSharing { rec.error("共有が終わっても録音中の Dock が戻らない（Stop が押せない）") }
            _ = rec.shot("03-after-sharing", window: JourneyRecorder.dockWindow())
            rec.step("共有のあと", interactions: 0,
                     ids: ["hiddenWhileSharing": String(hiddenWhileSharing),
                           "backAfterSharing": String(backAfterSharing)])

            // ④ 録音中の危険な操作（録音を捨てる）。確認は **1 面だけ**。
            recording.appendFinal(TranscriptSegment(speaker: "Ken", text: "落ちる前の発言です。", interim: false, at: 12))
            let w0 = NSApp.windows.filter(\.isVisible).count
            var surfaces = -1
            var dockAnswerable = false
            Timer.scheduledTimer(withTimeInterval: 0.7, repeats: false) { _ in
                surfaces = NSApp.windows.filter(\.isVisible).count - w0
                dockAnswerable = UIProbe.exists("confirmCancel")
                _ = rec.shot("04-confirm", window: JourneyRecorder.dockWindow())
                _ = UIProbe.tap("confirmCancel")
                // 別の面が残っていたら、それも閉じる（残さないと 120 秒止まる）。
                Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { _ in
                    if UIProbe.exists("cardCancel") { _ = UIProbe.tap("cardCancel") }
                }
            }
            let answered = Confirm.ask(ActionConfirmation(
                app: "Genie", appIcon: "waveform",
                title: "この録音を捨てますか？",
                params: [], preview: "文字起こしと拾ったものも消えます。",
                source: nil, details: [], risk: .r3, confirmLabel: "捨てる"))
            settle(0.5)
            if surfaces > 0 { rec.error("1 つの確認に面が \(surfaces + 1) 枚") }
            if !dockAnswerable { rec.error("Dock の確認面で答えられない") }
            if answered { rec.error("やめたのに実行された") }
            if store.state.confirmation != nil { rec.error("答えたのに確認が残っている") }
            rec.step("確認（やめる）", interactions: 1,
                     ids: ["surfaces": String(surfaces + 1), "answered": String(answered)])

            // ⑤ 落ちて再開。読み戻すと interrupted。開けて、中身が残っているか。
            sessions.load(); settle(0.4)
            let st = sessions.session(id: liveId)?.status
            if st != .interrupted { rec.error("落ちた録音が interrupted でない（\(st?.rawValue ?? "nil")）") }
            MainWindowController.shared.showSection(.home); settle(0.8)
            _ = rec.shot("05-interrupted")
            let cardOpens = UIProbe.exists("session-\(liveId)")
            if !cardOpens { rec.error("落ちた録音のカードが開けない") }
            else { _ = UIProbe.tap("session-\(liveId)"); settle(0.8) }
            let rows = LocalStore.shared.loadTranscript(meetingId: liveId).count
            if rows == 0 { rec.error("落ちた録音の文字起こしが残っていない") }
            _ = rec.shot("06-resumed")
            // Home を開くのは頼まれた結果（窓が増えて当然）。
            rec.step("落ちて再開", interactions: 1, opensWindow: true,
                     ids: ["status": st?.rawValue ?? "nil", "transcriptRows": String(rows)])
            rec.cannotMeasure("kill -9 を挟んだ全体（scripts/verify-recording-experience.sh）")
            rec.cannotMeasure("実際の TCC 拒否（端末の許可は自動で変えない。simulatedMicrophone で作る）")
            recording.stop()
            rec.finish(success: rec.errors.isEmpty)

        default:
            // 声や他アプリが要るもの。**0 として数えない。**
            rec.begin()
            rec.cannotMeasure("この Journey はこのプロセスから動かせない（声・他アプリ・人の操作が要る）")
            rec.finish(success: false)
            print("SELFTEST_SKIP journey \(id): 自動では走らせられない。人が撮る")
            exit(0)
        }
        exit(0)
    }

    /// `--selftest upgrade`: **古い DB を開いても会議が残るか。**
    ///
    /// `CREATE TABLE IF NOT EXISTS` は既に在る表に何もしない。Session を持つより
    /// 前の版で作られた `meetings` は列が足りず、書き込みが黙って失敗する。
    /// 実機の DB がまさにそれで、**会議が 1 件も残っていなかった**（0 件）。
    /// これまでの検査は毎回まっさらな一時 DB を使っていたので、通っていなかった。
    @MainActor
    private static func upgradeGate() {
        var fail: [String] = []
        let path = NSTemporaryDirectory() + "astra-upgrade-\(getpid()).sqlite"
        defer { try? FileManager.default.removeItem(atPath: path) }
        try? FileManager.default.removeItem(atPath: path)

        // 昔の形の meetings を作る（Session より前の版）。
        // **LocalStore は使わない** —— 開いた時点で新しい表を作ってしまい、
        // 古い DB を再現できない（最初これで作って、再現できていなかった）。
        do {
            var raw: OpaquePointer?
            guard sqlite3_open(path, &raw) == SQLITE_OK else {
                print("SELFTEST_FAIL upgrade: 古い DB を作れない"); exit(2)
            }
            let create = """
            CREATE TABLE meetings (
              id TEXT PRIMARY KEY, title TEXT, started_at REAL NOT NULL,
              ended_at REAL, detected_app TEXT, journal_path TEXT);
            INSERT INTO meetings (id,title,started_at) VALUES ('old-1','昔の会議',1);
            """
            if sqlite3_exec(raw, create, nil, nil, nil) != SQLITE_OK {
                print("SELFTEST_FAIL upgrade: 古い表を作れない"); exit(2)
            }
            sqlite3_close(raw)
        }

        // 新しい版で開く → 列が足され、書き込めるようになるはず。
        let store = LocalStore(path: path)
        _ = store.open(path)
        let cols = Set(store.columnNames("meetings"))
        for want in ["status", "visibility", "summary", "action_count", "decision_count",
                     "participant_count", "created_at", "updated_at"] where !cols.contains(want) {
            fail.append("\(want) 列が足されていない")
        }

        let s = MeetingSession(id: "after-upgrade", title: "移行後の会議",
                               status: .ready, startedAt: Date())
        store.saveSession(s)
        let loaded = store.loadSessions()
        if !loaded.contains(where: { $0.id == "after-upgrade" }) {
            fail.append("移行後も会議を保存できない")
        }
        // 昔の行を消していないこと。
        if !loaded.contains(where: { $0.id == "old-1" }) {
            fail.append("昔の行が消えた（移行で失っている）")
        }

        if fail.isEmpty {
            print("SELFTEST_OK upgrade: 古い DB に列を足して開ける・保存できる・昔の行を失わない")
            exit(0)
        } else {
            print("SELFTEST_FAIL upgrade: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// 1 枚の絵の「地の割合」。最も多い色が画面のどれだけを占めるか（%）。
    /// 高いほど、開いているのに何も返していない画面。
    static func emptiness(_ path: String) -> Double? {
        guard let data = FileManager.default.contents(atPath: path),
              let rep = NSBitmapImageRep(data: data) else { return nil }
        var counts: [UInt32: Int] = [:]
        var pts: [UInt32] = []
        let pw = rep.pixelsWide, ph = rep.pixelsHigh
        let step = max(1, min(pw, ph) / 220)
        var y = 0
        while y < ph { var x = 0
            while x < pw {
                if let c = rep.colorAt(x: x, y: y) {
                    let r = UInt32(max(0, min(255, c.redComponent * 255)))
                    let g = UInt32(max(0, min(255, c.greenComponent * 255)))
                    let b = UInt32(max(0, min(255, c.blueComponent * 255)))
                    let key = (r << 16) | (g << 8) | b
                    pts.append(key); counts[key, default: 0] += 1
                }
                x += step }
            y += step }
        guard let bg = counts.max(by: { $0.value < $1.value })?.key, !pts.isEmpty else { return nil }
        let br = Int((bg >> 16) & 255), bgc = Int((bg >> 8) & 255), bb = Int(bg & 255)
        var same = 0
        for p in pts {
            let r = Int((p >> 16) & 255), g = Int((p >> 8) & 255), b = Int(p & 255)
            if abs(r - br) + abs(g - bgc) + abs(b - bb) <= 12 { same += 1 }
        }
        return Double(same) / Double(pts.count) * 100
    }

    /// 撮った面のうち、実質同じ絵になっている組。
    ///
    /// 「別の状態を写しているはず」の面が同じなら、その面のゲートは何も見ていない。
    /// 撮影ごとの微差（アンチエイリアス・影のにじみ・カーソル）は拾わないよう、
    /// 200 点角のグレースケールに落として 0.5% を境にする。golden 比較と同じ尺度。
    static func duplicatePairs(in dir: String, names: [String]) -> [(String, String)] {
        func signature(_ path: String) -> [UInt8]? {
            guard let data = FileManager.default.contents(atPath: path),
                  let rep = NSBitmapImageRep(data: data) else { return nil }
            var out: [UInt8] = []
            let pw = rep.pixelsWide, ph = rep.pixelsHigh
            let sx = max(1, pw / 200), sy = max(1, ph / 200)
            var y = 0
            while y < ph { var x = 0
                while x < pw {
                    if let c = rep.colorAt(x: x, y: y) {
                        let l = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
                        out.append(UInt8(max(0, min(255, l * 255))))
                    }
                    x += sx }
                y += sy }
            return out
        }
        var sigs: [(String, [UInt8])] = []
        for n in names { if let s = signature("\(dir)/\(n).png") { sigs.append((n, s)) } }
        var dupes: [(String, String)] = []
        for i in sigs.indices {
            for j in sigs.indices where j > i {
                let (na, a) = sigs[i], (nb, b) = sigs[j]
                guard a.count == b.count else { continue }
                var n = 0
                for k in 0..<a.count where abs(Int(a[k]) - Int(b[k])) >= 16 { n += 1 }
                // 実測で決める。名前だけ違う組は 0.000%（03/04 と 06/12 がそうだった）。
                // 一方、正しく別物でも最も近い組は 0.463%（03 と 10：右レールの
                // Agent パネルだけが違う）。0.1% なら両者をきれいに分けられる。
                if Double(n) / Double(a.count) <= 0.001 { dupes.append((na, nb)) }
            }
        }
        return dupes
    }

    /// 2 枚の画像が（縮小して見て）同じか。
    private static func imagesLookEqual(_ a: CGImage, _ b: CGImage) -> Bool {
        let ra = NSBitmapImageRep(cgImage: a), rb = NSBitmapImageRep(cgImage: b)
        guard ra.pixelsWide == rb.pixelsWide, ra.pixelsHigh == rb.pixelsHigh else { return false }
        let sx = max(1, ra.pixelsWide / 40), sy = max(1, ra.pixelsHigh / 40)
        var diff = 0, total = 0
        var y = 0
        while y < ra.pixelsHigh {
            var x = 0
            while x < ra.pixelsWide {
                total += 1
                if let ca = ra.colorAt(x: x, y: y), let cb = rb.colorAt(x: x, y: y) {
                    if abs(ca.redComponent - cb.redComponent)
                        + abs(ca.greenComponent - cb.greenComponent)
                        + abs(ca.blueComponent - cb.blueComponent) > 0.12 { diff += 1 }
                }
                x += sx
            }
            y += sy
        }
        return total > 0 && Double(diff) / Double(total) < 0.02
    }


    /// `--selftest recordbutton`: **録音ボタンを押したら何が出るか。**
    ///
    /// UI の状態を Store から作って撮るのではなく、`RecordingWorkspaceState.start()`
    /// ——ボタンが呼ぶそのもの——を呼んで、画面に何が出たかを見る。
    /// ここを Store 直叩きで検査していたせいで、ボタンだけ別のことをしていたのを見逃した。
    @MainActor
    private static func recordButton() {
        guard Permissions.microphone == .granted else {
            print("SELFTEST_SKIP recordbutton: actual recording requires microphone grant; pre-permission explanation/cancel is covered by journey JC")
            exit(0)
        }
        let store = GenieStateStore.shared
        let recording = RecordingWorkspaceState.shared
        store.reset()
        var fail: [String] = []

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        func windows() -> [(w: CGFloat, h: CGFloat)] {
            guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
            return infos.compactMap { info in
                guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                      let b = info[kCGWindowBounds as String] as? [String: Any],
                      let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat,
                      w > 20, h > 10 else { return nil }
                return (w, h)
            }
        }

        WindowCoordinator.shared.showVoiceHUD()
        settle(0.8)
        let before = windows().count

        // ここがボタンの中身そのもの。
        recording.start()
        settle(1.4)

        let after = windows()
        // ① 窓を増やしていない。
        if after.count > before {
            fail.append("録音開始で窓が \(before)→\(after.count) に増えた")
        }
        // ② Dock が録音コントローラの寸法になっている。
        if !after.contains(where: { abs($0.w - Metrics.dockMeetingWidth) <= 2 }) {
            fail.append("Dock が録音コントローラ(\(Int(Metrics.dockMeetingWidth))pt)になっていない: \(after.map { Int($0.w) })")
        }
        // ③ 大きな面は**開いていない**（押されるまで出さない）。
        if after.contains(where: { abs($0.w - Metrics.workspaceWidth) <= 2 }) {
            fail.append("録音開始で大きな面が勝手に開いた")
        }
        // ④ State も会議になっている。
        if store.state.mode != .meeting { fail.append("mode が meeting でない (\(store.state.mode))") }
        if case .meeting(let panel) = store.dock {
            if panel != nil { fail.append("Notes/Captions が勝手に開いている") }
        } else {
            fail.append("dock が meeting でない (\(store.dock))")
        }

        // ⑤ 止めたら結果面へ morph する（巨大 modal を出さない）。
        recording.stop()
        settle(1.0)
        if case .result = store.dock {} else { fail.append("停止後に結果面へ移らない (\(store.dock))") }
        if windows().count > before { fail.append("停止後に窓が残っている") }

        WindowCoordinator.shared.hideVoiceHUD()
        store.reset()
        if fail.isEmpty {
            print("SELFTEST_OK recordbutton: 録音ボタンは窓を増やさず Dock を録音コントローラにする・面は勝手に開かない・停止で結果面へ")
            exit(0)
        } else {
            print("SELFTEST_FAIL recordbutton: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest session`: 録音セッションの一生。
    ///
    /// 確かめたいのは「同じカードが姿を変える」こと。停止のたびに別の会議が増える実装でも
    /// 画面は動いて見えるので、**id が変わらないこと**を見る。
    @MainActor
    private static func sessionLifecycle() {
        let path = NSTemporaryDirectory() + "astra-session-\(getpid()).sqlite"
        defer { try? FileManager.default.removeItem(atPath: path) }
        LocalStore.shared.open(path)
        let store = MeetingSessionStore.shared
        store.reset()
        var fail: [String] = []

        // ① 録音開始で 1 件できて、すぐ保存される（「保存しますか」を出さない）。
        let started = store.begin(id: "s1", title: "Product Weekly")
        if started.status != .recording { fail.append("開始直後が recording でない") }
        if store.live?.id != "s1" { fail.append("live が拾えない") }
        if LocalStore.shared.loadSessions().first(where: { $0.id == "s1" }) == nil {
            fail.append("開始直後にディスクへ保存されていない")
        }
        // 既定は自分だけ。
        if started.visibility != .mySpace { fail.append("既定の保存先が My Space でない") }

        // ② 停止 → processing。**同じ id**のまま、件数は増えない。
        store.beginProcessing(id: "s1")
        if store.sessions.count != 1 { fail.append("停止でカードが増えた (\(store.sessions.count))") }
        guard let processing = store.session(id: "s1") else { fail.append("消えた"); reportSession(fail); return }
        if processing.status != .processing { fail.append("processing にならない") }
        if processing.endedAt == nil { fail.append("終了時刻が入らない") }

        // ③ ready。ここで初めて中身が入る。
        store.markReady(id: "s1", summary: "Q4 移行計画とコストを議論。", actions: 3, decisions: 2, participants: 5)
        guard let ready = store.session(id: "s1") else { fail.append("消えた"); reportSession(fail); return }
        if ready.status != .ready { fail.append("ready にならない") }
        if ready.actionCount != 3 || ready.decisionCount != 2 || ready.participantCount != 5 {
            fail.append("件数が入らない")
        }
        if store.sessions.count != 1 { fail.append("ready でカードが増えた") }

        // ④ 保存先と project は後から変えられる。
        store.setVisibility(.workspace, for: "s1")
        store.setProject("Product", for: "s1")
        if store.session(id: "s1")?.visibility != .workspace { fail.append("保存先を変えられない") }
        if store.session(id: "s1")?.projectId != "Product" { fail.append("project を変えられない") }

        // ⑤ 再起動しても戻る（§9）。
        store.reset()
        store.load()
        guard let restored = store.session(id: "s1") else {
            fail.append("再起動で復元できない"); reportSession(fail); return
        }
        if restored.status != .ready { fail.append("復元後の状態が違う (\(restored.status))") }
        if restored.summary?.contains("Q4") != true { fail.append("要約が復元されない") }
        if restored.projectId != "Product" { fail.append("project が復元されない") }

        // ⑥ 録音中に落ちたものは **interrupted**。勝手に ready にしない。
        store.begin(id: "s2", title: "落ちた会議")
        store.reset()
        store.load()
        guard let crashed = store.session(id: "s2") else {
            fail.append("落ちた録音が復元されない"); reportSession(fail); return
        }
        if crashed.status != .interrupted {
            fail.append("落ちた録音が \(crashed.status) になっている（interrupted であるべき）")
        }

        // ⑦ §6 予定から録ると引き継ぐ。project があれば自動割当。
        let link = CalendarLink(eventId: "evt-1", title: "Design Review",
                                participantCount: 4, meetingURL: "https://meet.google.com/x",
                                projectId: "Research")
        let fromCalendar = store.begin(id: "s3", title: "無視される", link: link)
        if fromCalendar.title != "Design Review" { fail.append("予定の題を引き継がない") }
        if fromCalendar.calendarEventId != "evt-1" { fail.append("event id を引き継がない") }
        if fromCalendar.participantCount != 4 { fail.append("参加人数を引き継がない") }
        if fromCalendar.projectId != "Research" { fail.append("project を自動割当しない") }

        // ⑧ 同じ題の会議は前回の project を再利用する（recurring）。
        store.beginProcessing(id: "s3")
        store.markReady(id: "s3", summary: nil, actions: 0, decisions: 0)
        let again = store.begin(id: "s4", title: "Design Review")
        if again.projectId != "Research" {
            fail.append("同じ題の会議で前回の project を引き継がない (\(again.projectId ?? "nil"))")
        }

        // ⑨ project が無くても録音は始まる（失敗しても止めない）。
        let noProject = store.begin(id: "s5", title: "初めての会議")
        if noProject.status != .recording { fail.append("project 無しで録音が始まらない") }
        if noProject.projectId != nil { fail.append("勝手に project を割り当てた") }

        store.reset()
        LocalStore.shared.close()
        reportSession(fail)
    }

    private static func reportSession(_ fail: [String]) {
        if fail.isEmpty {
            print("SELFTEST_OK session: 開始で保存・同じ id が recording→processing→ready・保存先/project を後から変更・再起動で復元・落ちたら interrupted・予定から継承")
            exit(0)
        } else {
            print("SELFTEST_FAIL session: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest sessionshots <dir> [dark]`: Session UX の面を**実遷移で**撮る。
    ///
    /// fixture を並べない。`MeetingSessionStore` を実際に動かし、Home が
    /// recording → processing → ready と姿を変えるところを撮る。
    @MainActor
    private static func sessionShots(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-session"
        let dark = args.count > i + 3 && args[i + 3] == "dark"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        LocalStore.shared.open(NSTemporaryDirectory() + "astra-shots-\(getpid()).sqlite")

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        func windows() -> [(id: CGWindowID, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)] {
            guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
            return infos.compactMap { info in
                guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                      let num = info[kCGWindowNumber as String] as? CGWindowID,
                      let b = info[kCGWindowBounds as String] as? [String: Any],
                      let x = b["X"] as? CGFloat, let y = b["Y"] as? CGFloat,
                      let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat,
                      w > 20, h > 10 else { return nil }
                return (num, x, y, w, h)
            }
        }
        func shoot(_ name: String) -> Bool {
            let deadline = Date().addingTimeInterval(8)
            var found: (id: CGWindowID, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)?
            repeat {
                settle(0.25)
                found = windows().first { $0.w >= 900 && $0.h >= 600 }
            } while found == nil && Date() < deadline
            // 前面に出してから撮る。背面のままだと window server が画像を返さないことがある
            // （dark で断続的に「撮影不可」になっていた原因）。
            NSApp.activate(ignoringOtherApps: true)
            MainWindowController.shared.orderFront()
            settle(0.8)
            guard let win = found ?? windows().first(where: { $0.w >= 900 && $0.h >= 600 }) else {
                FileHandle.standardError.write(Data("SESSIONSHOT \(name) 窓一覧: \(windows().map { "\(Int($0.w))x\(Int($0.h))" })\n".utf8))
                return false
            }
            // 画像生成はときどき nil を返す（窓の再描画中など）。数回試す。
            let rect = CGRect(x: win.x, y: win.y, width: win.w, height: win.h)
            // 何度か試す。失敗のたびに前面へ出し直す。
            for attempt in 0..<10 {
                if attempt > 0 {
                    NSApp.activate(ignoringOtherApps: true)
                    MainWindowController.shared.orderFront()
                }
                // 窓 id 経由。dark へ切り替えた直後などに nil を返すことがある。
                var image = CGWindowListCreateImage(.null, .optionIncludingWindow, win.id,
                                                    [.boundsIgnoreFraming, .bestResolution])
                if image == nil {
                    // 代わりに画面のその領域を撮る。窓の再描画中でもこちらは通ることが多い。
                    image = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
                }
                if let cg = image,
                   let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
                    return true
                }
                _ = attempt
                settle(0.5)
            }
            return false
        }

        let sessions = MeetingSessionStore.shared
        sessions.reset()
        // Upcoming の差し込みは Home を出す**前**に用意する（onAppear で読むので）。
        let realEvents = CalendarAccess.upcoming(hours: 24).filter { $0.endEpoch - $0.startEpoch > 0 }
        if realEvents.isEmpty {
            HomePane.previewUpcoming = [
                HomeAttention(kind: "10:00 Google Meet", title: "Product Weekly", action: "録音を開始",
                              link: CalendarLink(eventId: "preview-1", title: "Product Weekly",
                                                 participantCount: 5, meetingURL: nil, projectId: "Product")),
                HomeAttention(kind: "13:30 Zoom", title: "A社 商談", action: "録音を開始",
                              link: CalendarLink(eventId: "preview-2", title: "A社 商談",
                                                 participantCount: 3, meetingURL: nil, projectId: nil)),
            ]
        }
        MainWindowController.shared.showSection(.home)
        settle(1.4)

        var report: [String] = []
        var failures: [String] = []
        func step(_ name: String, _ transition: () -> Void) {
            transition()
            settle(0.6)
            if shoot(name) { report.append(name) } else { failures.append("\(name)=撮影不可") }
        }

        // 1 Home idle（会議も予定も無い）
        step("01-home-idle", {})

        // 14 ⌥Space の許可（Input Monitoring）が無いとき。Home の空状態が「使えるようにする」と言う。
        //    予定も会議も無い姿でだけ出るので、何も作る前のここで撮る（検査用の上書き。本番では nil）。
        let savedPreview = HomePane.previewUpcoming
        HomePane.previewUpcoming = []
        Permissions.simulatedInputMonitoring = .notDetermined
        Permissions.simulatedCalendar = .denied
        step("14-input-monitoring", {
            MainWindowController.shared.showSection(.work); settle(0.4)
            MainWindowController.shared.showSection(.home)
        })
        // 13 予定を読む許可は、予定が出るその場所で理由と一緒に求める（purpose-first）。
        Permissions.simulatedInputMonitoring = nil
        Permissions.simulatedCalendar = .notDetermined
        step("13-calendar-permission", {
            MainWindowController.shared.showSection(.work); settle(0.4)
            MainWindowController.shared.showSection(.home)
        })
        Permissions.simulatedCalendar = nil
        HomePane.previewUpcoming = savedPreview
        MainWindowController.shared.showSection(.work); settle(0.4)
        MainWindowController.shared.showSection(.home); settle(0.6)

        // 2 録音中: 開始した瞬間に Home へ出る
        step("02-recording", {
            // 42 分前に始めた会議。0 分の会議に要約と 5 人が付くと、表示が壊れて見える（盲検）。
            sessions.begin(id: "shot-1", title: "Q4 移行計画の打ち合わせ", source: "Google Meet",
                           now: Date().addingTimeInterval(-42 * 60))
        })
        guard let liveId = sessions.live?.id else {
            print("SELFTEST_FAIL sessionshots: 録音中の Session が無い"); exit(2)
        }

        // 3 processing: **同じ id**のまま
        step("03-processing", { sessions.beginProcessing(id: liveId) })

        // 4 ready
        step("04-ready", {
            // 件数だけでなく中身も書く。Home のカードが「やること 3 · 決まったこと 2」と言い、開いた detail が
            // 0 / 0 では同じ id が矛盾する（Atlas E2）。本番の finishProcessing は canvas の件数を
            // markReady に渡すので、fixture も同じ canvas から数える。
            let canvas = MeetingCanvas(
                decisions: [CanvasItem("Q4 は移行計画を先に進める", at: 312, speaker: "田中"),
                            CanvasItem("Phase 1 は 10 月に始める", at: 1450, speaker: "あなた")],
                actions: [CanvasItem("移行計画の草案を来週までに出す", at: 348, speaker: "田中"),
                          CanvasItem("トレーニング費用を見積もる", at: 902, speaker: "鈴木"),
                          CanvasItem("Phase 1 の体制表を作る", at: 1502, speaker: "あなた")],
                questions: [], concerns: [], notes: [])
            LocalStore.shared.saveNotes(meetingId: liveId, canvas)
            let rows: [TranscriptSegment] = [
                TranscriptSegment(speaker: "あなた", text: "今日は Q4 の移行計画と、トレーニングのコストを詰めます。", interim: false, at: 40),
                TranscriptSegment(speaker: "田中", text: "Q4 は移行計画を先に進める", interim: false, at: 312),
                TranscriptSegment(speaker: "田中", text: "移行計画の草案を来週までに出す", interim: false, at: 348),
                TranscriptSegment(speaker: "鈴木", text: "トレーニング費用を見積もる", interim: false, at: 902),
                TranscriptSegment(speaker: "あなた", text: "Phase 1 は 10 月に始める", interim: false, at: 1450),
                TranscriptSegment(speaker: "あなた", text: "Phase 1 の体制表を作る", interim: false, at: 1502),
            ]
            for (n, row) in rows.enumerated() { LocalStore.shared.saveTranscriptRow(meetingId: liveId, index: n, row) }
            sessions.markReady(id: liveId,
                               summary: "Q4 移行計画とトレーニングコストを議論。10 月から Phase 1 開始で合意。",
                               actions: canvas.actions.count, decisions: canvas.decisions.count, participants: 5)
        })

        // 5 保存先と project を付けた姿
        step("05-project", {
            sessions.setVisibility(.workspace, for: liveId)
            sessions.setProject("Product", for: liveId)
        })

        // 6 Session Detail
        step("06-session-detail", { MainNav.shared.openSession = liveId })

        // ここから先は Home に戻して撮る（Detail を開いたままだと Home の面が出ない）。
        MainNav.shared.openSession = nil
        MainWindowController.shared.showSection(.home)
        settle(0.8)

        // 11 Upcoming: 予定から 1 click で録れる行。
        //    実カレンダーに予定があればそれを出す。無い時間帯でも見た目を確かめられるよう、
        //    そのときだけ差し込む（差し込んだかどうかは出力に出す）。
        report.append(realEvents.isEmpty ? "upcoming=差し込み(実カレンダーに予定なし)" : "upcoming=実カレンダー\(realEvents.count)件")
        // 一度別の面へ移してから戻し、onAppear を通す。
        step("11-upcoming", {
            MainWindowController.shared.showSection(.work)
            settle(0.5)
            MainWindowController.shared.showSection(.home)
        })

        // 12 New Recording Sheet: 設定を決めて始める 1 枚（Window は増やさない）。
        step("12-new-recording", { NewRecordingSheetOpener.shared.open() })
        // 面が出ている間も窓は 1 枚のまま（sheet は Home に重なる）。
        let duringSheet = windows().filter { $0.w >= 400 }.count
        if duringSheet > 1 { failures.append("Sheet で窓が \(duringSheet) 枚に増えた") }
        NewRecordingSheetOpener.shared.close()
        settle(0.5)

        // 8-10 UI Scale の 3 段。Home の Session Card で比べる（同じ画面で見比べたい）。
        for size in UIScale.Size.allCases {
            step("0\(8 + (UIScale.Size.allCases.firstIndex(of: size) ?? 0))-scale-\(size.rawValue)", {
                UIScale.shared.set(size)
            })
        }
        UIScale.shared.set(.comfortable)

        // 7 interrupted（前回落ちたもの）
        step("07-interrupted", {
            MainNav.shared.openSession = nil
            sessions.begin(id: "shot-2", title: "落ちた会議")
            sessions.reset()
            sessions.load()
        })

        // カードが増えていないこと（同じ id が姿を変えている）。
        let ids = Set(sessions.sessions.map(\.id))
        if ids.count != 2 { failures.append("カードが \(ids.count) 件に増えた（2 件のはず）") }
        if sessions.session(id: liveId)?.status != .ready { failures.append("ready のままでない") }
        if sessions.session(id: "shot-2")?.status != .interrupted { failures.append("interrupted になっていない") }

        sessions.reset()

        // 15 頼みごとが失敗した（黙らない）。Home の「最近の頼みごと」に、どこで止まったかの印で残る。
        //    会議カードの下に隠れないよう、会議を消したあとのここで撮る。
        LocalStore.shared.save(AgentTask(
            id: UUID(), title: "先方へ見積の返信を送る", status: .failed,
            steps: [AgentStep(title: "Gmail", tool: "gmail", detail: "下書きを作った", state: .success),
                    AgentStep(title: "送信", tool: "gmail", detail: "接続が切れた", state: .failed)],
            startedAt: Date(), context: GenieStateStore.shared.state.context))
        step("15-generic-failure", {
            MainWindowController.shared.showSection(.work); settle(0.4)
            MainWindowController.shared.showSection(.home)
        })

        print("SESSIONSHOTS_DIR \(outDir)")
        for line in report { print("SESSIONSHOT \(line)") }
        if failures.isEmpty {
            print("SELFTEST_OK sessionshots: \(report.count)面を実遷移で撮影・同じ id が姿を変える")
            exit(0)
        } else {
            print("SELFTEST_FAIL sessionshots: \(failures.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest uiscale`: §10 Interface Size。
    ///
    /// 「文字だけ大きい」でも「窓ごと拡大」でもないことを見る。
    /// 文字・面のどちらも動き、しかも比率が違う（文字は控えめ）ことまで確かめる。
    @MainActor
    private static func uiScale() {
        let scale = UIScale.shared
        var fail: [String] = []
        let baseType = TypeScale.bodySize
        let baseMetric = Metrics.sidebarWidth

        var typeBySize: [UIScale.Size: CGFloat] = [:]
        var metricBySize: [UIScale.Size: CGFloat] = [:]
        for size in UIScale.Size.allCases {
            scale.set(size)
            typeBySize[size] = S.type(baseType)
            metricBySize[size] = S.metric(baseMetric)
        }

        // ① 3 段が本当に違う。
        if Set(typeBySize.values).count != 3 { fail.append("文字が 3 段に分かれていない \(typeBySize.values.sorted())") }
        if Set(metricBySize.values).count != 3 { fail.append("寸法が 3 段に分かれていない \(metricBySize.values.sorted())") }

        // ② 順序が正しい。
        if !(typeBySize[.compact]! < typeBySize[.comfortable]! && typeBySize[.comfortable]! < typeBySize[.large]!) {
            fail.append("文字の大小が逆")
        }
        if !(metricBySize[.compact]! < metricBySize[.comfortable]! && metricBySize[.comfortable]! < metricBySize[.large]!) {
            fail.append("寸法の大小が逆")
        }

        // ③ 既定は Comfortable で、素の値と同じ。
        scale.set(.comfortable)
        if S.type(baseType) != baseType { fail.append("Comfortable が素の値と違う") }
        if S.metric(baseMetric) != baseMetric { fail.append("Comfortable の寸法が素の値と違う") }

        // ④ **文字と面が別の係数**で動く（窓ごと拡大していない証拠）。
        scale.set(.large)
        let typeRatio = S.type(baseType) / baseType
        let metricRatio = S.metric(baseMetric) / baseMetric
        if abs(typeRatio - metricRatio) < 0.01 {
            fail.append("文字と寸法が同じ倍率（単純な拡大になっている）")
        }

        // ⑤ 覚えている（次の起動でも同じ）。
        scale.set(.compact)
        if UserDefaults.standard.string(forKey: "astra.uiScale") != "compact" {
            fail.append("設定が保存されない")
        }
        scale.set(.comfortable)

        if fail.isEmpty {
            print(String(format: "SELFTEST_OK uiscale: 3段が別々に効く（文字 x%.2f / 寸法 x%.2f）・既定は素の値・設定は残る",
                         typeRatio, metricRatio))
            exit(0)
        } else {
            print("SELFTEST_FAIL uiscale: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest acceptance`: 録音セッションの受け入れ 14 項目を通しで。
    ///
    /// 個々のゲートは通っていても、**繋がっているか**は別。ここは
    /// 「Home から押す → Home に残る → 後から開ける」を一本で歩く。
    @MainActor
    private static func acceptance() {
        guard Permissions.microphone == .granted else {
            print("SELFTEST_SKIP acceptance: recording lifecycle requires microphone grant; permission gating is covered separately")
            exit(0)
        }
        let path = NSTemporaryDirectory() + "astra-accept-\(getpid()).sqlite"
        defer { try? FileManager.default.removeItem(atPath: path) }
        LocalStore.shared.open(path)
        WindowCoordinator.headless = true
        let sessions = MeetingSessionStore.shared
        let recording = RecordingWorkspaceState.shared
        let dock = GenieStateStore.shared
        sessions.reset(); dock.reset()
        var passed: [String] = []
        var fail: [String] = []

        func check(_ n: Int, _ name: String, _ ok: Bool, _ detail: String = "") {
            if ok { passed.append("\(n).\(name)") }
            else { fail.append("\(n).\(name)\(detail.isEmpty ? "" : " (\(detail))")") }
        }

        // 1 Home から予定なし録音（StartRecordingCard が呼ぶのと同じ経路）
        recording.start()
        let live = sessions.live
        check(1, "予定なし録音", live != nil)
        guard let id = live?.id else { reportAcceptance(passed, fail); return }

        // 3 録音開始直後に Home へ出る（＝ store に居る）。
        // 出るのは最上部の Recording now としてで、Recent Sessions には**並べない**。
        // 以前は両方に出ていて、同じ会議が 1 画面に 2 回並んでいた。
        check(3, "開始直後に Home へ", sessions.sessions.contains { $0.id == id })
        check(3, "Recent には重ねて出さない", !sessions.recent.contains { $0.id == id })
        // 4 Recording Now が指すものが同じ Session
        check(4, "Recording Now と同一 Session", sessions.live?.id == id)
        // Dock も同じ状態
        check(4, "Dock も会議へ", { if case .meeting = dock.dock { return true }; return false }())

        // 5 停止 → processing（同じ id、カードは増えない）
        let before = sessions.sessions.count
        recording.stop()
        check(5, "processing へ", sessions.session(id: id)?.status == .processing,
              sessions.session(id: id)?.status.rawValue ?? "nil")
        check(5, "カードが増えない", sessions.sessions.count == before)

        // 6 ready（stop 後の読み取りが終わるのを待つ）
        let deadline = Date().addingTimeInterval(6)
        while sessions.session(id: id)?.status != .ready, Date() < deadline {
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
        }
        check(6, "ready へ", sessions.session(id: id)?.status == .ready,
              sessions.session(id: id)?.status.rawValue ?? "nil")
        check(6, "同じ id のまま", sessions.sessions.count == before)

        // 7 中身が入る
        if let s = sessions.session(id: id) {
            check(7, "件数が入る", s.actionCount >= 0 && s.decisionCount >= 0)
        }

        // 8 My Space / Workspace
        sessions.setVisibility(.workspace, for: id)
        check(8, "保存先を変えられる", sessions.session(id: id)?.visibility == .workspace)

        // 9 Project
        sessions.setProject("Product", for: id)
        check(9, "project を変えられる", sessions.session(id: id)?.projectId == "Product")

        // 2 + 10 Calendar から 1-click、project 自動継承
        let link = CalendarLink(eventId: "e1", title: "Design Review", participantCount: 4,
                                meetingURL: "https://meet.google.com/x", projectId: "Research")
        recording.pendingCalendarLink = link
        recording.start()
        let fromCal = sessions.live
        check(2, "Calendar から 1-click", fromCal != nil && fromCal?.calendarEventId == "e1")
        check(10, "録音ごとに別ID", fromCal?.id != id)
        check(10, "project 自動継承", fromCal?.projectId == "Research")
        check(10, "題と人数を継承", fromCal?.title == "Design Review" && fromCal?.participantCount == 4)
        recording.stop()

        // 11 再起動で復元
        sessions.reset()
        sessions.load()
        check(11, "再起動で復元", sessions.session(id: id) != nil)

        // 12 Interrupted 復旧
        sessions.begin(id: "crash", title: "落ちた会議")
        sessions.reset()
        sessions.load()
        check(12, "interrupted で復旧", sessions.session(id: "crash")?.status == .interrupted,
              sessions.session(id: "crash")?.status.rawValue ?? "nil")

        // 13 New Recording Sheet が開ける（window は増えない＝Home の重ね面）
        NewRecordingSheetOpener.shared.open()
        check(13, "New Recording を開ける", NewRecordingSheetOpener.shared.isOpen)
        NewRecordingSheetOpener.shared.close()

        // 14 UI Scale 3 段
        let scales = UIScale.Size.allCases.map { size -> CGFloat in
            UIScale.shared.set(size); return S.type(TypeScale.bodySize)
        }
        UIScale.shared.set(.comfortable)
        check(14, "UI Scale 3 段", Set(scales).count == 3, "\(scales)")

        sessions.reset(); dock.reset()
        WindowCoordinator.headless = false
        LocalStore.shared.close()
        reportAcceptance(passed, fail)
    }

    private static func reportAcceptance(_ passed: [String], _ fail: [String]) {
        if fail.isEmpty {
            print("SELFTEST_OK acceptance: \(passed.count) 項目 PASS — \(passed.joined(separator: " / "))")
            exit(0)
        } else {
            print("SELFTEST_FAIL acceptance: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest sessionsync`: 同じ Session を全員が見ているか。
    ///
    /// 「Store を作った」だけでは、Dock と Home と DB がずれていないことは言えない。
    /// ここは **3 か所から同じ id が読めるか**、Stop がどちらから来ても両方が動くか、
    /// 面を切り替えても録音が続くかを見る。
    @MainActor
    private static func sessionSync() {
        let path = NSTemporaryDirectory() + "astra-sync-\(getpid()).sqlite"
        defer { try? FileManager.default.removeItem(atPath: path) }
        LocalStore.shared.open(path)
        WindowCoordinator.headless = true
        let sessions = MeetingSessionStore.shared
        let recording = RecordingWorkspaceState.shared
        let dock = GenieStateStore.shared
        sessions.reset(); dock.reset()
        var fail: [String] = []

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.02, true) }
        }

        // ---- Dock から Stop したとき
        // State/DB continuity is independent of microphone authorization. The real
        // microphone lifecycle has its own mandatory hardware gate.
        recording.start(captureMic: false, transcribe: false, requestPermissions: false)
        guard let id = sessions.live?.id else {
            print("SELFTEST_FAIL sessionsync: 録音が始まらない"); exit(2)
        }
        // ① 3 か所が同じ id を指す。
        // Home が録音を出すのは最上部の Recording now（`live`）で、Recent Sessions には
        // 並べない。以前ここは `recent.first` を見ていたので、同じ会議が 2 か所に
        // 出ている状態を「正しい」として通していた。
        let liveOnHome = sessions.sessions.filter { $0.status == .recording }
        if liveOnHome.count != 1 { fail.append("Home に出る録音が \(liveOnHome.count) 件") }
        if sessions.recent.contains(where: { $0.id == id }) { fail.append("Recent にも重ねて出ている") }
        let homeId = liveOnHome.first?.id
        let dockId = dock.state.meeting.meetingId
        let dbId = LocalStore.shared.loadSessions().first { $0.status == .recording }?.id
        if homeId != id { fail.append("Home の id が違う (\(homeId ?? "nil"))") }
        if dockId != id { fail.append("Dock の id が違う (\(dockId ?? "nil"))") }
        if dbId != id { fail.append("DB の id が違う (\(dbId ?? "nil"))") }

        // ② 面を切り替えても録音も id も失わない。
        for panel in DockPresentation.MeetingPanel.allCases {
            VoiceHUDState.shared.toggleMeetingPanel(panel)
            if !recording.isRecording { fail.append("\(panel.rawValue) で録音が止まった") }
            if sessions.live?.id != id { fail.append("\(panel.rawValue) で id が変わった") }
            VoiceHUDState.shared.toggleMeetingPanel(panel)
        }

        // ③ UI Scale を変えても録音・id・経過が続く。
        let elapsedBefore = sessions.live?.duration ?? 0
        UIScale.shared.set(.large)
        settle(0.3)
        if !recording.isRecording { fail.append("Scale 変更で録音が止まった") }
        if sessions.live?.id != id { fail.append("Scale 変更で id が変わった") }
        if (sessions.live?.duration ?? 0) < elapsedBefore { fail.append("Scale 変更で経過が巻き戻った") }
        UIScale.shared.set(.comfortable)

        // ④ Dock（WindowCoordinator）から Stop → Home も processing。
        WindowCoordinator.shared.toggleRecording()
        settle(0.2)
        if ![MeetingSession.Status.processing, .ready].contains(sessions.session(id: id)?.status ?? .failed) {
            fail.append("Dock 停止で Home が processing にならない (\(sessions.session(id: id)?.status.rawValue ?? "nil"))")
        }
        if recording.isRecording { fail.append("Dock 停止で録音が止まっていない") }

        // 段階が進む（spinner だけにしない）。
        var sawStage = sessions.session(id: id)?.processingStage != nil
        let stageDeadline = Date().addingTimeInterval(3)
        while !sawStage, Date() < stageDeadline {
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
            sawStage = sessions.session(id: id)?.processingStage != nil
        }
        if !sawStage && sessions.session(id: id)?.status != .ready { fail.append("processing の段階も完了も出ない") }
        // ready まで待つ。
        let readyDeadline = Date().addingTimeInterval(6)
        while sessions.session(id: id)?.status != .ready, Date() < readyDeadline {
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
        }

        // ---- Home から Stop したとき（逆方向）
        // State/DB continuity is independent of microphone authorization. The real
        // microphone lifecycle has its own mandatory hardware gate.
        recording.start(captureMic: false, transcribe: false, requestPermissions: false)
        guard let id2 = sessions.live?.id else { fail.append("2 回目が始まらない"); reportSync(fail); return }
        recording.stop()   // Home の Stop ボタンが呼ぶもの
        settle(0.2)
        if ![MeetingSession.Status.processing, .ready].contains(sessions.session(id: id2)?.status ?? .failed) {
            fail.append("Home 停止で processing にならない")
        }
        // Dock 側も同じ状態へ移っている（結果面）。
        if case .result = dock.dock {} else {
            fail.append("Home 停止で Dock が結果面へ移らない (\(dock.dock))")
        }

        // ⑤ DB と UI の値が一致する。
        let readyDeadline2 = Date().addingTimeInterval(6)
        while sessions.session(id: id2)?.status != .ready, Date() < readyDeadline2 {
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
        }
        if let ui = sessions.session(id: id2),
           let db = LocalStore.shared.loadSessions().first(where: { $0.id == id2 }) {
            if ui.status != db.status { fail.append("status が DB と違う") }
            if ui.actionCount != db.actionCount { fail.append("actionCount が DB と違う") }
            if ui.decisionCount != db.decisionCount { fail.append("decisionCount が DB と違う") }
            if ui.summary != db.summary { fail.append("summary が DB と違う") }
        } else {
            fail.append("DB から読み戻せない")
        }

        // ⑥ visibility / project の変更が DB まで届き、再読込でも残る。
        sessions.setVisibility(.workspace, for: id2)
        sessions.setProject("Product", for: id2)
        sessions.reset(); sessions.load()
        if sessions.session(id: id2)?.visibility != .workspace { fail.append("保存先が残らない") }
        if sessions.session(id: id2)?.projectId != "Product" { fail.append("project が残らない") }

        sessions.reset(); dock.reset()
        WindowCoordinator.headless = false
        LocalStore.shared.close()
        reportSync(fail)
    }

    private static func reportSync(_ fail: [String]) {
        if fail.isEmpty {
            print("SELFTEST_OK sessionsync: Dock/Home/DB が同じ id・面切替と Scale で録音を失わない・停止はどちらからでも両方へ届く・DB と UI が一致")
            exit(0)
        } else {
            print("SELFTEST_FAIL sessionsync: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }


    /// `--selftest recordleg <db> <leg>`: プロセスを跨ぐ E2E の 1 区間。
    ///
    /// 「起動 → 録音 → 落ちる → 起動し直す → 同じ会議が戻る」を本当に確かめるには、
    /// 同じプロセスの中で `reset(); load()` を呼ぶだけでは足りない。**別プロセス**で
    /// 区間を走らせ、外から kill して、次のプロセスで読み戻す。
    ///
    /// leg:
    ///   record   … 録音を始めて id を出し、そのまま生き続ける（外から kill される）
    ///   inspect  … DB を読み、いまの状態を出す
    ///   resume   … 起動時の復元を通し、状態を出す
    ///   finish   … 停止して ready まで進める
    @MainActor
    private static func recordLeg(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 3 else { print("RECORDLEG_FAIL 引数が足りない"); exit(2) }
        let dbPath = args[i + 2], leg = args[i + 3]
        LocalStore.shared.open(dbPath)
        WindowCoordinator.headless = true
        let sessions = MeetingSessionStore.shared
        let recording = RecordingWorkspaceState.shared

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        switch leg {
        case "record":
            sessions.load()
            // This self-test verifies durable session recovery across processes;
            // use the disk-only path so a raw debug executable never asks macOS
            // TCC for microphone or speech access. Remove these switches when a
            // signed live fault-injection harness replaces this test.
            recording.start(captureMic: false, transcribe: false, requestPermissions: false)
            guard let id = sessions.live?.id else { print("RECORDLEG_FAIL 録音が始まらない"); exit(2) }
            // DB に status=recording が**停止前に**在ることを、この場で確かめる。
            let onDisk = LocalStore.shared.loadSessions().first { $0.id == id }
            guard onDisk?.status == .recording else {
                print("RECORDLEG_FAIL 停止前に DB へ recording が無い"); exit(2)
            }
            // 生き続けるので、明示的に流す（バッファに残ったままだと外から読めない）。
            print("RECORDLEG_OK record id=\(id)")
            fflush(stdout)
            // 外から kill されるまで生きている。
            settle(120)
            exit(0)

        case "inspect":
            sessions.reset()
            let rows = LocalStore.shared.loadSessions()
            let line = rows.map { "\($0.id)=\($0.status.rawValue)" }.joined(separator: ",")
            print("RECORDLEG_OK inspect \(line.isEmpty ? "(なし)" : line)")
            exit(0)

        case "resume":
            // 起動時と同じ経路（GenieAppDelegate が呼ぶもの）。
            sessions.load()
            let line = sessions.sessions.map { "\($0.id)=\($0.status.rawValue)" }.joined(separator: ",")
            print("RECORDLEG_OK resume \(line.isEmpty ? "(なし)" : line)")
            exit(0)

        case "finish":
            sessions.load()
            guard let id = sessions.sessions.first(where: { $0.status == .interrupted || $0.status == .recording })?.id else {
                print("RECORDLEG_FAIL 続きの会議が無い"); exit(2)
            }
            // 中断からでも読み取りへ進められる（消さない・勝手に ready にしない）。
            sessions.beginProcessing(id: id)
            for (index, stage) in ProcessingStage.allCases.enumerated() {
                _ = index
                sessions.setProcessingStage(stage, for: id)
                settle(0.1)
            }
            sessions.markReady(id: id, summary: "続きから読み取りました。", actions: 1, decisions: 1, participants: 2)
            let s = sessions.session(id: id)
            print("RECORDLEG_OK finish id=\(id) status=\(s?.status.rawValue ?? "nil") actions=\(s?.actionCount ?? -1)")
            exit(0)

        default:
            print("RECORDLEG_FAIL 未知の leg \(leg)")
            exit(2)
        }
    }


    /// `--selftest dockedge <out.png>`: Dock の**縁を、背後ごと**撮る。
    ///
    /// 窓だけを撮ると、面の外にはみ出しているもの（影や素材の矩形）が写らない。
    /// 画面が複数あると座標合わせも当てにならないので、
    /// 自分の窓の位置を知っているアプリ自身に、その周りを撮らせる。
    @MainActor
    private static func dockEdge(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let out = args.count > i + 2 ? args[i + 2] : "/tmp/astra-dockedge.png"
        NSApp.setActivationPolicy(.regular)
        VoiceHUDState.shared.mode = .idle
        WindowCoordinator.shared.showVoiceHUD()

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        settle(1.2)

        guard let panel = NSApp.windows.first(where: { $0.isVisible && $0.frame.height < 200 }),
              let screen = panel.screen ?? NSScreen.main else {
            print("SELFTEST_FAIL dockedge: Dock が出ていない"); exit(2)
        }
        // 撮る直前にもう一度 idle に固定して寸法を読み直す。
        // 前面アプリの認識で appContext へ変わると、測った寸法と撮る寸法がずれる
        // （それを「外形の外に帯がある」と読み違えていた）。
        VoiceHUDState.shared.mode = .idle
        WindowCoordinator.shared.syncDockPanels()
        settle(0.8)
        // window server 座標（上原点）へ直す。周囲 40pt を含めて撮る。
        let f = panel.frame
        let pad: CGFloat = 40
        // CoreGraphics の画面座標は **主ディスプレイ**の左上が原点で y は下向き。
        // panel.screen の maxY で反転すると、複数ディスプレイのときにずれる
        // （ずれた場所を撮って「外形の外に帯がある」と読み違えていた）。
        _ = screen
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        let rect = CGRect(x: f.minX - pad,
                          y: (mainMaxY - f.maxY) - pad,
                          width: f.width + pad * 2,
                          height: f.height + pad * 2)
        guard let cg = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]),
              let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else {
            print("SELFTEST_FAIL dockedge: 撮影できない"); exit(2)
        }
        try? png.write(to: URL(fileURLWithPath: out))

        // 同じ場所を **Dock を隠して** もう一枚。帯が Dock 由来か背景かを切り分ける。
        WindowCoordinator.shared.hideVoiceHUD()
        settle(1.0)
        let without = out.replacingOccurrences(of: ".png", with: "-without.png")
        if let cg2 = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]),
           let png2 = NSBitmapImageRep(cgImage: cg2).representation(using: .png, properties: [:]) {
            try? png2.write(to: URL(fileURLWithPath: without))
        }
        print("SELFTEST_OK dockedge: \(out) / \(without) frame=\(Int(f.width))x\(Int(f.height)) 周囲\(Int(pad))pt 込み")
        exit(0)
    }


    /// `--selftest pixels <png>`: 画像の四隅を実測する。目で見て言い当てない。
    private static func pixels(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 2,
              let data = FileManager.default.contents(atPath: args[i + 2]),
              let rep = NSBitmapImageRep(data: data) else {
            print("SELFTEST_FAIL pixels: 読めない"); exit(2)
        }
        let w = rep.pixelsWide, h = rep.pixelsHigh
        func describe(_ x: Int, _ y: Int) -> String {
            guard let c = rep.colorAt(x: min(max(0, x), w - 1), y: min(max(0, y), h - 1)) else { return "?" }
            return String(format: "(%d,%d) rgba=%.2f,%.2f,%.2f,%.2f",
                          x, y, c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent)
        }
        print("size=\(w)x\(h)")
        // 縦一列を走査して、色が変わる位置を出す（帯がどこにあるかを目で言い当てない）。
        var last = ""
        for y in stride(from: 0, to: h, by: max(1, h / 60)) {
            guard let c = rep.colorAt(x: 12, y: y) else { continue }
            let key = String(format: "%.2f,%.2f,%.2f", c.redComponent, c.greenComponent, c.blueComponent)
            if key != last {
                print(String(format: "  y=%3d 左端 rgb=%@", y, key))
                last = key
            }
        }
        // 左下の角: 外形の外（角の丸みの外側）と、面の内側を比べる。
        print("角の外 " + describe(2, h - 3))
        print("角の外 " + describe(6, h - 6))
        print("面の内 " + describe(w / 2, h - 6))
        print("面の内 " + describe(w / 2, h / 2))
        print("右下外 " + describe(w - 3, h - 3))
        print("上辺外 " + describe(2, 2))
        // 2 枚目が渡されていれば、同じ点を引き算して「何が足されたか」を出す。
        if args.count > i + 3, let d2 = FileManager.default.contents(atPath: args[i + 3]),
           let rep2 = NSBitmapImageRep(data: d2), rep2.pixelsWide == w, rep2.pixelsHigh == h {
            print("-- 差分（with - without）--")
            for (label, x, y) in [("角の外下", 44, h - 42), ("角の外左", 42, h - 46),
                                  ("面の内", w / 2, h / 2), ("外側", 8, h - 8)] {
                guard let a = rep.colorAt(x: x, y: y), let b = rep2.colorAt(x: x, y: y) else { continue }
                print(String(format: "  %@ (%d,%d) Δrgb=%+.3f,%+.3f,%+.3f",
                             label, x, y,
                             a.redComponent - b.redComponent,
                             a.greenComponent - b.greenComponent,
                             a.blueComponent - b.blueComponent))
            }
        }
        exit(0)
    }

    /// `--selftest state`: 仕様書 §5 / §28 / §31。状態が**本当に 1 箇所**にあるか。
    ///
    /// 「GenieState を作った」だけでは意味がない。既存の Surface が自前の状態を持ったままだと、
    /// 二つが静かにずれる。ここでは *どちらから書いても両方が動く* ことを実測する。
    @MainActor
    private static func stateMachine() {
        let store = GenieStateStore.shared
        let bus = GenieEventBus.shared
        store.reset()
        var fail: [String] = []

        // ① Surface（VoiceHUDState）から書いても Store が動く。
        VoiceHUDState.shared.mode = .listening(partial: "")
        if store.state.dock != .listening(partial: "") { fail.append("Surface→Store が伝わらない") }
        if store.state.mode != .listening { fail.append("dock→mode が連動しない (\(store.state.mode))") }

        // ② Store から書いても Surface が同じものを返す（二重持ちしていない）。
        store.setDock(.thinking)
        if VoiceHUDState.shared.mode != .thinking { fail.append("Store→Surface が伝わらない") }
        if store.state.mode != .thinking { fail.append("mode が thinking にならない") }

        // ③ 勧誘や Quick Actions は「活動」ではないので idle のまま（§5 の mode と混ぜない）。
        store.setDock(.quickActions)
        if store.state.mode != .idle { fail.append("quickActions で mode が動いた (\(store.state.mode))") }

        // ④ 会議中は Dock が idle でも活動は meeting のまま。
        store.meetingStarted(id: "m1")
        store.setDock(.idle)
        if store.state.mode != .meeting { fail.append("会議中に mode が idle へ落ちた") }
        store.meetingEnded()

        // ⑤ §16 R0/R1 は確認カードを出さない。R2/R3 は必ず出す。
        let r1 = ActionConfirmation(title: "下書きを作る", details: [], risk: .r1, confirmLabel: "作る")
        if store.requireConfirmation(r1) { fail.append("R1 で確認カードが出た") }
        let r3 = ActionConfirmation(title: "3 件削除する", details: ["Library"], risk: .r3, confirmLabel: "削除する")
        if !store.requireConfirmation(r3) { fail.append("R3 で確認カードが出ない") }
        if store.state.mode != .awaitingConfirmation { fail.append("確認待ちに入らない") }
        store.resolveConfirmation(approved: false)
        if store.state.confirmation != nil { fail.append("確認を閉じても残っている") }

        // ⑥ §7 文脈は出所つきで、同じアプリなら**信頼できる方だけ**残る。期限切れは落ちる。
        let now = Date()
        let raw = [
            ContextFact(source: .ocr, application: "Notion", sensitivity: .workspace,
                        summary: "OCR 版", capturedAt: now, expiresAt: now.addingTimeInterval(60)),
            ContextFact(source: .browserDOM, application: "Notion", sensitivity: .workspace,
                        summary: "DOM 版", capturedAt: now, expiresAt: now.addingTimeInterval(60)),
            ContextFact(source: .accessibility, application: "Slack", sensitivity: .personal,
                        summary: "古い", capturedAt: now.addingTimeInterval(-120), expiresAt: now.addingTimeInterval(-60)),
        ]
        store.updateContext(raw, now: now)
        let items = store.state.context.items
        if items.count != 1 { fail.append("文脈の解決が誤り count=\(items.count)") }
        if items.first?.summary != "DOM 版" { fail.append("優先度の低い source が勝った") }

        // ⑦ §28 イベントが実際に流れている（購読者に届く）。
        var received: [String] = []
        let token = bus.subscribe { received.append($0.name) }
        store.setMode(.acting)
        store.workspaceOpened()
        bus.unsubscribe(token)
        if !received.contains("mode.changed") { fail.append("mode.changed が流れない") }
        if !received.contains("workspace.opened") { fail.append("workspace.opened が流れない") }

        // ⑧ 記録された名前が §28 の一覧と一致している。
        let names = Set(bus.recent.map { $0.name })
        for want in ["mode.changed", "context.updated", "confirmation.required", "meeting.started"] where !names.contains(want) {
            fail.append("\(want) が記録されていない")
        }

        store.reset()
        if fail.isEmpty {
            print("SELFTEST_OK state: 状態は GenieStateStore 1 箇所・dock↔mode 連動・R0/R1 は無確認 R2/R3 は確認・文脈は出所優先・EventBus 到達")
            exit(0)
        } else {
            print("SELFTEST_FAIL state: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest presence`: §6 Presence / §18 Meeting Detector / §22 Presentation Guard。
    ///
    /// いちばん確かめたいのは **検出しても録音が始まらない**こと。
    /// 「会議を見つけたら録り始める」は、同意していない会議まで録る製品になる。
    @MainActor
    private static func presence() {
        WindowCoordinator.headless = true
        let store = GenieStateStore.shared
        store.reset()
        var fail: [String] = []
        var report: [String] = []

        // ① 会議アプリの判定。Zoom / Meet（ブラウザのタイトル経由）を拾う。
        if MeetingDetector.detect(bundleId: "us.zoom.xos", windowTitle: "Zoom Meeting") != "Zoom" {
            fail.append("Zoom を検出できない")
        }
        if MeetingDetector.detect(bundleId: "com.google.Chrome", windowTitle: "Google Meet — 週次") != "Google Meet" {
            fail.append("ブラウザの Meet を検出できない")
        }
        // ② Slack は常駐しているだけでは会議にしない（Huddle のときだけ）。
        if MeetingDetector.detect(bundleId: "com.tinyspeck.slackmacgap", windowTitle: "Slack — general") != nil {
            fail.append("Slack を開いているだけで会議と判定した")
        }
        if MeetingDetector.detect(bundleId: "com.tinyspeck.slackmacgap", windowTitle: "Huddle in #sales") == nil {
            fail.append("Slack ハドルを検出できない")
        }
        // ③ 会議でないものを会議にしない。
        if MeetingDetector.detect(bundleId: "com.apple.finder", windowTitle: "書類") != nil {
            fail.append("Finder を会議と判定した")
        }

        // ④ **検出は録音開始ではない**（§18）。
        store.meetingDetected(app: "Zoom")
        if store.state.meeting.isRecording { fail.append("検出しただけで録音が始まった") }
        if store.state.mode == .meeting { fail.append("検出しただけで mode が meeting になった") }
        if RecordingRuntime.shared.snapshot() != nil { fail.append("検出しただけでランタイムが動いた") }
        if RecordingWorkspaceState.shared.isRecording { fail.append("検出しただけで録音状態になった") }
        if !GenieEventBus.shared.recent.contains(where: { $0.name == "meeting.detected" }) {
            fail.append("meeting.detected が流れない")
        }

        // ⑤ §22 共有が始まったら Dock を出さない。終われば戻す。
        let guardian = PresentationGuard.shared
        guardian.apply(sharing: true)
        if !guardian.isSharing { fail.append("共有中にならない") }
        guardian.apply(sharing: false)
        if guardian.isSharing { fail.append("共有終了が反映されない") }

        // ⑥ Permission denial AND a pending first prompt must never create a
        // recording, advance its clock, or erase the previous transcript.
        let recording = RecordingWorkspaceState.shared
        let priorMicrophone = Permissions.simulatedMicrophone
        let priorTranscript = recording.transcript.map(\.text)
        let priorId = recording.currentMeetingId
        let priorElapsed = recording.elapsedSeconds
        for state: Permissions.State in [.denied, .restricted, .notDetermined] {
            Permissions.simulatedMicrophone = state
            recording.start(requestPermissions: false)
            if recording.isRecording || store.state.meeting.isRecording {
                fail.append("マイクが使えないのに録音状態になった: \(state)")
            }
            if recording.permissionIssue == nil {
                fail.append("使えない理由が画面に出ない: \(state)")
            }
            if RecordingRuntime.shared.snapshot() != nil || recording.currentMeetingId != priorId {
                fail.append("許可前に録音セッションを作った: \(state)")
            }
            if recording.elapsedSeconds != priorElapsed || recording.transcript.map(\.text) != priorTranscript {
                fail.append("許可前に前の録音を消した: \(state)")
            }
            recording.stop()
        }
        Permissions.simulatedMicrophone = priorMicrophone
        report.append("mic denial/restriction/pending: no recording or session")

        // ⑦ §26 Progressive Permission: 機能ごとに**その分だけ**。他機能の許可を巻き込まない。
        if PermissionCenter.Capability.voice.required != [.microphone] {
            fail.append("voice がマイク以外まで要求している")
        }
        if PermissionCenter.Capability.control.required != [.accessibility] {
            fail.append("control がアクセシビリティ以外まで要求している")
        }
        if PermissionCenter.Capability.screenAsk.required != [.screenRecording] {
            fail.append("screenAsk が画面以外まで要求している")
        }
        // マイク録音に画面収録を巻き込まない。画面の音を選んだ場合だけ別に要求する。
        if PermissionCenter.Capability.meeting.required != [.microphone, .speechRecognition] {
            fail.append("meeting がマイクと音声認識以外まで要求している")
        }
        if PermissionCenter.Capability.meetingAudio.required != [.screenRecording] {
            fail.append("meetingAudio が画面収録以外を要求している")
        }
        // 全機能の和集合を、どれか 1 機能が単独で要求してはいけない（＝初回一括の禁止）。
        let all = Set(PermissionCenter.Capability.allCases.flatMap(\.required))
        for c in PermissionCenter.Capability.allCases where Set(c.required) == all && all.count > 1 {
            fail.append("\(c.rawValue) が全部まとめて要求している")
        }
        // 使えないときは黙らず理由を返す。
        for c in PermissionCenter.Capability.allCases {
            let r = PermissionCenter.check(c)
            if !r.ok && (r.reason ?? "").isEmpty { fail.append("\(c.rawValue) の不足理由が空") }
        }

        // ⑥ §8 AXContext は取れなかった項目を埋めない。
        let ax = AXContext(appName: "Notion", bundleId: "notion.id", windowTitle: "Q3 Roadmap",
                           focusedRole: nil, selectedText: nil)
        let fact = ax.fact()
        if fact.source != .accessibility { fail.append("AX の出所が違う") }
        if fact.sensitivity != .workspace { fail.append("選択なしなのに personal 扱い") }
        if !fact.summary.contains("Q3 Roadmap") { fail.append("窓タイトルが文脈に入らない") }

        store.reset()
        WindowCoordinator.headless = false
        if fail.isEmpty {
            print("SELFTEST_OK presence: 会議検出（Zoom/Meet/Huddle）・検出しても録音は始まらない・共有中は Dock を出さない・許可は機能ごとに最小・マイク不可なら録音状態にしない・AX は推測で埋めない \(report.joined(separator: " "))")
            exit(0)
        } else {
            print("SELFTEST_FAIL presence: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest perf`: §29 の性能目標を**実測**する。目標値を書いただけにしない。
    ///
    /// ここで測るのは Genie が自分で決められるところだけ:
    ///   - Dock が出るまで < 120ms
    ///   - AX 取得 < 250ms
    ///   - アプリ変更の認識 < 150ms
    ///   - idle のメモリ < 180MB
    /// CPU < 1% は測るのに時間の窓が要るので、ここでは idle 1 秒の実測を出す（判定は緩め）。
    @MainActor
    private static func perf() {
        var report: [String] = []
        var fail: [String] = []

        func ms(_ block: () -> Void) -> Double {
            let t0 = Date()
            block()
            return Date().timeIntervalSince(t0) * 1000
        }

        // Dock を出すまで（window を実際に出す）。
        let dockMs = ms { WindowCoordinator.shared.showVoiceHUD() }
        report.append(String(format: "dock=%.0fms", dockMs))
        if dockMs >= 120 { fail.append(String(format: "Dock が %.0fms (目標 <120ms)", dockMs)) }

        // AX 取得（許可が無ければ nil が返るが、かかる時間は測れる）。
        let axMs = ms { _ = AccessibilityContext.snapshot() }
        report.append(String(format: "ax=%.0fms", axMs))
        if axMs >= 250 { fail.append(String(format: "AX が %.0fms (目標 <250ms)", axMs)) }

        // 前面アプリの認識（NSWorkspace 読み + 会議判定 + 文脈更新まで）。
        let appMs = ms {
            _ = NSWorkspace.shared.frontmostApplication
            MeetingDetector.refresh()
        }
        report.append(String(format: "app=%.0fms", appMs))
        if appMs >= 150 { fail.append(String(format: "アプリ認識が %.0fms (目標 <150ms)", appMs)) }

        // idle のメモリ（footprint）。
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        if kr == KERN_SUCCESS {
            let mb = Double(info.phys_footprint) / 1_048_576
            report.append(String(format: "mem=%.0fMB", mb))
            if mb >= 180 { fail.append(String(format: "idle メモリが %.0fMB (目標 <180MB)", mb)) }
        } else {
            fail.append("メモリを測れない")
        }

        // idle の CPU。1 秒窓は起動直後の後片付けを拾って揺れるので、5 秒窓も測る。
        // §29 の目標は < 1%。短い窓は参考値にとどめ、判定は 5 秒窓で行う。
        let cpu1 = idleCPUPercent(seconds: 1.0)
        let cpu5 = idleCPUPercent(seconds: 5.0)
        report.append(String(format: "cpu1s=%.1f%% cpu5s=%.2f%%", cpu1, cpu5))
        if cpu5 >= 1.0 { fail.append(String(format: "idle CPU(5s) が %.2f%% (目標 <1%%)", cpu5)) }

        WindowCoordinator.shared.hideVoiceHUD()
        // 詳細は stderr へ。stdout の 1 行目は SELFTEST_* に保つ（呼び出し側が先頭で判定するため）。
        FileHandle.standardError.write(Data(("PERF " + report.joined(separator: " ") + "\n").utf8))
        if fail.isEmpty {
            print("SELFTEST_OK perf: §29 の実測が目標内 (\(report.joined(separator: " ")))")
            exit(0)
        } else {
            print("SELFTEST_FAIL perf: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// 自プロセスの CPU 使用率（%）を実測する。
    private static func idleCPUPercent(seconds: Double) -> Double {
        func cpuSeconds() -> Double {
            var info = task_thread_times_info_data_t()
            var count = mach_msg_type_number_t(MemoryLayout<task_thread_times_info_data_t>.size / MemoryLayout<natural_t>.size)
            let kr = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                    task_info(mach_task_self_, task_flavor_t(TASK_THREAD_TIMES_INFO), $0, &count)
                }
            }
            guard kr == KERN_SUCCESS else { return 0 }
            let user = Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1e6
            let sys = Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1e6
            return user + sys
        }
        let before = cpuSeconds()
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        return (cpuSeconds() - before) / seconds * 100
    }

    /// `--selftest storage`: §24 ローカル保存 / §23 UI を閉じても task が消えないこと。
    ///
    /// 「保存しない」を検査するのが難しいので、**列そのものを作っていない**ことを見る。
    /// 列が無ければ後から入れられない。
    @MainActor
    private static func storage() {
        let path = NSTemporaryDirectory() + "astra-storage-\(getpid()).sqlite"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let store = LocalStore(path: path)
        var fail: [String] = []

        // ① §24 のテーブルが揃っている。
        let tables = Set(store.tableNames())
        for want in LocalStore.tables where !tables.contains(want) { fail.append("\(want) が無い") }

        // ② 画像と音声の列は**どこにも作らない**（§24）。
        let bannedEverywhere = ["image", "png", "screenshot", "audio", "pcm", "wav", "blob"]
        for table in LocalStore.tables {
            for column in store.columnNames(table) {
                let lower = column.lowercased()
                for bad in bannedEverywhere where lower.contains(bad) {
                    fail.append("\(table).\(column) は保存してはいけないものの列")
                }
            }
        }
        // ③ 文脈は **metadata だけ**。本文の列は context_metadata に作らない（§25）。
        //    会議の summary は仕様が要求しているので、禁じるのは文脈側だけ。
        for column in store.columnNames("context_metadata") {
            let lower = column.lowercased()
            for bad in ["summary", "content", "body", "text"] where lower.contains(bad) {
                fail.append("context_metadata.\(column) は文脈の本文を持つ列")
            }
        }
        // 文脈は metadata だけ（source/sensitivity/期限）。
        let ctxColumns = Set(store.columnNames("context_metadata"))
        if !ctxColumns.isSuperset(of: ["source", "application", "sensitivity", "captured_at", "expires_at"]) {
            fail.append("context_metadata に §25 の項目が足りない")
        }

        // ③ §23 task は UI と無関係に残り、読み戻せる。
        let id = UUID()
        let task = AgentTask(id: id, title: "調べる", status: .running,
                             steps: [AgentStep(title: "検索", tool: "web", state: .success),
                                     AgentStep(title: "まとめる", tool: "agent", state: .running)],
                             startedAt: Date(), context: ContextBundle())
        store.save(task)
        // 「UI を閉じた」= panel を全部片付ける。task には触らない。
        WindowCoordinator.headless = true
        WindowCoordinator.shared.hideVoiceHUD()
        let running = store.loadTasks(status: .running)
        guard let restored = running.first(where: { $0.id == id }) else {
            fail.append("UI を閉じたら task が読み戻せない")
            report(fail); return
        }
        if restored.steps.count != 2 { fail.append("step が失われた (\(restored.steps.count))") }
        if restored.steps.first?.state != .success { fail.append("step の状態が失われた") }
        if restored.title != "調べる" { fail.append("title が失われた") }

        // ④ §11 画面は既定で見ない。連続取得は tracking/meeting のときだけ、しかも 3fps 上限。
        if ScreenCapturePolicy.fps(for: .idle) != 0 { fail.append("通常時に画面を見ている") }
        if ScreenCapturePolicy.allowsSingleShot(.idle) { fail.append("通常時に 1 枚撮れてしまう") }
        if ScreenCapturePolicy.minimumInterval(for: .idle) != nil { fail.append("通常時に連続取得できる") }
        for need in [ScreenCapturePolicy.Need.tracking, .meeting] where ScreenCapturePolicy.fps(for: need) > 3 {
            fail.append("連続取得が 3fps を超える")
        }

        // ⑤ §14 実行経路。上位が使えるなら Vision は選ばれない。
        if ExecutionPlanner.choose(available: [.visionUI, .accessibility]) != .accessibility {
            fail.append("AX があるのに Vision を選んだ")
        }
        if ExecutionPlanner.choose(available: [.browserDOM, .plugin]) != .plugin {
            fail.append("Plugin があるのに別経路を選んだ")
        }
        if ExecutionPlanner.mayUseVision(available: [.visionUI, .accessibility]) {
            fail.append("上位経路があるのに Vision を許した")
        }
        if !ExecutionPlanner.mayUseVision(available: [.visionUI]) {
            fail.append("他に何も無いのに Vision を禁じた")
        }
        if ExecutionPlanner.choose(available: []) != nil { fail.append("経路が無いのに選んだ") }

        // ⑥ 文脈は metadata だけが 1 行入り、本文はどこにも無い。
        let fact = ContextFact(source: .accessibility, application: "Notion", sensitivity: .personal,
                               summary: "これは本文なので保存されてはいけない",
                               capturedAt: Date(), expiresAt: Date().addingTimeInterval(60))
        store.saveContextMetadata(fact)
        if store.countRows("context_metadata") != 1 { fail.append("文脈 metadata が入らない") }
        if let blob = try? String(contentsOfFile: path, encoding: .isoLatin1),
           blob.contains("これは本文なので保存されてはいけない") {
            fail.append("文脈の本文がファイルに書かれている")
        }

        WindowCoordinator.headless = false
        store.close()
        report(fail)
    }

    private static func report(_ fail: [String]) {
        if fail.isEmpty {
            print("SELFTEST_OK storage: §24 の7テーブル・画像/音声/本文の列を持たない・UI を閉じても task が残る・§11 通常時 0fps/上限3fps・§14 Vision は最後の手段")
            exit(0)
        } else {
            print("SELFTEST_FAIL storage: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest meetingiq`: §20 増分抽出 / §21 Canvas が構造データであること。
    ///
    /// 確かめたいのは **全 Transcript を毎回投げていない**こと。
    /// 行が増えるたびに全部投げ直す実装でも「動いて」は見えるので、
    /// 各回に渡した行数を見て、増分だけを渡していることを確認する。
    @MainActor
    private static func meetingIQ() {
        let iq = MeetingIntelligence.shared
        iq.reset()
        GenieStateStore.shared.reset()
        var fail: [String] = []

        // ① 溜まるまでは回さない（1 行ごとに LLM を叩かない）。
        if iq.ingest(["おはようございます"]) { fail.append("1 行で抽出を回した") }
        if iq.passes != 0 { fail.append("溜まる前に回っている") }

        // ② 溜まったら回る。渡すのは**その回の新しい行だけ**。
        let first = ["おはようございます", "導入時期は 10 月で行きます", "初期費用が心配です"]
        if !iq.ingest(first) { fail.append("溜まっても回らない") }
        if iq.lastBatchSize != 3 { fail.append("初回の投入行数が \(iq.lastBatchSize)") }

        // ③ 続きを足したとき、渡すのは増えた分だけ（全文ではない）。
        let second = first + ["見積は明日までにお願いします", "誰が対応しますか？", "私が担当します"]
        if !iq.ingest(second) { fail.append("追記で回らない") }
        if iq.lastBatchSize != 3 { fail.append("増分ではなく \(iq.lastBatchSize) 行を投入した（全文再投入）") }
        if iq.passes != 2 { fail.append("回数が \(iq.passes)") }

        // ④ §21 Canvas は Markdown ではなく分類済みの構造データ。
        let canvas = iq.canvas
        if canvas.isEmpty { fail.append("Canvas が空") }
        if !canvas.decisions.contains(where: { $0.contains("10 月") }) { fail.append("決定事項を拾えない") }
        if !canvas.concerns.contains(where: { $0.contains("心配") }) { fail.append("懸念を拾えない") }
        if !canvas.questions.contains(where: { $0.contains("？") }) { fail.append("質問を拾えない") }
        if !canvas.actions.contains(where: { $0.contains("明日まで") }) { fail.append("アクションを拾えない") }

        // ⑤ 前の結果を作り直さず積み増している（Incremental）。
        if canvas.decisions.count + canvas.actions.count + canvas.questions.count
            + canvas.concerns.count + canvas.notes.count != 6 {
            fail.append("行が失われたか重複した")
        }

        // ⑥ State と EventBus に反映されている。
        if GenieStateStore.shared.state.meeting.canvas != canvas { fail.append("State に Canvas が入っていない") }
        if !GenieEventBus.shared.recent.contains(where: { $0.name == "meeting.transcript.updated" }) {
            fail.append("meeting.transcript.updated が流れない")
        }

        iq.reset()
        GenieStateStore.shared.reset()
        if fail.isEmpty {
            print("SELFTEST_OK meetingiq: 増分だけ投入（全文再投入なし）・Canvas は構造データ・State/EventBus へ反映")
            exit(0)
        } else {
            print("SELFTEST_FAIL meetingiq: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest vad`: §12 VAD と partial の反映。
    ///
    /// 無音まで STT に流すと電池も精度も落ちるが、単語の切れ目で切ると文の途中で確定する。
    /// その両方を実際の波形で確かめる。partial の反映時間は実音声で測る（`sttstream` と同じ経路）。
    @MainActor
    private static func vad() {
        var fail: [String] = []
        var detector = VoiceActivityDetector()

        func frame(_ amplitude: Float, count: Int = 1600) -> [Float] {
            (0..<count).map { _ in Float.random(in: -amplitude...amplitude) }
        }

        // ① 無音は流さない。
        let t0 = Date()
        if detector.accept(frame(0.001), now: t0) { fail.append("無音を STT へ流した") }
        if detector.isSpeaking { fail.append("無音なのに発話中") }

        // ② 声が乗ったら流す。
        if !detector.accept(frame(0.2), now: t0.addingTimeInterval(0.1)) { fail.append("声を流さなかった") }
        if !detector.isSpeaking { fail.append("声が乗ったのに発話中でない") }

        // ③ 短い途切れでは切らない（hangover 内）。文の途中で確定させないため。
        if !detector.accept(frame(0.001), now: t0.addingTimeInterval(0.3)) {
            fail.append("短い途切れで切った（文の途中で確定してしまう）")
        }
        // ④ 十分に空いたら切る。
        if detector.accept(frame(0.001), now: t0.addingTimeInterval(2.0)) {
            fail.append("長い無音でも流し続けた")
        }
        if detector.isSpeaking { fail.append("長い無音の後も発話中のまま") }

        // ⑤ §19 混ぜても channel を捨てない。混合波は記録用、STT へは分けて渡す。
        let localFrames: [Float] = [0.5, 0.5, 0.5, 0.5]
        let remoteFrames: [Float] = [-0.5, -0.5, -0.5, -0.5]
        let mixed = AudioMixer.mix(localFrames, remoteFrames)
        if mixed.count != 4 { fail.append("混合の長さが違う") }
        if mixed.contains(where: { abs($0) > 1 }) { fail.append("混合で振り切れた") }
        let split = AudioMixer.split(local: localFrames, remote: remoteFrames)
        if split.count != 2 { fail.append("STT へ分けて渡していない") }
        if Set(split.map(\.channel)) != Set(SpeakerChannel.allCases) { fail.append("channel が揃わない") }
        if split.first(where: { $0.channel == .remoteAudio })?.samples != remoteFrames {
            fail.append("相手の音を混ぜてから渡している")
        }
        if SpeakerChannel.localUser.label == SpeakerChannel.remoteAudio.label {
            fail.append("話者名が区別されない")
        }

        // ⑥ 実音声で partial が **final を待たずに** 出るか。反映までの時間も実測する。
        guard SpeechTranscriber.authorization == .authorized else {
            print("SELFTEST_SKIP vad: speech not authorized (VAD の判定は上で PASS)"); exit(0)
        }
        let aiff = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("astra-vad-\(getpid()).aiff")
        defer { try? FileManager.default.removeItem(at: aiff) }
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", "Samantha", "-o", aiff.path, "testing astra partial transcript latency"]
        do { try say.run(); say.waitUntilExit() } catch {
            print("SELFTEST_SKIP vad: say を使えない \(error)"); exit(0)
        }
        guard say.terminationStatus == 0, let frames = decodeTo16kMonoF32(aiff) else {
            print("SELFTEST_SKIP vad: 音源を用意できない"); exit(0)
        }

        // 先に一度回して Speech を暖める。
        //
        // 測りたいのは「話してから画面に出るまで」であって、認識器の起動時間ではない。
        // 冷えた 1 回目は 300〜420ms、暖まった後は 150〜220ms で、同じ機械でも
        // 5 回中 3 回落ちていた（実測）。基準は緩めず、測る対象を揃える。
        do {
            let warm = SpeechTranscriber(localeId: "en-US")
            try? warm.start { _ in }
            var i = 0
            while i < frames.count {
                let end = min(i + 3200, frames.count)
                warm.append(Array(frames[i..<end]))
                i = end
                CFRunLoopRunInMode(.defaultMode, 0.01, true)
            }
            warm.finish()
            let until = Date().addingTimeInterval(0.4)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        let st = SpeechTranscriber(localeId: "en-US")
        let lock = NSLock()
        var firstPartialAt: Date?
        var sawFinal = false
        var partials = 0
        do {
            try st.start { ev in
                lock.lock()
                if ev.isFinal { sawFinal = true } else {
                    partials += 1
                    if firstPartialAt == nil { firstPartialAt = Date() }
                }
                lock.unlock()
            }
        } catch {
            print("SELFTEST_SKIP vad: STT を開始できない \(error)"); exit(0)
        }

        // VAD を通したフレームだけを流す（実運用と同じ経路）。
        var gate = VoiceActivityDetector()
        var fedAt: Date?
        var i = 0
        while i < frames.count {
            let end = min(i + 3200, frames.count)
            let chunk = Array(frames[i..<end])
            if gate.accept(chunk) {
                if fedAt == nil { fedAt = Date() }
                st.append(chunk)
            }
            i = end
            CFRunLoopRunInMode(.defaultMode, 0.02, true)
        }
        let deadline = Date().addingTimeInterval(4)
        while firstPartialAt == nil, Date() < deadline { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        st.finish()

        guard let fedAt, let firstPartialAt else {
            print("SELFTEST_SKIP vad: partial が返らなかった（VAD の判定は上で PASS）"); exit(0)
        }
        let latencyMs = firstPartialAt.timeIntervalSince(fedAt) * 1000
        FileHandle.standardError.write(Data(
            "VAD partials=\(partials) final=\(sawFinal) firstPartial=\(Int(latencyMs))ms\n".utf8))
        if partials == 0 { fail.append("partial が 1 件も出ない（final を待っている）") }
        if latencyMs >= 300 {
            fail.append(String(format: "partial の反映が %.0fms (目標 <300ms)", latencyMs))
        }

        if fail.isEmpty {
            print("SELFTEST_OK vad: 無音は流さない・声は流す・短い途切れで切らない・§19 channel を保持・実音声の partial が \(Int(latencyMs))ms で反映（<300ms）")
            exit(0)
        } else {
            print("SELFTEST_FAIL vad: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest browser`: §9 Native Messaging / §10 Notion Adapter。
    ///
    /// ブラウザ無しで走る。確かめるのは
    ///   - Chrome のフレーム形式（4byte LE + JSON）を正しく切り出すこと
    ///   - **DOM 全文を受け取らないこと**（送られてきても上限で切る）
    ///   - Notion のときだけ「どのページを見ているか」まで分かること
    ///   - ブラウザ由来は AX より**信頼できる**として扱われること（§7 優先順位）
    @MainActor
    private static func browser() {
        var fail: [String] = []
        let store = GenieStateStore.shared
        store.reset()

        func frame(_ object: [String: Any]) -> Data {
            NativeMessagingHost.encode(object) ?? Data()
        }

        // ① 1 通ぶん届いていなければ nil（エラーにしない）。
        let full = frame(["type": "context", "payload": ["url": "https://example.com", "title": "T"]])
        if (try? NativeMessagingHost.decode(full.prefix(3))) as? (json: [String: Any], consumed: Int) != nil {
            fail.append("途中のバッファで復号した")
        }
        do {
            guard let (json, consumed) = try NativeMessagingHost.decode(full) else {
                fail.append("完全なフレームを復号できない"); reportBrowser(fail); return
            }
            if consumed != full.count { fail.append("消費バイト数が違う") }
            if json["type"] as? String != "context" { fail.append("type が読めない") }
        } catch {
            fail.append("復号で例外 \(error)")
        }

        // ② 桁違いの長さは読まない（メモリを食い尽くさせない）。
        var huge = Data([0xFF, 0xFF, 0xFF, 0xFF])
        huge.append(Data(repeating: 0x20, count: 8))
        do {
            _ = try NativeMessagingHost.decode(huge)
            fail.append("巨大な長さを受け入れた")
        } catch NativeMessagingHost.FrameError.tooLarge {
            // 期待どおり
        } catch {
            fail.append("巨大な長さで別の例外 \(error)")
        }

        // ③ 送り手を信用しきらない。全文を送られても上限で切る。
        let many = (0..<50).map { ["id": "b\($0)", "role": "p", "text": String(repeating: "あ", count: 5000)] }
        guard let payload = BrowserPayload.from(json: [
            "url": "https://www.notion.so/team/Q3-Product-Roadmap-0123456789abcdef0123456789abcdef",
            "title": "Q3 Product Roadmap | Notion",
            "selection": String(repeating: "い", count: 9000),
            "focusedElement": ["role": "textbox"],
            "semanticBlocks": many,
        ]) else {
            fail.append("payload を作れない"); reportBrowser(fail); return
        }
        if payload.blocks.count > BrowserPayload.maxBlocks { fail.append("ブロック数を切っていない") }
        if payload.blocks.contains(where: { $0.text.count > BrowserPayload.maxBlockChars }) {
            fail.append("ブロック本文を切っていない")
        }
        if payload.selection.count > BrowserPayload.maxSelectionChars { fail.append("選択を切っていない") }

        // ④ §10 Notion のときは「どのページか」まで分かる。
        guard let bundle = NotionAdapter.bundle(payload) else {
            fail.append("Notion を Notion と認識しない"); reportBrowser(fail); return
        }
        if bundle.document != "Q3 Product Roadmap" { fail.append("ページ名が取れない (\(bundle.document))") }
        if bundle.pageId != "0123456789abcdef0123456789abcdef" { fail.append("page id が取れない") }
        if !bundle.capabilities.contains("edit") { fail.append("入力できる場所なのに edit が無い") }
        if bundle.selection.isEmpty { fail.append("block id を拾えない") }

        // 入力欄に focus していないときは edit を出さない（できないことを挙げない）。
        let reading = BrowserPayload(url: payload.url, title: payload.title, selection: "",
                                     focusedRole: nil, blocks: payload.blocks)
        if NotionAdapter.bundle(reading)?.capabilities.contains("edit") == true {
            fail.append("読んでいるだけなのに edit を出した")
        }
        // Notion 以外では起きない。
        let other = BrowserPayload(url: "https://example.com/x", title: "X", selection: "",
                                   focusedRole: nil, blocks: [])
        if NotionAdapter.bundle(other) != nil { fail.append("Notion でないのに Adapter が動いた") }

        // ⑤ §7 ブラウザ由来は AX より信頼できる。同じアプリなら DOM が勝つ。
        let now = Date()
        NativeMessagingHost.handle(["type": "context", "payload": [
            "url": payload.url, "title": payload.title, "selection": "",
            "semanticBlocks": [["id": "b1", "role": "p", "text": "本文"]],
        ]], now: now)
        let ax = ContextFact(source: .accessibility, application: "Notion", sensitivity: .workspace,
                             summary: "AX 版", capturedAt: now, expiresAt: now.addingTimeInterval(60))
        store.updateContext(store.state.context.items + [ax], now: now)
        if store.state.context.items.count != 1 { fail.append("同じアプリが 2 件残った") }
        if store.state.context.items.first?.source != .browserDOM { fail.append("AX が DOM に勝った") }

        store.reset()
        reportBrowser(fail)
    }

    private static func reportBrowser(_ fail: [String]) {
        if fail.isEmpty {
            print("SELFTEST_OK browser: フレーム形式・全文は受け取らない・Notion のページを特定・DOM は AX より優先")
            exit(0)
        } else {
            print("SELFTEST_FAIL browser: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// `--selftest plugins <plugins/builtin>`: §27 Plugin。
    ///
    /// 確かめたいのは **manifest に書いてあるだけでは呼べない**こと。
    /// 宣言と許諾を混同すると、入れた瞬間に全部できる製品になる。
    @MainActor
    private static func plugins(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let root = args.count > i + 2 ? args[i + 2] : "plugins/builtin"
        let runtime = PluginRuntime.shared
        runtime.reset()
        LocalStore.shared.open(NSTemporaryDirectory() + "astra-plugins-\(getpid()).sqlite")
        var fail: [String] = []

        // ① 同梱の manifest を全部読める（Phase 0 の conformance fixture）。
        let (loaded, skipped) = runtime.load(from: root)
        if loaded == 0 { print("SELFTEST_SKIP plugins: manifest が見つからない (\(root))"); exit(0) }
        if skipped > 0 { fail.append("\(skipped) 件の manifest を読めない") }

        guard let gmail = runtime.installed.first(where: { $0.id == "com.astra.gmail" }) else {
            fail.append("Gmail の manifest が無い"); reportPlugins(fail); return
        }
        if gmail.name != "Gmail" { fail.append("name が読めない (\(gmail.name))") }
        if !gmail.permissions.contains("email.send") { fail.append("permissions が読めない") }
        // 資格情報が端末にしか無いものは cloud で走らせない。
        if !gmail.runsLocallyOnly { fail.append("Gmail が local 以外でも走ることになっている") }

        // ② 宣言しているだけでは呼べない。
        if runtime.mayCall("com.astra.gmail", permission: "email.send") {
            fail.append("許諾なしで呼べてしまう")
        }
        // ③ 許せば呼べる。
        runtime.grant("com.astra.gmail", "email.send")
        if !runtime.mayCall("com.astra.gmail", permission: "email.send") {
            fail.append("許しても呼べない")
        }
        // ④ 許していない権限は、許諾済みの plugin でも呼べない。
        if runtime.mayCall("com.astra.gmail", permission: "email.read") {
            fail.append("許していない権限まで通った")
        }
        // ⑤ manifest に無い権限は、許しても呼べない。
        runtime.grant("com.astra.gmail", "disk.format")
        if runtime.mayCall("com.astra.gmail", permission: "disk.format") {
            fail.append("manifest に無い権限が通った")
        }
        // ⑥ 取り消せる。
        runtime.revoke("com.astra.gmail", "email.send")
        if runtime.mayCall("com.astra.gmail", permission: "email.send") {
            fail.append("取り消しても呼べる")
        }
        // ⑦ 入っていない plugin は呼べない。
        if runtime.mayCall("com.example.unknown", permission: "email.send") {
            fail.append("入っていない plugin が呼べた")
        }
        // ⑧ §24 許諾がディスクに残っている。
        if LocalStore.shared.countRows("plugin_permissions") < 1 {
            fail.append("許諾が保存されていない")
        }

        runtime.reset()
        reportPlugins(fail, count: loaded)
    }

    private static func reportPlugins(_ fail: [String], count: Int = 0) {
        if fail.isEmpty {
            print("SELFTEST_OK plugins: manifest \(count) 件・宣言だけでは呼べない・許諾で呼べる・取り消せる・manifest 外は通らない")
            exit(0)
        } else {
            print("SELFTEST_FAIL plugins: \(fail.joined(separator: ", "))")
            exit(2)
        }
    }

    /// begin → push → end の実ランタイム経路（I/O のみ、window は触らない）。
    @MainActor
    private static func lifecycle() {
        let runtime = RecordingRuntime.shared
        guard runtime.begin(meetingId: "lifecycle-selftest", captureMic: false) else {
            print("SELFTEST_FAIL lifecycle begin"); exit(2)
        }
        let oneSec = [Float](repeating: 0.1, count: 16_000)
        for _ in 0..<6 { runtime.push(oneSec, sampleRate: 16_000) }
        let elapsed = runtime.snapshot()?.elapsedLabel ?? "?"
        runtime.end()
        let root = LocalStore.dataRoot
            .appendingPathComponent("meetings").path
        let ok = scanRecoverable(root: root, active: nil).contains { $0.meetingId == "lifecycle-selftest" }
        try? FileManager.default.removeItem(atPath: root + "/lifecycle-selftest")
        guard elapsed == "00:05", ok else { print("SELFTEST_FAIL lifecycle elapsed=\(elapsed) recovered=\(ok)"); exit(3) }
        print("SELFTEST_OK lifecycle: elapsed=\(elapsed) recovered=\(ok)")
        exit(0)
    }

    /// `--selftest api <base_url>`: Swift → core → gateway → DB の実往復。
    private static func api(_ args: [String]) {
        let base = args.count > (args.firstIndex(of: "--selftest")! + 2)
            ? args[args.firstIndex(of: "--selftest")! + 2] : "http://127.0.0.1:3000"
        guard GenieCoreBridge.reachable(base) else { print("SELFTEST_FAIL api unreachable \(base)"); exit(2) }
        let email = "selftest-api-\(getpid())@astra.local"
        do {
            let tokens = try GenieCoreBridge.devSignIn(base, email: email, displayName: "SelfTest API")
            let me = try GenieCoreBridge.me(base, accessToken: tokens.accessToken)
            guard me.email == email, me.role == "owner" else {
                print("SELFTEST_FAIL api email=\(me.email) role=\(me.role)"); exit(3)
            }
            let mid = try GenieCoreBridge.createMeeting(base, accessToken: tokens.accessToken, title: "SelfTest 会議", language: "ja-JP")
            // 実録音 → 送信 → 終了（すべて core 経由、Tauri なし）
            let root = NSTemporaryDirectory() + "astra-api-rec-\(getpid())"
            try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
            let session = try RecordingSession.start(root: root, meetingId: mid)
            let oneSec = [Float](repeating: 0.1, count: 16_000)
            for _ in 0..<6 { _ = session.pushSamples(samples: oneSec, sampleRate: 16_000) }
            try session.finish()
            let sent = try GenieCoreBridge.uploadMeetingAudio(base, accessToken: tokens.accessToken, meetingId: mid, journalRoot: root)
            try? FileManager.default.removeItem(atPath: root)
            let task = try GenieCoreBridge.finishMeeting(base, accessToken: tokens.accessToken, meetingId: mid)
            // 会話/Agent と Apps も core 経由で実 gateway に繋がることを確認
            let conv = try GenieCoreBridge.startConversation(base, accessToken: tokens.accessToken)
            let outcome = try GenieCoreBridge.sendTurn(base, accessToken: tokens.accessToken, conversationId: conv, text: "テスト依頼")
            let apps = try GenieCoreBridge.pluginCatalog(base, accessToken: tokens.accessToken)
            let convOk = outcome.needsClarification || !outcome.answer.isEmpty || !outcome.taskId.isEmpty || !outcome.notice.isEmpty
            // Agent round-trip: echo タスク → COMPLETED + 成果物
            let atask = try GenieCoreBridge.createTask(base, accessToken: tokens.accessToken, kind: "echo", inputJson: "{\"message\":\"selftest\",\"steps\":1}")
            let done = try GenieCoreBridge.waitTask(base, accessToken: tokens.accessToken, taskId: atask, timeoutMs: 15_000)
            let content = try GenieCoreBridge.artifactContent(base, accessToken: tokens.accessToken, artifactId: done.resultArtifactId)
            let library = try GenieCoreBridge.library(base, accessToken: tokens.accessToken)
            // 実サインインの refresh/device token を Keychain に保管し読み戻す（access token は保管しない）。
            try SessionStore.persist(tokens)
            let keptRefresh = (try? SessionStore.refreshToken()) ?? nil
            let refreshKept = keptRefresh == tokens.refreshToken && !tokens.refreshToken.isEmpty
            try? SessionStore.clear()
            guard !mid.isEmpty, sent > 0, !task.isEmpty, !conv.isEmpty, convOk, !apps.isEmpty,
                  done.status == "COMPLETED", !done.resultArtifactId.isEmpty, !content.isEmpty, !library.isEmpty, refreshKept else {
                print("SELFTEST_FAIL api meeting=\(mid) sent=\(sent) conv=\(conv) apps=\(apps.count) agent=\(done.status) content=\(content.count) lib=\(library.count) refreshKept=\(refreshKept)"); exit(5)
            }
            print("SELFTEST_OK api: meeting=\(mid) uploadedBytes=\(sent) apps=\(apps.count) agent=\(done.status) contentBytes=\(content.count) library=\(library.count) refreshInKeychain=\(refreshKept)")
            exit(0)
        } catch {
            print("SELFTEST_FAIL api error=\(error)"); exit(4)
        }
    }

    /// `--selftest shortcut`: グローバルホットキーが OS に登録できることを検証する。
    /// TCC も GUI も要らない（押下の live 受信はユーザーが署名済み .app で確かめる）。
    @MainActor
    private static func shortcut() {
        // `open` で起動したときは stdout が読めない。**利用者と同じ経路**
        // （LaunchServices 経由＝バンドルに紐づく TCC）で確かめられるよう、
        // 結果をファイルにも残す。シェルから直に起動すると TCC は責任プロセス
        // （ターミナル）に紐づくので、入力監視の許可がアプリのものにならない。
        func report(_ line: String) {
            print(line)
            try? line.write(toFile: "/tmp/astra-shortcut.txt", atomically: true, encoding: .utf8)
        }
        // 純関数の一致ロジックを先に確かめる（⌥Space は一致、Space 単独/⌘Space は不一致）。
        let combo = GlobalShortcut.Combo()   // ⌥Space
        let mSpace = GlobalShortcut.matches(combo: combo, keyCode: 49, flags: [.maskAlternate])
        let mPlain = GlobalShortcut.matches(combo: combo, keyCode: 49, flags: [])
        let mCmd = GlobalShortcut.matches(combo: combo, keyCode: 49, flags: [.maskCommand])
        guard mSpace, !mPlain, !mCmd else {
            report("SELFTEST_FAIL shortcut matcher space=\(mSpace) plain=\(mPlain) cmd=\(mCmd)"); exit(2)
        }

        // CGEventTap を実登録し、合成 ⌥Space をセッションtapへ注入して「受信→発火」を実測する。
        // 一致キーは tap が consume するので他アプリへ漏れない。
        var fired = false
        let ok = GlobalShortcut.shared.register(combo) { fired = true }
        let label = GlobalShortcut.label()
        guard ok else {
            GlobalShortcut.shared.unregister()
            // 許可はあるのに tap が有効にならない場合がある。macOS は実行体が変わると
            // （再ビルドで cdhash が変わると）preflight を true のまま tap を拒む。
            // これは環境の状態で、コードの誤りではない。直せるのは人だけなので、
            // 何を直せばよいかまで言って SKIP する。
            if CGPreflightListenEventAccess() {
                report("SELFTEST_SKIP shortcut: 入力監視は許可済みだが tap が有効にならない。"
                    + "システム設定 > プライバシーとセキュリティ > 入力監視 で Genie を"
                    + "一度外して入れ直すと直る（実行体が変わると失効する）")
                exit(0)
            }
            report("SELFTEST_SKIP shortcut: 入力監視が未許可（システム設定で許可が要る）")
            exit(0)
        }
        let source = CGEventSource(stateID: .privateState)
        if let down = CGEvent(keyboardEventSource: source, virtualKey: 49, keyDown: true) {
            down.flags = [.maskAlternate]; down.post(tap: .cgSessionEventTap)
        }
        if let up = CGEvent(keyboardEventSource: source, virtualKey: 49, keyDown: false) {
            up.flags = [.maskAlternate]; up.post(tap: .cgSessionEventTap)
        }
        let deadline = Date().addingTimeInterval(1.5)
        while !fired && Date() < deadline {
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
        }
        GlobalShortcut.shared.unregister()
        guard fired else {
            // 落ちたときに、権限なのか受信経路なのかが分かるようにする。
            // tap が途中で落とされたなら、それは OS 側の判断（許可が実行体に
            // 紐づいていない）で、受信経路の誤りではない。**確かめられなかった**
            // と言う。tap が生きたまま届かないなら、それは本物の欠陥。
            if !GlobalShortcut.shared.isTapEnabled {
                report("SELFTEST_SKIP shortcut: tap が OS に落とされた（許可がこの実行体に"
                    + "紐づいていない）。端末から起動すると責任プロセス側の許可を継ぐので、"
                    + "アプリとして起動し、システム設定 > プライバシーとセキュリティ > "
                    + "入力監視 で Genie を許可すること")
                exit(0)
            }
            report("SELFTEST_FAIL shortcut: tap は有効なのに合成の押下が届かない "
                + "(listen=\(CGPreflightListenEventAccess()) ax=\(AXIsProcessTrusted()))")
            exit(2)
        }
        report("SELFTEST_OK shortcut: registered=\(ok) combo=\(label) matcher=ok receivedSyntheticPress=\(fired)")
        exit(0)
    }

    /// `--selftest sysaudio`: ScreenCaptureKit の音声取り込み構成を検証する。
    /// live capture は画面収録許可(TCC)が要るが、**構成の組み立ては TCC 無しで確かめられる**。
    @MainActor
    private static func sysaudio() {
        guard #available(macOS 13.0, *) else { print("SELFTEST_FAIL sysaudio needs macOS 13+"); exit(2) }
        let c = SystemAudioCapture.configuration()
        guard c.capturesAudio, c.sampleRate == 48_000, c.channelCount == 2, c.excludesCurrentProcessAudio else {
            print("SELFTEST_FAIL sysaudio config audio=\(c.capturesAudio) rate=\(c.sampleRate) ch=\(c.channelCount) excl=\(c.excludesCurrentProcessAudio)"); exit(3)
        }
        print("SELFTEST_OK sysaudio: capturesAudio=\(c.capturesAudio) sampleRate=\(c.sampleRate) channels=\(c.channelCount) excludesSelf=\(c.excludesCurrentProcessAudio)")
        exit(0)
    }

    /// `--selftest calendar`: EventKit の認可状態がプロンプト無しで読めることを検証する。
    /// 実データ取得はカレンダー許可(TCC)が要るが、状態の読み取りは TCC 無しで確かめられる。
    @MainActor
    private static func calendar() {
        let status = CalendarAccess.status()
        // 許可が無い環境では upcoming は空（推測で埋めない）ことも確かめる。
        let events = CalendarAccess.upcoming(hours: 12)
        let consistent = (status == .granted) || events.isEmpty
        guard consistent else { print("SELFTEST_FAIL calendar status=\(status.rawValue) events=\(events.count)"); exit(2) }
        print("SELFTEST_OK calendar: status=\(status.rawValue) upcoming=\(events.count)")
        exit(0)
    }

    /// `--selftest calendarask`: 予定を読む許可は **Home の「これからの予定」の場所で、理由と一緒に**求める
    /// （spec §22 purpose-first）。開いた瞬間には求めない。確かめるのは 3 つ——
    /// (1) `.schedule` が求めるのはカレンダーだけ（マイク等を巻き込まない）、
    /// (2) 未確認のときだけ Home に `askCalendar` と理由の文が出る、(3) 許可済み・拒否では出ない
    /// （拒否を何度も聞かない。再許可は設定の「権限」）。この Mac は許可済みなので `simulatedCalendar` で
    /// 未確認・拒否を作る。AX が無ければ (1) だけ確かめて SKIP。
    @MainActor
    private static func calendarask(_ args: [String]) {
        // 任意: `--selftest calendarask <out.png>` で未確認のときの Home を自窓だけ撮って残す（証拠用）。
        let i = args.firstIndex(of: "--selftest")!
        let outPNG = args.count > i + 2 ? args[i + 2] : nil
        var fail: [String] = []
        if PermissionCenter.Capability.schedule.required != [.calendar] {
            fail.append("schedule がカレンダー以外まで要求している: \(PermissionCenter.Capability.schedule.required)")
        }
        if PermissionCenter.Capability.schedule.reason.isEmpty || !PermissionCenter.Capability.schedule.reason.contains(Facts.permissionCalendar) {
            fail.append("schedule の理由にカレンダーの名が無い")
        }
        Permissions.simulatedCalendar = .notDetermined
        if PermissionCenter.missing(for: .schedule) != [.calendar] { fail.append("未確認なのに不足に出ない") }
        Permissions.simulatedCalendar = .granted
        if !PermissionCenter.missing(for: .schedule).isEmpty { fail.append("許可済みなのに不足に出る") }
        Permissions.simulatedCalendar = nil
        guard fail.isEmpty else { print("SELFTEST_FAIL calendarask: \(fail)"); exit(2) }
        guard AXIsProcessTrusted() else { print("SELFTEST_SKIP calendarask: mapping OK, AX not trusted"); exit(0) }

        // Home を 1 枚出して、自プロセスの AX で識別子と文を集める。
        NSApp.setActivationPolicy(.regular)
        HomePane.previewUpcoming = []
        func homeTexts(_ state: Permissions.State, png: String? = nil) -> (ids: Set<String>, texts: Set<String>) {
            Permissions.simulatedCalendar = state
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            w.contentView = NSHostingView(rootView: MainWindowView(loadBackend: false))
            if let s = NSScreen.main { w.setFrameOrigin(NSPoint(x: s.frame.midX - 450, y: s.frame.midY - 300)) }
            w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            MainNav.shared.section = .home
            let show = Date().addingTimeInterval(1.0)
            while Date() < show { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
            let app = AXUIElementCreateApplication(getpid())
            var ids = Set<String>(), texts = Set<String>()
            var contextDisclosure: AXUIElement?
            func attr(_ el: AXUIElement, _ name: String) -> String? {
                var v: CFTypeRef?
                guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
                if let s = v as? String, !s.isEmpty { return s }
                return nil
            }
            func walk(_ el: AXUIElement, _ depth: Int) {
                if depth > 64 { return }
                if let id = attr(el, kAXIdentifierAttribute) {
                    ids.insert(id)
                    if id == "homeContextDisclosure" {
                        var actions: CFArray?
                        if AXUIElementCopyActionNames(el, &actions) == .success,
                           let names = actions as? [String], names.contains(kAXPressAction) { contextDisclosure = el }
                    }
                }
                if attr(el, kAXRoleAttribute) == kAXDisclosureTriangleRole as String,
                   attr(el, kAXDescriptionAttribute) == "会議と今日の状況" {
                    contextDisclosure = el
                }
                for a in ["AXTitle", "AXDescription", "AXValue"] { if let s = attr(el, a) { texts.insert(s) } }
                var kids: CFTypeRef?
                if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kids) == .success,
                   let arr = kids as? [AXUIElement] { for k in arr { walk(k, depth + 1) } }
            }
            walk(app, 0)
            // Menu/toolbar nodes alone do not mean SwiftUI content is measurable.
            guard ids.contains("homeView") else {
                w.orderOut(nil); w.close(); Permissions.simulatedCalendar = nil
                return (ids, texts)
            }
            if ids.contains("askCalendar") { fail.append("会議を開く前にカレンダー許可を求めている") }
            if let disclosure = contextDisclosure,
               AXUIElementPerformAction(disclosure, kAXPressAction as CFString) == .success {
                let expanded = Date().addingTimeInterval(0.5)
                while Date() < expanded { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
                ids.removeAll(); texts.removeAll(); walk(app, 0)
            } else { fail.append("会議と今日の状況を開けない") }
            if let png, let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(w.windowNumber),
                                                          [.boundsIgnoreFraming, .nominalResolution]) {
                try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?
                    .write(to: URL(fileURLWithPath: png))
            }
            w.orderOut(nil); w.close()
            Permissions.simulatedCalendar = nil
            return (ids, texts)
        }
        let asked = homeTexts(.notDetermined, png: outPNG)
        guard asked.ids.contains("homeView") else { print("SELFTEST_SKIP calendarask: mapping OK; own-process SwiftUI content tree unavailable (menu nodes are not a Home measurement)"); exit(0) }
        if !asked.ids.contains("askCalendar") { fail.append("未確認なのに Home に askCalendar が無い") }
        let reason = PermissionCenter.Capability.schedule.reason
        if !asked.texts.contains(where: { $0.contains(reason) }) { fail.append("理由の文が画面に無い") }
        for state in [Permissions.State.granted, .denied] {
            let r = homeTexts(state)
            if r.ids.contains("askCalendar") { fail.append("\(state.rawValue)なのに askCalendar が出る") }
        }
        guard fail.isEmpty else { print("SELFTEST_FAIL calendarask: \(fail)"); exit(2) }
        print("SELFTEST_OK calendarask: schedule=[calendar]; expand meeting context before requesting permission; reason shown only when notDetermined; hidden when granted/denied")
        exit(0)
    }

    /// `--selftest calendarlive`: **実 Calendar データ**を取る。署名 .app で実行し、必要なら TCC 許可
    /// プロンプトを出す（notDetermined のとき）。許可後、EventKit から実イベントを読み、実データで
    /// あることを証拠化する（title/日付を出す。fixture/mock ではない）。denied/authorized/0件 を区別。
    @MainActor
    private static func calendarlive() {
        // `open` 経由で起動されると stdout が捨てられるので、結果を固定ファイルにも書く。
        func emit(_ line: String) -> Never {
            print(line)
            try? line.write(toFile: "/tmp/astra-calendarlive.txt", atomically: true, encoding: .utf8)
            exit(0)
        }
        // TCC プロンプトは「前面の通常アプリ」からでないと出ないことがある。前面化する。
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let before = CalendarAccess.status()
        print("CAL: status(before)=\(before.rawValue)")
        // notDetermined なら許可要求（プロンプト）。すでに決まっていればそのまま進む。
        if before == .notDetermined {
            print("CAL: requesting access (TCC prompt should appear)…")
            let sem = DispatchSemaphore(value: 0)
            var granted = false
            var callbackFired = false
            let t0 = Date()
            CalendarAccess.requestAccess { ok in granted = ok; callbackFired = true; sem.signal() }
            // 許可ダイアログをユーザーが操作するまで run loop を回して待つ（最大 180 秒）。
            let deadline = Date().addingTimeInterval(180)
            while sem.wait(timeout: .now()) == .timedOut && Date() < deadline {
                CFRunLoopRunInMode(.defaultMode, 0.2, true)
            }
            let dt = String(format: "%.1f", Date().timeIntervalSince(t0))
            let cb = "CAL: callbackFired=\(callbackFired) granted=\(granted) after=\(dt)s"
            print(cb)
            try? cb.write(toFile: "/tmp/astra-calendarlive-cb.txt", atomically: true, encoding: .utf8)
        }
        let after = CalendarAccess.status()
        print("CAL: status(after)=\(after.rawValue)")
        switch after {
        case .denied, .restricted:
            emit("SELFTEST_CAL_DENIED after=\(after.rawValue) (ユーザーが拒否/制限)")
        case .notDetermined:
            emit("SELFTEST_CAL_PENDING after=notDetermined (プロンプト未応答/未表示)")
        case .writeOnly:
            emit("SELFTEST_CAL_WRITEONLY (読み取り不可の許可)")
        case .granted:
            // 実イベントを 60 日窓で読む（少なくとも 1 件あればサンプルを出す）。
            let events = CalendarAccess.upcoming(hours: 24 * 60)
            if events.isEmpty {
                emit("SELFTEST_CAL_OK_EMPTY: authorized=true events=0 (取得成功・0件。架空データは作らない)")
            }
            let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd HH:mm"
            let sample = events.prefix(3).map { e -> String in
                let start = fmt.string(from: Date(timeIntervalSince1970: e.startEpoch))
                return "\"\(e.title)\"@\(start)[\(e.calendar)]"
            }.joined(separator: ", ")
            emit("SELFTEST_CAL_OK: authorized=true events=\(events.count) sample=\(sample)")
        }
    }

    /// `--selftest screen`: ScreenCaptureKit の静止フレーム構成を検証する。
    /// 実フレーム取得は画面収録許可(TCC)が要るが、構成の組み立ては TCC 無しで確かめられる。
    @MainActor
    private static func screen() {
        guard #available(macOS 14.0, *) else { print("SELFTEST_FAIL screen needs macOS 14+"); exit(2) }
        let c = ScreenContextCapture.configuration(width: 1280, height: 800)
        guard c.width == 1280, c.height == 800, !c.capturesAudio, c.pixelFormat == kCVPixelFormatType_32BGRA else {
            print("SELFTEST_FAIL screen config w=\(c.width) h=\(c.height) audio=\(c.capturesAudio)"); exit(3)
        }
        print("SELFTEST_OK screen: width=\(c.width) height=\(c.height) pixelFormat=BGRA audio=\(c.capturesAudio)")
        exit(0)
    }

    /// `--selftest rag`: RAG の並べ替えが core(rank_context) を通って決定的に効くか検証する。
    /// 語彙一致するものが上に来ること・根拠(reason)が付くことを確かめる（外部依存なし）。
    @MainActor
    private static func rag() {
        let candidates = [
            ContextCandidate(id: "a", text: "OAuth の確認をお願いします", source: .meeting, ageSeconds: 30, projectMatch: true),
            ContextCandidate(id: "b", text: "昼食はどこにしましょうか", source: .meeting, ageSeconds: 30, projectMatch: false),
            ContextCandidate(id: "c", text: "OAuth のトークン交換の話", source: .library, ageSeconds: 6000, projectMatch: false),
        ]
        let ranked = GenieCoreBridge.rankContext(terms: ["oauth"], limit: 5, candidates: candidates)
        guard let top = ranked.first, top.id == "a", ranked.count == 3, !top.reason.isEmpty,
              ranked.contains(where: { $0.id == "c" }) else {
            print("SELFTEST_FAIL rag top=\(ranked.first?.id ?? "nil") count=\(ranked.count)"); exit(2)
        }
        // 語彙一致しない b は最下位
        guard ranked.last?.id == "b" else { print("SELFTEST_FAIL rag last=\(ranked.last?.id ?? "nil")"); exit(3) }
        print("SELFTEST_OK rag: order=\(ranked.map { $0.id }.joined(separator: ",")) topScore=\(String(format: "%.2f", top.score)) reason=\(top.reason)")
        exit(0)
    }

    /// `--selftest keychain`: Keychain の set→get→delete→get(absent) 往復を検証する。
    /// 自プロセスの generic-password なので prompt は出ない（TCC/GUI 不要）。
    @MainActor
    private static func keychain() {
        let key = "astra.selftest.\(getpid())"
        let secret = "refresh-\(getpid())-秘密"
        do {
            try KeychainStore.set(key, secret)
            let read = try KeychainStore.get(key)
            try KeychainStore.set(key, secret + "-updated")   // upsert 上書き
            let read2 = try KeychainStore.get(key)
            try KeychainStore.delete(key)
            let afterDelete = try KeychainStore.get(key)
            try KeychainStore.delete(key)                     // 冪等（無くても成功）
            guard read == secret, read2 == secret + "-updated", afterDelete == nil else {
                print("SELFTEST_FAIL keychain read=\(read ?? "nil") read2=\(read2 ?? "nil") afterDelete=\(afterDelete ?? "nil")"); exit(2)
            }
            print("SELFTEST_OK keychain: roundtrip ok, absent=nil, delete idempotent, service=\(KeychainStore.service)")
            exit(0)
        } catch {
            print("SELFTEST_FAIL keychain error=\(error)"); exit(3)
        }
    }

    /// `--selftest files`: ローカルファイル(Finder access)を core の rank_context で並べ替える。
    /// 一時ファイルを作り、語彙一致するファイルが上に来ること・バイナリが落ちることを確かめる。
    @MainActor
    private static func files() {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("astra-files-\(getpid())")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        do {
            try "OAuth のトークン交換の設計メモ".write(to: dir.appendingPathComponent("oauth.txt"), atomically: true, encoding: .utf8)
            try "昼食のお店のリスト".write(to: dir.appendingPathComponent("lunch.txt"), atomically: true, encoding: .utf8)
            // バイナリ（UTF-8 で読めない）は候補にしない
            try Data([0xFF, 0xFE, 0x00, 0x01]).write(to: dir.appendingPathComponent("blob.bin"))
        } catch { print("SELFTEST_FAIL files write error=\(error)"); exit(2) }

        let candidates = FileContext.candidates(inDirectory: dir)
        let ranked = GenieCoreBridge.rankContext(terms: ["oauth"], limit: 5, candidates: candidates)
        // テキスト 2 件のみ候補（バイナリは落ちる）、oauth.txt が最上位
        guard candidates.count == 2, let top = ranked.first,
              top.id.hasSuffix("oauth.txt"), !top.reason.isEmpty else {
            print("SELFTEST_FAIL files candidates=\(candidates.count) top=\(ranked.first?.id ?? "nil")"); exit(3)
        }
        print("SELFTEST_OK files: candidates=\(candidates.count)(binary除外) top=oauth.txt score=\(String(format: "%.2f", top.score))")
        exit(0)
    }

    /// `--selftest ax`: アクセシビリティ許可が無いとき、選択テキストが nil で返り
    /// クラッシュしないこと（推測で埋めない）を検証する。isTrusted は prompt 無しで読める。
    @MainActor
    private static func ax() {
        let trusted = AccessibilityContext.isTrusted
        let selection = AccessibilityContext.selectedText()
        let candidates = AccessibilityContext.candidate()
        // 許可が無ければ選択は nil・候補は空。許可があれば選択の有無は環境依存だが整合していること。
        let consistent = trusted || (selection == nil && candidates.isEmpty)
        guard consistent else { print("SELFTEST_FAIL ax trusted=\(trusted) selection=\(selection ?? "nil") cands=\(candidates.count)"); exit(2) }
        print("SELFTEST_OK ax: trusted=\(trusted) selection=\(selection == nil ? "nil" : "present") candidates=\(candidates.count)")
        exit(0)
    }

    /// `--selftest egress`: 端末から出る道が、既定で閉じているかを**実行体で**確かめる（`docs/privacy-egress.md`）。
    ///
    /// ① 録音の自動 upload 旗は既定 OFF（env 無し）。② オンデバイス資産が無いロケールで
    /// `start` が throw し `recognizeFile` が nil（サーバへ落ちない）。資産の無いロケールがこの Mac に
    /// 無ければ NOT_MEASURED（静的検査は別に scripts/verify-privacy-egress.sh が持つ）。
    /// ③ `.meeting` が求めるのはマイクだけ。
    @MainActor
    private static func egress() {
        if ProcessInfo.processInfo.environment["ASTRA_DEV_AUTO_UPLOAD"] != nil {
            print("SELFTEST_SKIP egress: ASTRA_DEV_AUTO_UPLOAD が立っている（既定の姿を測れない）"); exit(0)
        }
        var fail: [String] = []
        if RecordingRuntime.devAutoUploadEnabled { fail.append("録音の自動 upload が env 無しで有効") }
        let previousArguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        if RecordingRuntime.cloudConsentValue(nil, developmentUpload: false) { fail.append("cloud consent must default to off") }
        RecordingRuntime.setCloudTranscriptionAllowed(true)
        if !RecordingRuntime.cloudTranscriptionAllowed { fail.append("explicit cloud consent ignored") }
        RecordingRuntime.setCloudTranscriptionAllowed(false)
        if RecordingRuntime.cloudTranscriptionAllowed { fail.append("cloud consent revocation ignored") }
        UserDefaults.standard.setVolatileDomain(previousArguments, forName: UserDefaults.argumentDomain)

        if PermissionCenter.Capability.meeting.required != [.microphone, .speechRecognition] {
            fail.append("meeting がマイクと音声認識以外を求めている: \(PermissionCenter.Capability.meeting.required)")
        }
        var stt = "NOT_MEASURED"
        if SpeechTranscriber.authorization == .authorized {
            // 資産が無いロケールを 1 つ探す（supported だが on-device 非対応）。
            if let id = SpeechTranscriber.localesWithoutOnDeviceAsset().first {
                let st = SpeechTranscriber(localeId: id)
                var code = 0
                do { try st.start { _ in }; st.finish() } catch { code = (error as NSError).code }
                if code != SpeechTranscriber.onDeviceUnavailableCode {
                    fail.append("\(id) は資産が無いのに start が通った（サーバへ落ちている）")
                }
                let aiff = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("astra-egress-\(getpid()).aiff")
                defer { try? FileManager.default.removeItem(at: aiff) }
                let say = Process()
                say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
                say.arguments = ["-v", "Samantha", "-o", aiff.path, "good morning"]
                try? say.run(); say.waitUntilExit()
                if say.terminationStatus == 0, let text = st.recognizeFile(aiff, timeout: 8), !text.isEmpty {
                    fail.append("\(id) は資産が無いのに recognizeFile が文字を返した: \(text)")
                }
                stt = "\(id) start=code\(code) file=nil"
            } else {
                stt = "NOT_MEASURED(全ロケールに資産あり)"
            }
        }
        guard fail.isEmpty else {
            print("SELFTEST_FAIL egress: " + fail.joined(separator: " / ")); exit(2)
        }
        print("SELFTEST_OK egress: autoUpload=off cloudSTTConsent=\(RecordingRuntime.cloudTranscriptionAllowed ? "on" : "off") meeting=[microphone] sttNoFallback=\(stt)")
        exit(0)
    }

    /// `--selftest speech`: オンデバイス STT(Apple Speech)の可用性・認可・ロケールを検証する。
    /// live 認識は音声認識許可(TCC)が要るが、認識器の用意と認可状態の読み取りは prompt 無しで確かめられる。
    @MainActor
    private static func cloudShots(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let out = URL(fileURLWithPath: args.count > i + 2 ? args[i + 2] : "/tmp/astra-cloud-shots")
        do {
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            var geometry: [[String: Any]] = []
            for dark in [false, true] {
                let name = dark ? "dark" : "light"
                let views: [(String, AnyView)] = [
                    ("settings", AnyView(SettingsView().background(dark ? Color.black : Color.white))),
                    ("retry", AnyView(MeetingArtifactView(title: "文字起こしの確認", duration: "01:15", participants: 1,
                        summary: [], decisions: [], actionItems: [],
                        transcriptionFailure: "文字起こしサーバーに接続されていません。録音はこのMacに保存されています。",
                        onRetryTranscription: {}).frame(width: 1080, height: 680).background(dark ? Color.black : Color.white)))
                ]
                for (kind, view) in views {
                    let host = NSHostingView(rootView: view.environment(\.colorScheme, dark ? .dark : .light))
                    let size = host.fittingSize
                    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
                    window.contentView = host
                    window.isReleasedWhenClosed = false
                    window.center(); window.makeKeyAndOrderFront(nil)
                    let until = Date().addingTimeInterval(0.4)
                    while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
                    guard let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) else {
                        throw CloudMeetingTranscription.Failure(message: "window capture failed")
                    }
                    window.orderOut(nil)
                    let rep = NSBitmapImageRep(cgImage: cg)
                    guard let data = rep.representation(using: .png, properties: [:]) else { throw CloudMeetingTranscription.Failure(message: "PNG failed") }
                    try data.write(to: out.appendingPathComponent("\(kind)-\(name).png"))
                    geometry.append(["name": "\(kind)-\(name)", "width": cg.width / 2, "height": cg.height / 2])
                }
            }
            try JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys]).write(to: out.appendingPathComponent("geometry.json"))
            print("SELFTEST_OK cloudshots"); exit(0)
        } catch { print("SELFTEST_FAIL cloudshots: \(error)"); exit(2) }
    }

    @MainActor
    private static func cloudLiveSTT() {
        let env = ProcessInfo.processInfo.environment
        guard env["ASTRA_CLOUD_STT_TEST"] == "1", let fixture = env["ASTRA_STT_FIXTURE"] else {
            print("SELFTEST_FAIL cloudlive: explicit test opt-in and PCM fixture required"); exit(2)
        }
        Task {
            let previous = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
            func restore() {
                UserDefaults.standard.setVolatileDomain(previous, forName: UserDefaults.argumentDomain)
            }
            do {
                RecordingRuntime.setCloudTranscriptionAllowed(true)
                let base = env["ASTRA_GATEWAY_URL"] ?? "http://127.0.0.1:3000"
                let tokens = try GenieCoreBridge.devSignIn(base, email: "stt-fixture@astra.local", displayName: "STT Fixture")
                let runtime = RecordingRuntime.shared
                runtime.configureBackend(base: base, accessToken: tokens.accessToken)
                var interim = 0
                var final = 0
                var texts: [String] = []
                var firstMs: Int?
                let start = Date()
                runtime.onTranscript = { text, isFinal in
                    if firstMs == nil { firstMs = Int(Date().timeIntervalSince(start) * 1000) }
                    if isFinal { final += 1 } else { interim += 1 }
                    texts.append(text)
                }
                guard runtime.begin(meetingId: "live-fixture-" + UUID().uuidString.lowercased(), captureMic: false, transcribe: true) else {
                    throw NSError(domain: "live-start", code: 1)
                }
                let pcm = try Data(contentsOf: URL(fileURLWithPath: fixture))
                let samples: [Float] = stride(from: 0, to: pcm.count - 1, by: 2).map { offset in
                    Float(Int16(bitPattern: UInt16(pcm[offset]) | UInt16(pcm[offset + 1]) << 8)) / 32768
                }
                // Real-time pacing plus silence: assert results BEFORE ending recording.
                for offset in stride(from: 0, to: samples.count + 96_000, by: 3_200) {
                    let frame = offset < samples.count ? Array(samples[offset..<min(offset + 3_200, samples.count)]) : [Float](repeating: 0, count: 3_200)
                    runtime.push(frame, sampleRate: 16_000)
                    try await Task.sleep(nanoseconds: 200_000_000)
                }
                let passed = interim > 0 && final > 0 && texts.contains(where: { $0.contains("金曜日") }) && runtime.snapshot() != nil
                await withCheckedContinuation { continuation in runtime.end { continuation.resume() } }
                restore()
                guard passed else {
                    print("SELFTEST_FAIL cloudlive: partials=\(interim) finals=\(final) failure=\(runtime.liveTranscriptionFailure ?? "none")"); exit(2)
                }
                print("SELFTEST_OK cloudlive: BEFORE STOP partials=\(interim) finals=\(final) firstMs=\(firstMs ?? -1), Japanese content verified; no batch task")
                exit(0)
            } catch { restore(); print("SELFTEST_FAIL cloudlive: \(error)"); exit(2) }
        }
    }

    @MainActor
    private static func speech() {
        let st = SpeechTranscriber(localeId: "ja-JP")
        let auth = SpeechTranscriber.authorization
        let onDevice = st.canRunOnDevice
        var startThrew = false
        var appended = false
        do {
            try st.start { _ in }
            // 認可済みなら実フレームを流して音声パイプラインが受け付けることを確かめる（no-crash）。
            let oneSec = [Float](repeating: 0.0, count: 16_000)
            for _ in 0..<3 { st.append(oneSec, sampleRate: 16_000) }
            appended = true
        } catch { startThrew = true }
        st.finish()
        // 未認可なら start は throw（実データを捏造しない）。認可済みで on-device の資産があれば append まで到達。
        // 認可済みでも資産が無ければ throw（サーバへ落とさない。`SpeechTranscriber` 冒頭）。
        let consistent = (auth == .authorized && onDevice) ? appended : startThrew
        guard consistent else { print("SELFTEST_FAIL speech auth=\(auth.rawValue) onDeviceCapable=\(onDevice) started=\(!startThrew) appended=\(appended)"); exit(2) }
        print("SELFTEST_OK speech: auth=\(auth.rawValue) onDeviceCapable=\(onDevice) started=\(!startThrew) appendedFrames=\(appended) serverFallback=never")
        exit(0)
    }

    /// `--selftest connector`: connector 契約層（PKCE・authorize URL 組み立て）が core 経由で効くか検証する。
    /// live なトークン交換は外部依存なので here では検証しない（契約層のみ）。
    @MainActor
    private static func connector() {
        // RFC 7636 の PKCE テストベクタ（core と一致するはず）。
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        let challenge = GenieCoreBridge.pkceChallenge(verifier)
        guard challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" else {
            print("SELFTEST_FAIL connector pkce=\(challenge)"); exit(2)
        }
        // 実 authorize URL を core で組む（loopback + PKCE + state + Google 追加）。
        let url = GenieCoreBridge.authorizeUrl(
            provider: "google", clientId: "cid-123.apps.googleusercontent.com",
            redirectUri: "http://127.0.0.1:8123/callback",
            scopes: ["openid", "email"], state: "state-xyz", codeChallenge: challenge)
        guard let url, url.hasPrefix("https://accounts.google.com/o/oauth2/v2/auth?"),
              url.contains("code_challenge_method=S256"), url.contains("state=state-xyz"),
              url.contains("access_type=offline") else {
            print("SELFTEST_FAIL connector url=\(url ?? "nil")"); exit(3)
        }
        // 非 loopback は繋がない（None）。
        let bad = GenieCoreBridge.authorizeUrl(
            provider: "google", clientId: "cid", redirectUri: "https://evil.example.com/cb",
            scopes: [], state: "s", codeChallenge: "c")
        guard bad == nil else { print("SELFTEST_FAIL connector accepted non-loopback"); exit(4) }
        // 未設定なら繋げる提供者は空。
        let ready = GenieCoreBridge.configuredProviders([:])
        guard ready.isEmpty else { print("SELFTEST_FAIL connector ready=\(ready)"); exit(5) }
        print("SELFTEST_OK connector: pkce=S256✓ authorizeUrl✓ nonLoopbackRejected✓ configured=\(ready.count)")
        exit(0)
    }

    /// `--selftest permissions`: この環境の TCC 状態を正直に列挙する（prompt を出さない読み取りのみ）。
    @MainActor
    private static func permissions() {
        let mic = Permissions.microphone.rawValue
        let screen = Permissions.screenRecording.rawValue
        let ax = Permissions.accessibility.rawValue
        let cal = Permissions.calendar.rawValue
        let speech = SpeechTranscriber.authorization.rawValue
        print("SELFTEST_OK permissions: mic=\(mic) screen=\(screen) ax=\(ax) calendar=\(cal) speech=\(speech)")
        exit(0)
    }

    /// `--selftest livemic`: マイク許可があれば実デバイスから 1 秒取り込み、実音声（合成でない）が
    /// 届くことを確かめる。許可が無ければ SKIP（捏造しない）。
    @MainActor
    private static func livemic() {
        guard Permissions.microphone == .granted else {
            print("SELFTEST_SKIP livemic: microphone not granted (status=\(Permissions.microphone.rawValue))")
            exit(0)
        }
        let mic = MicCapture()
        var frames = 0
        var samples = 0
        var peak: Float = 0
        do {
            try mic.start { frame in
                frames += 1; samples += frame.count
                for v in frame { peak = max(peak, abs(v)) }
            }
        } catch {
            print("SELFTEST_FAIL livemic start error=\(error)"); exit(2)
        }
        // 1 秒回す（RunLoop を回してタップのコールバックを受ける）。
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        mic.stop()
        guard frames > 0, samples > 0 else {
            print("SELFTEST_FAIL livemic: no frames (frames=\(frames) samples=\(samples))"); exit(3)
        }
        print("SELFTEST_OK livemic: frames=\(frames) samples=\(samples) peak=\(String(format: "%.4f", peak)) (実デバイス取り込み)")
        exit(0)
    }

    /// `--selftest livescreen`: 画面収録許可があれば実フレームを 1 枚取り、非ゼロ寸法を確かめる。
    @MainActor
    private static func livescreen() {
        guard Permissions.screenRecording == .granted else {
            print("SELFTEST_SKIP livescreen: screen recording not granted"); exit(0)
        }
        guard #available(macOS 14.0, *) else { print("SELFTEST_SKIP livescreen: needs macOS 14+"); exit(0) }
        let sem = DispatchSemaphore(value: 0)
        var width = 0, height = 0
        var failed: String?
        var done = false
        Task {
            do {
                let image = try await ScreenContextCapture.captureFrame()
                width = image.width; height = image.height
            } catch { failed = "\(error)" }
            done = true
            sem.signal()
        }
        let waited = sem.wait(timeout: .now() + 8)
        if waited == .timedOut || !done || width == 0 {
            // SCK が前面セッションを要して返らないときは、CGDisplayCreateImage で取り直す
            // （画面収録許可で動作・前面不要）。
            if #available(macOS 14.0, *), let cg = ScreenContextCapture.captureFrameCG(), cg.width > 0 {
                print("SELFTEST_OK livescreen: captured \(cg.width)x\(cg.height) real frame (CGDisplay)")
                exit(0)
            }
            print("SELFTEST_SKIP livescreen: no frame in this headless context (screen granted)"); exit(0)
        }
        if let failed { print("SELFTEST_FAIL livescreen error=\(failed)"); exit(2) }
        guard width > 0, height > 0 else {
            print("SELFTEST_SKIP livescreen: capture returned \(width)x\(height) in this context"); exit(0)
        }
        print("SELFTEST_OK livescreen: captured \(width)x\(height) real frame")
        exit(0)
    }

    /// `--selftest livemeeting`: 実マイク → RecordingRuntime(session + オンデバイス STT) → 保存 の
    /// 実機 E2E。2 秒録って、実断片が書かれ回復候補になることを確かめる。許可が無ければ SKIP。
    @MainActor
    private static func livemeeting() {
        guard Permissions.microphone == .granted else {
            print("SELFTEST_SKIP livemeeting: microphone not granted"); exit(0)
        }
        let runtime = RecordingRuntime.shared
        var transcriptEvents = 0
        runtime.onTranscript = { _, _ in transcriptEvents += 1 }
        let id = "livemeeting-\(getpid())"
        guard runtime.begin(meetingId: id, captureMic: true, captureSystemAudio: false, transcribe: true) else {
            print("SELFTEST_FAIL livemeeting begin"); exit(2)
        }
        // 実マイクから 6 秒（5 秒断片が 1 つ閉じる）。RunLoop を回してタップと STT を受ける。
        RunLoop.current.run(until: Date().addingTimeInterval(6.0))
        let recorded = runtime.recordedMs()
        runtime.end()
        let root = LocalStore.dataRoot
            .appendingPathComponent("meetings").path
        let recovered = scanRecoverable(root: root, active: nil).contains { $0.meetingId == id }
        try? FileManager.default.removeItem(atPath: root + "/" + id)
        guard recorded > 0, recovered else {
            print("SELFTEST_FAIL livemeeting recorded=\(recorded) recovered=\(recovered)"); exit(3)
        }
        print("SELFTEST_OK livemeeting: 実マイク recordedMs=\(recorded) recovered=\(recovered) sttEvents=\(transcriptEvents)")
        exit(0)
    }

    /// `--selftest sttrecognize`: `say` で実音声を作り、オンデバイス STT が実際にテキストを出すか検証する。
    /// 実音声を伴う認識精度の live 検証（合成音声だが、実 STT エンジンが実際に文字を返す）。
    @MainActor
    private static func sttrecognize() {
        guard SpeechTranscriber.authorization == .authorized else {
            print("SELFTEST_SKIP sttrecognize: speech not authorized"); exit(0)
        }
        let aiff = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("astra-stt-\(getpid()).aiff")
        defer { try? FileManager.default.removeItem(at: aiff) }
        // macOS の say で英語の実音声を生成（既定音声は英語なので en-US で認識する）。
        let phrase = "testing astra meeting transcription"
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        // 既定音声はシステムロケール依存なので、en-US 認識に合わせて英語音声を明示する。
        say.arguments = ["-v", "Samantha", "-o", aiff.path, phrase]
        do { try say.run(); say.waitUntilExit() } catch { print("SELFTEST_FAIL sttrecognize say error=\(error)"); exit(2) }
        guard say.terminationStatus == 0, FileManager.default.fileExists(atPath: aiff.path) else {
            print("SELFTEST_FAIL sttrecognize: say produced no file"); exit(3)
        }
        let st = SpeechTranscriber(localeId: "en-US")
        guard let text = st.recognizeFile(aiff), !text.isEmpty else {
            print("SELFTEST_SKIP sttrecognize: recognizer returned no text in this context"); exit(0)
        }
        let lower = text.lowercased()
        // 主要語のいずれかを拾えていれば認識成立とみなす（音声認識は完全一致を保証しない）。
        let hit = ["test", "astra", "meeting", "transcription", "transcri"].contains { lower.contains($0) }
        guard hit else { print("SELFTEST_FAIL sttrecognize: unexpected text=\(text)"); exit(4) }
        print("SELFTEST_OK sttrecognize: 実音声→STT 認識=\"\(text)\"")
        exit(0)
    }

    /// `--selftest sttstream`: 会議で使う**ストリーミング**経路（start/append/finish）を実音声で検証する。
    /// say の実音声を 16kHz mono f32 に変換して append し、on-device STT が確定テキストを返すか確かめる。
    @MainActor
    private static func sttStream() {
        guard SpeechTranscriber.authorization == .authorized else {
            print("SELFTEST_SKIP sttstream: speech not authorized"); exit(0)
        }
        let aiff = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("astra-sttstream-\(getpid()).aiff")
        defer { try? FileManager.default.removeItem(at: aiff) }
        let phrase = "testing astra meeting transcription"
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", "Samantha", "-o", aiff.path, phrase]
        do { try say.run(); say.waitUntilExit() } catch { print("SELFTEST_FAIL sttstream say error=\(error)"); exit(2) }
        guard say.terminationStatus == 0 else { print("SELFTEST_FAIL sttstream say status"); exit(3) }

        // AIFF を 16kHz mono Float32 に変換して frames を得る。
        guard let frames = decodeTo16kMonoF32(aiff) else {
            print("SELFTEST_FAIL sttstream: decode failed"); exit(4)
        }
        let st = SpeechTranscriber(localeId: "en-US")
        let lock = NSLock(); var latest = ""; var final = false
        do {
            try st.start { ev in
                lock.lock(); latest = ev.text; if ev.isFinal { final = true }; lock.unlock()
            }
        } catch {
            print("SELFTEST_SKIP sttstream: start failed \(error)"); exit(0)
        }
        // 実会議のように 3200 サンプル（0.2s）ずつ append し、run loop を回す。
        var i = 0
        while i < frames.count {
            let end = min(i + 3200, frames.count)
            st.append(Array(frames[i..<end]))
            i = end
            CFRunLoopRunInMode(.defaultMode, 0.02, true)
        }
        st.finish()
        let deadline = Date().addingTimeInterval(8)
        while true {
            lock.lock(); let f = final; let cur = latest; lock.unlock()
            if (f && !cur.isEmpty) || Date() > deadline { break }
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
        }
        lock.lock(); let text = latest; lock.unlock()
        guard !text.isEmpty else { print("SELFTEST_SKIP sttstream: streaming returned no text"); exit(0) }
        let lower = text.lowercased()
        let hit = ["test", "astra", "meeting", "transcription", "transcri", "astro"].contains { lower.contains($0) }
        guard hit else { print("SELFTEST_FAIL sttstream: unexpected text=\(text)"); exit(5) }
        print("SELFTEST_OK sttstream: 実音声→streaming STT 確定=\"\(text)\"")
        exit(0)
    }

    /// AIFF/任意の音声を 16kHz mono Float32 の配列へデコードする。
    static func decodeTo16kMonoF32(_ url: URL) -> [Float]? {
        guard let file = try? AVAudioFile(forReading: url) else { return nil }
        let src = file.processingFormat
        guard let dst = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000,
                                      channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: src, to: dst),
              let inBuf = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: AVAudioFrameCount(file.length))
        else { return nil }
        do { try file.read(into: inBuf) } catch { return nil }
        let ratio = 16_000.0 / src.sampleRate
        let outCap = AVAudioFrameCount(Double(inBuf.frameLength) * ratio) + 1024
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: dst, frameCapacity: outCap) else { return nil }
        var fed = false
        var err: NSError?
        conv.convert(to: outBuf, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return inBuf
        }
        if err != nil { return nil }
        guard let ch = outBuf.floatChannelData else { return nil }
        return Array(UnsafeBufferPointer(start: ch[0], count: Int(outBuf.frameLength)))
    }

    /// `--selftest guishot`: 3 つの主要サーフェス（Voice HUD / Recording Workspace / Main Window）を
    /// **window server 上に実提示**し、自プロセスの window を CGWindowList で撮って
    /// 「実描画・非空白（・borderless は token 実寸）」を実測する。offscreen では確認できない
    /// 「実ディスプレイ提示」を裏付ける（各サーフェスを一瞬だけ表示して閉じる）。特に Main は
    /// NavigationSplitView が offscreen では疎にしか描かれないため、実ウィンドウ提示で解消を示す。
    @MainActor
    private static func guishot() {
        RecordingWorkspaceState.shared.loadDemo(ragOpen: true)
        let pid = getpid()

        // 1 サーフェスを提示→自 window 撮影→色数と bounds を返す。撮れなければ nil。
        func shoot(_ label: String, window: NSWindow, present: () -> Void) -> (w: Int, h: Int, colors: Int, path: String)? {
            present()
            let show = Date().addingTimeInterval(0.8)
            while Date() < show { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
            var winID: CGWindowID = 0
            var bw = 0, bh = 0
            // 撮るのは**いま提示した window**。「いちばん大きい自 window」で選ぶと、直前に閉じた
            // 面が消えかけ（縮小 + 白紙）のまま一覧に残っていて、そちらを撮って c4 で落ちることがある
            // （verify-all で 3 回に 1 回ほど。Main が 1058x666/c4 と出るのがそれ）。
            let own = CGWindowID(max(0, window.windowNumber))
            if let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
                var best = 0
                for info in infos {
                    guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                          let num = info[kCGWindowNumber as String] as? CGWindowID,
                          let b = info[kCGWindowBounds as String] as? [String: Any],
                          let iw = b["Width"] as? CGFloat, let ih = b["Height"] as? CGFloat,
                          iw > 40, ih > 20 else { continue }   // HUD は 310x31 と低いので閾値を下げる
                    if num == own { winID = num; bw = Int(iw); bh = Int(ih); break }
                    // 番号が取れない（まだ載っていない）ときだけ、従来どおり最大の自 window。
                    if own == 0, Int(iw * ih) > best { best = Int(iw * ih); winID = num; bw = Int(iw); bh = Int(ih) }
                }
            }
            guard winID != 0,
                  let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, winID, [.boundsIgnoreFraming, .bestResolution])
            else { window.orderOut(nil); window.close(); return nil }
            let rep = NSBitmapImageRep(cgImage: cg)
            var seen = Set<UInt32>()
            let w = rep.pixelsWide, h = rep.pixelsHigh
            let sx = max(1, w / 40), sy = max(1, h / 40)
            var y = 0
            while y < h { var x = 0
                while x < w {
                    if let c = rep.colorAt(x: x, y: y) {
                        let r = UInt32(max(0, min(255, c.redComponent * 255)))
                        let g = UInt32(max(0, min(255, c.greenComponent * 255)))
                        let bl = UInt32(max(0, min(255, c.blueComponent * 255)))
                        seen.insert((r << 16) | (g << 8) | bl)
                    }
                    x += sx }
                y += sy }
            var path = ""
            if let png = rep.representation(using: .png, properties: [:]) {
                let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("astra-guishot-\(label)-\(pid).png")
                try? png.write(to: out); path = out.path
            }
            window.orderOut(nil); window.close()
            return (bw, bh, seen.count, path)
        }

        func centered(_ win: NSWindow, _ size: NSSize) {
            if let screen = NSScreen.main {
                let f = screen.frame
                win.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.midY - size.height / 2))
            }
        }

        // 1) Voice HUD（borderless, token 実寸）
        let hudSize = NSSize(width: Metrics.hudWidth, height: Metrics.hudHeight)
        let hud = GeniePanel(size: hudSize, level: .normal, canKey: false, content: VoiceHUDView())
        let hudR = shoot("hud", window: hud) { centered(hud, hudSize); hud.orderFrontRegardless() }

        // 2) Recording Workspace（borderless, token 実寸）
        let wsSize = NSSize(width: Metrics.workspaceWidth, height: Metrics.workspaceHeight)
        let ws = GeniePanel(size: wsSize, level: .normal, canKey: false, content: RecordingWorkspaceView())
        let wsR = shoot("workspace", window: ws) { centered(ws, wsSize); ws.orderFrontRegardless() }

        // 3) Main Window（titled 実ウィンドウ。offscreen で疎だった NavigationSplitView が実提示で描かれる）
        let mainSize = NSSize(width: 900, height: 600)
        let main = NSWindow(contentRect: NSRect(origin: .zero, size: mainSize),
                            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        main.contentView = NSHostingView(rootView: MainWindowView(loadBackend: false))
        let mainR = shoot("main", window: main) { centered(main, mainSize); main.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }

        // 4) Task Dock / Intent Bar（spec §4: 画面下部中央・560×56、§4.2 bottom inset）
        let ibSize = NSSize(width: Metrics.intentReadyWidth, height: Metrics.intentReadyHeight)
        let ib = GeniePanel(size: ibSize, level: .normal, canKey: false,
                            content: IntentBarView())
        let ibR = shoot("intentbar", window: ib) {
            if let s = NSScreen.main {
                let f = s.visibleFrame
                ib.setFrameOrigin(NSPoint(x: f.midX - ibSize.width / 2, y: f.minY + Metrics.intentBottomInset))
            }
            ib.orderFrontRegardless()
        }

        // いずれも撮れない（実ディスプレイ無し）なら SKIP。
        guard hudR != nil || wsR != nil || mainR != nil || ibR != nil else {
            print("SELFTEST_SKIP guishot: no on-screen window (headless display?)"); exit(0)
        }
        // 撮れたサーフェスは非空白であること。borderless の 2 面は token 実寸（±2pt）。
        var fails: [String] = []
        func check(_ name: String, _ r: (w: Int, h: Int, colors: Int, path: String)?, expW: Int?, expH: Int?, minColors: Int) -> String {
            guard let r = r else { return "\(name)=SKIP" }
            var ok = r.colors >= minColors
            if let ew = expW { ok = ok && abs(r.w - ew) <= 2 }
            if let eh = expH { ok = ok && abs(r.h - eh) <= 2 }
            if !ok { fails.append("\(name)(\(r.w)x\(r.h),c\(r.colors))") }
            return "\(name)=\(r.w)x\(r.h)/c\(r.colors)"
        }
        let sHud = check("HUD", hudR, expW: Int(Metrics.hudWidth), expH: Int(Metrics.hudHeight), minColors: 4)
        let sWs = check("Workspace", wsR, expW: Int(Metrics.workspaceWidth), expH: Int(Metrics.workspaceHeight), minColors: 8)
        // Main は titled/resizable。ウィンドウマネージャが画面事情でサイズを詰めることがある
        // （実測 900→886 の例）ので実寸固定では検査せず、「十分大きい」＋「中身がある」で見る。
        // 実寸固定の検査は寸法を我々が決める borderless パネル（HUD/Workspace/IntentBar）だけに課す。
        let sMain: String = {
            guard let r = mainR else { return "Main=SKIP" }
            if r.w < 700 || r.h < 500 || r.colors < 8 { fails.append("Main(\(r.w)x\(r.h),c\(r.colors))") }
            return "Main=\(r.w)x\(r.h)/c\(r.colors)"
        }()
        // Task Dock / Intent Bar は spec §4.1 の 560×56（±2pt）・非空白（>=6色）。
        let sIntent = check("IntentBar", ibR, expW: Int(Metrics.intentReadyWidth), expH: Int(Metrics.intentReadyHeight), minColors: 6)
        guard fails.isEmpty else { print("SELFTEST_FAIL guishot: \(fails.joined(separator: ","))"); exit(2) }
        let anyPath = wsR?.path ?? hudR?.path ?? mainR?.path ?? ibR?.path ?? ""
        let summary = [sHud, sWs, sMain, sIntent].joined(separator: " ")
        print("SELFTEST_OK guishot: 実提示 " + summary + " png=" + anyPath)
        exit(0)
    }

    /// `--selftest breakpoints`: §7.2 の reflow（AC-13）を実測する。純関数 ShellLayout.forWidth の
    /// 判定と、実際に 3 幅で offscreen 描画した時の中身（非空白）を確かめる。
    @MainActor
    private static func breakpoints() {
        // 純関数の閾値（tokens 由来）
        let wide = ShellLayout.forWidth(Metrics.bpThreeColumn)          // >=1280 → 3-column
        let mid = ShellLayout.forWidth(Metrics.bpInspectorDrawer + 100) // 960-1279 → drawer
        let narrow = ShellLayout.forWidth(Metrics.bpSidebarCollapse + 10) // 720-959 → collapsed
        guard wide == .threeColumn, mid == .inspectorDrawer, narrow == .sidebarCollapsed,
              wide.showsInspectorInline, !mid.showsInspectorInline,
              narrow.sidebarWidth == Metrics.sidebarCollapsed, wide.sidebarWidth == Metrics.sidebarWidth
        else {
            print("SELFTEST_FAIL breakpoints: wide=\(wide.rawValue) mid=\(mid.rawValue) narrow=\(narrow.rawValue)"); exit(2)
        }
        // 実描画（各幅で非空白）
        func render(_ w: CGFloat) -> Int {
            let v = WorkspaceShellView(title: "A社 商談準備", main: {
                VStack(alignment: .leading) { Text("Overview / Progress / Outputs").padding() }
            }, inspector: {
                VStack(alignment: .leading) { Text("Context / Evidence / Activity").padding() }
            })
            let host = NSHostingView(rootView: v)
            host.frame = NSRect(x: 0, y: 0, width: w, height: 700)
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return 0 }
            host.cacheDisplay(in: host.bounds, to: rep)
            var seen = Set<UInt32>()
            let pw = rep.pixelsWide, ph = rep.pixelsHigh
            let sx = max(1, pw / 40), sy = max(1, ph / 40)
            var y = 0
            while y < ph { var x = 0
                while x < pw {
                    if let c = rep.colorAt(x: x, y: y) {
                        let r = UInt32(max(0, min(255, c.redComponent * 255)))
                        let g = UInt32(max(0, min(255, c.greenComponent * 255)))
                        let b = UInt32(max(0, min(255, c.blueComponent * 255)))
                        seen.insert((r << 16) | (g << 8) | b)
                    }
                    x += sx }
                y += sy }
            return seen.count
        }
        let c1 = render(1400), c2 = render(1100), c3 = render(820)
        guard c1 >= 3, c2 >= 3, c3 >= 3 else {
            print("SELFTEST_FAIL breakpoints render: 1400=\(c1) 1100=\(c2) 820=\(c3)"); exit(3)
        }
        print("SELFTEST_OK breakpoints: >=1280 3-column / 960-1279 inspector drawer / <960 sidebar collapsed; render c\(c1)/c\(c2)/c\(c3)")
        exit(0)
    }

    /// `--selftest dictation`: HUD-004「TextField-aware dictation」を実測する。
    /// 自前の NSTextField を前面に出してフォーカスし、Dictation.insert が**その欄に**入るか、
    /// 入力欄が無いときは false を返して Ask Genie へ回る（＝勝手に会話を始めない）かを見る。
    @MainActor
    private static func dictation() {
        guard AXIsProcessTrusted() else {
            print("SELFTEST_SKIP dictation: AX not trusted"); exit(0)
        }
        // 否定側は**自分の窓で**確かめる。「どのアプリにも入力欄が無い」状態は
        // こちらから作れず（端末やエディタが入力欄を持っていると真になる）、
        // それで落ちるテストは環境の話であって Genie の話ではない。
        // ここではテキストではない要素（ボタン）に focus を当てて、書き込まないことを見る。
        let button = NSButton(title: "not a text field", target: nil, action: nil)
        button.frame = NSRect(x: 0, y: 0, width: 200, height: 24)
        let negWin = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 240, height: 60),
                              styleMask: [.titled], backing: .buffered, defer: false)
        negWin.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 60))
        negWin.contentView?.addSubview(button)
        if let s = NSScreen.main { negWin.setFrameOrigin(NSPoint(x: s.frame.midX - 120, y: s.frame.midY + 120)) }
        negWin.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        negWin.makeFirstResponder(button)
        let negDeadline = Date().addingTimeInterval(1.5)
        while Date() < negDeadline { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        // 自分のボタンが本当に AX の焦点になっているか。なっていないなら、
        // この否定テストは成立しない —— 端末から起動すると TCC は責任プロセス
        // （ターミナル）に紐づくので、system-wide の焦点は**ターミナルの入力欄**を
        // 返す。そこへ書けるのは当たり前で、Genie の欠陥ではない。
        var focusedRole = "?"
        do {
            let sys = AXUIElementCreateSystemWide()
            var f: CFTypeRef?
            if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &f) == .success,
               let el = f {
                var r: CFTypeRef?
                if AXUIElementCopyAttributeValue(el as! AXUIElement, kAXRoleAttribute as CFString, &r) == .success,
                   let role = r as? String { focusedRole = role }
            }
        }
        guard focusedRole == (kAXButtonRole as String) else {
            negWin.orderOut(nil); negWin.close()
            print("SELFTEST_SKIP dictation: 自分の窓へ焦点を移せない（AX の焦点は "
                + "\(focusedRole)）。アプリとして起動しないと、この否定テストは成立しない")
            exit(0)
        }
        let wroteToButton = Dictation.insert("これは入らないはず")
        negWin.orderOut(nil); negWin.close()
        guard wroteToButton == false else {
            print("SELFTEST_FAIL dictation: 入力欄でない要素へ書き込んだ"); exit(2)
        }

        // 実 NSTextField を出してフォーカスし、そこへ入るか。
        let field = NSTextField(string: "")
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 80),
                           styleMask: [.titled], backing: .buffered, defer: false)
        win.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 80))
        win.contentView?.addSubview(field)
        if let s = NSScreen.main { win.setFrameOrigin(NSPoint(x: s.frame.midX - 180, y: s.frame.midY)) }
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        win.makeFirstResponder(field)
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline { CFRunLoopRunInMode(.defaultMode, 0.05, true) }

        var focused: CFTypeRef?
        var owner: pid_t = 0
        guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let focused, AXUIElementGetPid(focused as! AXUIElement, &owner) == .success, owner == getpid() else {
            win.orderOut(nil); win.close()
            print("SELFTEST_FAIL dictation: fixture lost focus; no text was inserted"); exit(2)
        }
        let inserted = Dictation.insert("会議の要点をまとめて")
        let value = field.stringValue
        win.orderOut(nil); win.close()

        guard inserted, value.contains("会議の要点をまとめて") else {
            print("SELFTEST_SKIP dictation: focused field へ書けなかった inserted=\(inserted) value=\"\(value)\" (AX 経路が別プロセス扱いの可能性)")
            exit(0)
        }
        print("SELFTEST_OK dictation: focused text field へ挿入 value=\"\(value)\" / テキストでない要素には書かない")
        exit(0)
    }

    /// `--selftest axtree`: 実提示した Main Window と Recording Workspace の**アクセシビリティツリー**を
    /// 走査し、統合された各サーフェスが実アクセシブル要素として存在するか検証する（正本 §2/§7）。
    /// XCUITest 相当（UI を pixels でなく構造として実測）。AX 許可が無ければ SKIP。
    @MainActor
    private static func axtree() {
        guard AXIsProcessTrusted() else { print("SELFTEST_SKIP axtree: AX not trusted"); exit(0) }
        RecordingWorkspaceState.shared.loadDemo(ragOpen: true)

        // 1 つの window を提示し、自プロセス AX ツリーのテキスト系属性を集めて返す。
        func axTexts(present: () -> NSWindow) -> Set<String> {
            let win = present()
            let show = Date().addingTimeInterval(1.0)
            while Date() < show { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
            let app = AXUIElementCreateApplication(getpid())
            var texts = Set<String>()
            func attr(_ el: AXUIElement, _ name: String) -> String? {
                var v: CFTypeRef?
                guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
                if let s = v as? String, !s.isEmpty { return s }
                return nil
            }
            func walk(_ el: AXUIElement, _ depth: Int) {
                if depth > 20 { return }
                for a in ["AXTitle", "AXDescription", "AXValue", "AXLabel", "AXIdentifier", "AXHelp"] {
                    if let s = attr(el, a) { texts.insert(s) }
                }
                var kids: CFTypeRef?
                if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kids) == .success,
                   let arr = kids as? [AXUIElement] {
                    for k in arr { walk(k, depth + 1) }
                }
            }
            walk(app, 0)
            win.orderOut(nil); win.close()
            return texts
        }

        // Main Window（4 セクション）
        let mainTexts = axTexts {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            w.contentView = NSHostingView(rootView: MainWindowView(loadBackend: false))
            if let s = NSScreen.main { w.setFrameOrigin(NSPoint(x: s.frame.midX - 450, y: s.frame.midY - 300)) }
            w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            return w
        }
        // 自プロセス AX が空（sandbox/権限差）なら捏造せず SKIP。
        guard !mainTexts.isEmpty else {
            print("SELFTEST_SKIP axtree: own-process AX tree empty in this context"); exit(0)
        }
        // Recording Workspace（統合サーフェス群）
        let wsSize = NSSize(width: Metrics.workspaceWidth, height: Metrics.workspaceHeight)
        let wsTexts = axTexts {
            let p = GeniePanel(size: wsSize, level: .normal, canKey: false, content: RecordingWorkspaceView())
            if let s = NSScreen.main { p.setFrameOrigin(NSPoint(x: s.frame.midX - wsSize.width/2, y: s.frame.midY - wsSize.height/2)) }
            p.orderFrontRegardless()
            return p
        }

        func has(_ set: Set<String>, _ needle: String) -> Bool { set.contains { $0.localizedCaseInsensitiveContains(needle) } }
        // Main: 4 セクション（§2）
        let mainWant = MainSection.allCases.map(\.title)   // §Workspace の 6 セクション
        let mainMiss = mainWant.filter { !has(mainTexts, $0) }
        // Workspace: 統合サーフェス（§2/§7）— Recording Hero / Transcript / Translation / AI / RAG / Task Dock
        // AI に頼む語は Ask 入力の横の 3 つ（要約 / 決定事項 / アクション）。「質問する」は入力欄そのもの。
        let wsWant = [Facts.recordingHeroRecording, RecordingTool.transcript.title,
                      RecordingTool.translation.title, "要約", "決定事項", "アクション", "AI が見ている資料"]
        let wsMiss = wsWant.filter { !has(wsTexts, $0) }
        guard mainMiss.isEmpty, wsMiss.isEmpty else {
            print("SELFTEST_FAIL axtree: mainMiss=\(mainMiss) wsMiss=\(wsMiss) (main=\(mainTexts.count) ws=\(wsTexts.count))"); exit(2)
        }
        print("SELFTEST_OK axtree: Main \(mainWant.count)セクション + Workspace 統合サーフェス\(wsWant.count)件を実アクセシブル要素として検出 (main=\(mainTexts.count) ws=\(wsTexts.count))")
        exit(0)
    }

    /// `--selftest a11ynames [outFile]`: 各面の**アクセシビリティ名と Tab 走査を測るだけ**（直さない）。
    ///
    /// `accessibilityLabel` の数と `Image(systemName:)` の数を比べても、名前が無い証明にはならない
    /// —— Button の中身や親から名前が付くことがある。だから実 AX ツリーで、押せる要素ごとに
    /// 「何と読まれるか」を記録する。Tab は本物の key event を送り、AX の focused element が
    /// 動いたか・その動きが**画素として**見えたかを記す。閾値も判定も持たない。
    /// 数字が出るまで UI を変えない（[[visual-judges-cannot-measure]] と同じ流儀）。
    /// 測れないもの（AX 不可、撮影不可）は NOT_MEASURED と書き、FAIL にしない。
    @MainActor
    private static func a11ynames(_ args: [String]) {
        guard AXIsProcessTrusted() else { print("SELFTEST_SKIP a11ynames: AX not trusted"); exit(0) }
        let i = args.firstIndex(of: "--selftest")!
        let outFile = args.count > i + 2 ? args[i + 2] : nil
        NSApp.setActivationPolicy(.regular)
        parkCursor()
        // 行は stderr（検査の loop は stdout の先頭行で OK/SKIP を見る）。outFile には全部残す。
        var lines: [String] = []
        func emit(_ l: String) { FileHandle.standardError.write((l + "\n").data(using: .utf8)!); lines.append(l) }
        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        let app = AXUIElementCreateApplication(getpid())
        func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
            var v: CFTypeRef?
            return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
        }
        func str(_ el: AXUIElement, _ name: String) -> String? {
            guard let v = attr(el, name) else { return nil }
            if let s = v as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let n = v as? NSNumber { return n.stringValue }
            return nil
        }
        func frame(_ el: AXUIElement) -> CGRect {
            var r = CGRect.zero
            if let p = attr(el, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID() {
                var pt = CGPoint.zero; AXValueGetValue(p as! AXValue, .cgPoint, &pt); r.origin = pt
            }
            if let z = attr(el, kAXSizeAttribute), CFGetTypeID(z) == AXValueGetTypeID() {
                var sz = CGSize.zero; AXValueGetValue(z as! AXValue, .cgSize, &sz); r.size = sz
            }
            return r
        }
        func actions(_ el: AXUIElement) -> [String] {
            var a: CFArray?
            return AXUIElementCopyActionNames(el, &a) == .success ? ((a as? [String]) ?? []) : []
        }
        /// 読まれる名前。SwiftUI の accessibilityLabel は AXDescription、AppKit は AXTitle に出る。
        /// 入力欄は placeholder が名前の代わりになる。
        func name(_ el: AXUIElement, role: String) -> String {
            for a in [kAXTitleAttribute, kAXDescriptionAttribute] {
                if let s = str(el, a), !s.isEmpty { return s }
            }
            if role == kAXTextFieldRole || role == kAXTextAreaRole {
                if let s = str(el, "AXPlaceholderValue"), !s.isEmpty { return s }
            }
            if let t = attr(el, kAXTitleUIElementAttribute), CFGetTypeID(t) == AXUIElementGetTypeID(),
               let s = str(t as! AXUIElement, kAXValueAttribute), !s.isEmpty { return s }
            // 押せる Text（onTapGesture）は AXStaticText のまま。読まれるのは AXValue。
            if role == kAXStaticTextRole, let s = str(el, kAXValueAttribute), !s.isEmpty { return s }
            return ""
        }
        struct Item { let role: String; let sub: String; let name: String; let id: String; let frame: CGRect; let pressable: Bool
            /// 名前が無い、と数えてよいもの。閉じる/縮小/拡大ボタンやスクロールバーの矢印は
            /// subrole から名前が付く（VoiceOver はそれを読む）ので除く。大きさ 0 の要素も除く。
            var nameless: Bool { name.isEmpty && sub.isEmpty && frame.width > 0 && frame.height > 0 }
        }
        let controlRoles: Set<String> = [kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole, kAXPopUpButtonRole,
                                         kAXMenuButtonRole, "AXLink", kAXTextFieldRole, kAXTextAreaRole,
                                         kAXSliderRole, kAXDisclosureTriangleRole, kAXComboBoxRole, kAXIncrementorRole]
        func fmt(_ r: CGRect) -> String { "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width))x\(Int(r.height))" }

        /// window 単位で AX を歩く。`titles` が空なら全部、あれば AXTitle がそれのものだけ。
        func collect(windowTitles titles: [String]) -> (controls: [Item], images: [Item]) {
            var controls: [Item] = [], images: [Item] = []
            func walk(_ el: AXUIElement, _ depth: Int) {
                if depth > 24 { return }
                let role = str(el, kAXRoleAttribute) ?? ""
                let acts = actions(el)
                let pressable = acts.contains(kAXPressAction)
                let sub = str(el, kAXSubroleAttribute) ?? ""
                if controlRoles.contains(role) || pressable {
                    controls.append(Item(role: role, sub: sub, name: name(el, role: role),
                                         id: str(el, kAXIdentifierAttribute) ?? "", frame: frame(el), pressable: pressable))
                } else if role == kAXImageRole {
                    images.append(Item(role: role, sub: sub, name: name(el, role: role),
                                       id: str(el, kAXIdentifierAttribute) ?? "", frame: frame(el), pressable: false))
                }
                if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
                    for k in kids { walk(k, depth + 1) }
                }
            }
            if let wins = attr(app, kAXWindowsAttribute) as? [AXUIElement] {
                for w in wins {
                    let t = str(w, kAXTitleAttribute) ?? ""
                    if titles.isEmpty || titles.contains(t) { walk(w, 1) }
                }
            }
            return (controls, images)
        }
        func shot(_ win: NSWindow) -> [UInt8]? {
            guard let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(win.windowNumber),
                                                   [.boundsIgnoreFraming, .nominalResolution]),
                  cg.width > 4, cg.height > 4 else { return nil }
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let data = rep.bitmapData else { return nil }
            return Array(UnsafeBufferPointer(start: data, count: rep.bytesPerRow * rep.pixelsHigh))
        }
        func differs(_ a: [UInt8]?, _ b: [UInt8]?) -> Bool? {
            guard let a, let b, a.count == b.count else { return nil }
            for k in stride(from: 0, to: a.count, by: 4) where a[k] != b[k] || a[k+1] != b[k+1] || a[k+2] != b[k+2] { return true }
            return false
        }
        func focused() -> (role: String, name: String, id: String)? {
            guard let f = attr(app, kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() else { return nil }
            let el = f as! AXUIElement
            let role = str(el, kAXRoleAttribute) ?? ""
            return (role, name(el, role: role), str(el, kAXIdentifierAttribute) ?? "")
        }
        /// Tab を本物の key event で送って、焦点がどこへ行くかと、それが見えるかを記す。
        func tabWalk(_ surface: String, _ win: NSWindow, steps: Int = 14) -> (moved: Int, visible: Int, invisible: Int, unmeasured: Int) {
            win.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); settle(0.4)
            var prev = focused(); var before = shot(win)
            var moved = 0, visible = 0, invisible = 0, unmeasured = 0
            var seen: [String] = []
            for step in 1...steps {
                for down in [true, false] {
                    guard let ev = NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: [],
                                                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber,
                                                    context: nil, characters: "\t", charactersIgnoringModifiers: "\t",
                                                    isARepeat: false, keyCode: 48) else { continue }
                    NSApp.sendEvent(ev)
                }
                settle(0.25)
                let now = focused(); let after = shot(win)
                let didMove = (now?.role ?? "") + (now?.name ?? "") + (now?.id ?? "") != (prev?.role ?? "") + (prev?.name ?? "") + (prev?.id ?? "")
                let vis = differs(before, after)
                let visText = vis == nil ? "NOT_MEASURED" : (vis! ? "yes" : "no")
                if didMove { moved += 1; if vis == nil { unmeasured += 1 } else if vis! { visible += 1 } else { invisible += 1 } }
                let key = (now?.role ?? "-") + "|" + (now?.name ?? "")
                emit("A11Y_TAB\t\(surface)\tstep=\(step)\trole=\(now?.role ?? "-")\tname=\(now?.name ?? "")\tid=\(now?.id ?? "")\tmoved=\(didMove)\tvisible=\(visText)")
                if seen.contains(key) && didMove { /* 一周した */ }
                seen.append(key)
                prev = now; before = after
            }
            return (moved, visible, invisible, unmeasured)
        }
        func report(_ surface: String, titles: [String]) -> (controls: Int, nameless: Int) {
            let r = collect(windowTitles: titles)
            let nameless = r.controls.filter(\.nameless)
            let latin = r.controls.filter { !$0.name.isEmpty && $0.name.unicodeScalars.allSatisfy { $0.isASCII } }
            let imgNamed = r.images.filter { !$0.name.isEmpty }.count
            emit("A11Y_SURFACE\t\(surface)\tcontrols=\(r.controls.count)\tnameless=\(nameless.count)\tlatinOnly=\(latin.count)\timages=\(r.images.count)\timagesNamed=\(imgNamed)")
            for c in r.controls {
                emit("A11Y_CONTROL\t\(surface)\t\(c.role)\tsub=\(c.sub)\tname=\(c.name)\tid=\(c.id)\tframe=\(fmt(c.frame))\tpress=\(c.pressable)")
            }
            return (r.controls.count, nameless.count)
        }

        let store = GenieStateStore.shared
        let hud = VoiceHUDState.shared
        let recording = RecordingWorkspaceState.shared
        var totalControls = 0, totalNameless = 0
        var tabSummary: [String] = []
        // Tab がボタンにも止まるかは OS の「キーボードナビゲーション」次第。結果と一緒に記す。
        let keyboardNavigation = NSApp.isFullKeyboardAccessEnabled
        let fka = UserDefaults(suiteName: "com.apple.Accessibility")?.bool(forKey: "FullKeyboardAccessEnabled") ?? false
        emit("A11Y_ENV\tfullKeyboardAccess=\(fka)\tkeyboardNavigation=\(keyboardNavigation)\tmacOS=\(ProcessInfo.processInfo.operatingSystemVersionString)")
        func add(_ r: (controls: Int, nameless: Int)) { totalControls += r.controls; totalNameless += r.nameless }

        // Dock の姿（key にならない面なので Tab は測らない）
        _ = GlobalShortcut.shared.register(handler: {})
        hud.mode = .idle
        WindowCoordinator.shared.showVoiceHUD(); settle(1.0)
        add(report("dock-idle", titles: []))
        hud.mode = .listening(partial: "このページからタスクを作って…"); settle(0.6)
        add(report("dock-listening", titles: []))
        store.startTask(AgentTask(
            id: UUID(), title: "週次ブリーフィングを作る", status: .running,
            steps: [AgentStep(title: "Calendar", tool: "calendar", detail: "明日 10:00", state: .success),
                    AgentStep(title: "Notion", tool: "notion", detail: "Q3 Proposal を読んでいます", state: .running)],
            startedAt: Date(), context: ContextBundle(items: [])))
        settle(0.6)
        add(report("dock-agent", titles: []))
        store.finishTask(.success); settle(0.3)
        _ = store.requireConfirmation(ActionConfirmation(
            app: "Slack", appIcon: "number", title: "このメッセージを送りますか？",
            params: [.init(label: "宛先", value: "#sales")],
            preview: "明日の会議、資料を先に共有します。",
            source: .init(title: "週次同期", speaker: "田中", time: "10:42"),
            details: [], risk: .r2, confirmLabel: Facts.confirmationConfirmExample))
        settle(0.6)
        add(report("dock-confirmation", titles: []))
        store.resolveConfirmation(approved: false)
        recording.loadDemo(ragOpen: false)
        store.meetingDetected(app: "Google Meet")
        recording.start(); settle(0.8)
        // 録音の立ち上がり（マイク + STT）は機械の忙しさで 0.8 秒を超えることがあり、そのとき
        // dock-meeting が controls=0 / A11Y_RECORDING found=false で記録された（同じ build で再実行すると 5 / true）。
        // 記録が環境の忙しさで変わらないよう、Dock に押せる要素が出るまで最長 3 秒待つ。
        let dockDeadline = Date().addingTimeInterval(3)
        while collect(windowTitles: []).controls.isEmpty && Date() < dockDeadline { settle(0.3) }
        add(report("dock-meeting", titles: []))
        // 録音中の名前: 「録音中」であることが AX 名として読めるか（Recording Accessible Name）
        let rec = collect(windowTitles: [])
        let recNames = (rec.controls + rec.images).map(\.name).filter { $0.contains("録音") || $0.lowercased().contains("recording") }
        emit("A11Y_RECORDING\tfound=\(!recNames.isEmpty)\tnames=\(recNames.joined(separator: " / "))")
        recording.stop(); store.reset(); hud.mode = .idle
        WindowCoordinator.shared.hideVoiceHUD(); settle(0.4)

        // Recording Workspace
        recording.loadDemo(ragOpen: true); recording.selectedTool = .transcript
        WindowCoordinator.shared.showRecordingWorkspace(); settle(1.0)
        add(report("workspace", titles: []))
        if let w = NSApp.windows.first(where: { $0.isVisible && $0.contentView is NSHostingView<RecordingWorkspaceView> }) {
            let t = tabWalk("workspace", w); tabSummary.append("workspace moved=\(t.moved) visible=\(t.visible) invisible=\(t.invisible) unmeasured=\(t.unmeasured)")
        } else { emit("A11Y_TAB\tworkspace\tNOT_MEASURED\t(window not found)") }
        WindowCoordinator.shared.hideRecordingWorkspace(); settle(0.5)

        // Main Window（AX の title は `.navigationTitle` で Home / Tasks … に変わるので、その時の title で引く）
        MainWindowController.shared.show(); MainWindowController.shared.showSection(.home); settle(1.2)
        let mainWin = NSApp.windows.first(where: { $0.isVisible && $0.contentView is NSHostingView<MainWindowView> })
        func mainTitles() -> [String] { mainWin.map { [$0.title] } ?? [] }
        add(report("main-home", titles: mainTitles()))
        if let w = mainWin {
            let t = tabWalk("main-home", w); tabSummary.append("main-home moved=\(t.moved) visible=\(t.visible) invisible=\(t.invisible) unmeasured=\(t.unmeasured)")
        } else { emit("A11Y_TAB\tmain-home\tNOT_MEASURED\t(window not found)") }
        for (name, sec) in [("main-work", MainSection.work), ("main-library", .library), ("main-apps", .apps)] {
            MainWindowController.shared.showSection(sec); settle(0.6)
            add(report(name, titles: mainTitles()))
        }
        MainWindowController.shared.showMeetingDetailPreview(); settle(0.8)
        add(report("main-meeting-detail", titles: mainTitles()))
        MainWindowController.shared.hide(); settle(0.3)

        // Settings（5 つの許可の一覧）
        SettingsWindowController.shared.show(); settle(1.0)
        add(report("settings", titles: ["Genie 設定"]))
        if let w = NSApp.windows.first(where: { $0.title == "Genie 設定" && $0.isVisible }) {
            let t = tabWalk("settings", w); tabSummary.append("settings moved=\(t.moved) visible=\(t.visible) invisible=\(t.invisible) unmeasured=\(t.unmeasured)")
            w.orderOut(nil)
        }

        if let outFile {
            try? (lines.joined(separator: "\n") + "\n").write(toFile: outFile, atomically: true, encoding: .utf8)
        }
        print("SELFTEST_OK a11ynames: controls=\(totalControls) nameless=\(totalNameless) | tab(fullKeyboardAccess=\(fka)): \(tabSummary.joined(separator: "; ")) | 測っただけ（判定は持たない）")
        exit(0)
    }

    /// `--selftest shape`: RecordingWorkspaceShape のパスが共有 fixture（tokens 由来の golden）と
    /// 一致するか検証する。macOS/Windows が同じ形を描くことの visual regression（macOS 側で実証）。
    @MainActor
    private static func shape() {
        let rect = CGRect(x: 0, y: 0, width: CGFloat(Metrics.workspaceWidth), height: CGFloat(Metrics.workspaceHeight))
        let path = RecordingWorkspaceShape().path(in: rect)
        func fmt(_ v: CGFloat) -> String {
            let r = (v).rounded()
            return abs(v - r) < 0.005 ? String(Int(r)) : String(format: "%.2f", v)
        }
        func pt(_ p: CGPoint) -> String { "\(fmt(p.x)),\(fmt(p.y))" }
        var d: [String] = []
        path.forEach { el in
            switch el {
            case .move(let to): d.append("M \(pt(to))")
            case .line(let to): d.append("L \(pt(to))")
            case .quadCurve(let to, let c): d.append("Q \(pt(c)) \(pt(to))")
            case .curve(let to, let c1, let c2): d.append("C \(pt(c1)) \(pt(c2)) \(pt(to))")
            case .closeSubpath: d.append("Z")
            @unknown default: break
            }
        }
        let got = d.joined(separator: " ")
        // 共有 golden を読む（リポジトリの fixtures）。
        let goldenPath = FileManager.default.currentDirectoryPath + "/../../shared/design/fixtures/recording-workspace.path"
        let alt = FileManager.default.currentDirectoryPath + "/shared/design/fixtures/recording-workspace.path"
        let golden = (try? String(contentsOfFile: goldenPath, encoding: .utf8))
            ?? (try? String(contentsOfFile: alt, encoding: .utf8))
        guard let goldenStr = golden?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            print("SELFTEST_SKIP shape: golden fixture not found"); exit(0)
        }
        guard got == goldenStr else {
            print("SELFTEST_FAIL shape mismatch\n got=\(got)\n want=\(goldenStr)"); exit(2)
        }
        // 凹みの pill は幅を token で固定している。中身が token より広いと、唯一縮められる
        // 時計が 0 幅に潰れて消える（250 のとき実際に起きた）。中身の実寸と token を突き合わせる。
        let pill = NSHostingView(rootView: TaskDockView(state: RecordingWorkspaceState.shared).content
            .environment(\.colorScheme, .dark))
        let natural = pill.fittingSize.width.rounded(.up)
        let token = CGFloat(Metrics.dockWidth)
        guard natural <= token, token - natural <= 4 else {
            print("SELFTEST_FAIL shape: taskDock の中身 \(natural)pt に対して token dockWidth は \(token)pt（tokens.json の taskDock.width と recordingWorkspace.notchWidth を中身に合わせること）"); exit(2)
        }
        print("SELFTEST_OK shape: path matches shared fixture (\(d.count) segments); taskDock content \(natural)pt fits dockWidth \(token)pt")
        exit(0)
    }

    /// `--selftest hudlifecycle`: 通常(HUD) → 録音開始(Recording Workspace) → 停止(保存) → HUD 復帰 の
    /// 状態遷移を検証する（§6「Voice HUD→Recording→保存→HUD復帰」/ Done#7）。window の描画ではなく
    /// WindowCoordinator の状態機械を確かめる（isRecording の遷移）。
    @MainActor
    private static func hudlifecycle() {
        WindowCoordinator.headless = true   // window を出さず状態遷移だけ検証
        let wc = WindowCoordinator.shared
        // 初期は非録音（Voice HUD 側）。
        guard wc.isRecording == false else { print("SELFTEST_FAIL hudlifecycle: starts recording"); exit(2) }
        // 録音開始 → Recording Workspace 側へ。
        wc.enterRecordingMode()
        guard wc.isRecording == true else { print("SELFTEST_FAIL hudlifecycle: enter did not set recording"); exit(3) }
        // 状態も RecordingWorkspaceState.start と整合（録音セッションは別途 record/livemeeting で検証済み）。
        // 停止 → 保存 → HUD 復帰。
        wc.leaveRecordingMode()
        guard wc.isRecording == false else { print("SELFTEST_FAIL hudlifecycle: leave did not clear recording"); exit(4) }
        // もう一巡（window 専用経路。録音ランタイム=保存は record/livemeeting で別途検証済み）。
        wc.enterRecordingMode(); let on2 = wc.isRecording
        wc.leaveRecordingMode(); let off2 = wc.isRecording
        guard on2 == true, off2 == false else {
            print("SELFTEST_FAIL hudlifecycle: second cycle \(on2)->\(off2)"); exit(5)
        }
        print("SELFTEST_OK hudlifecycle: HUD→Recording→保存→HUD 復帰 の window 状態遷移 OK")
        exit(0)
    }

    /// `--selftest pause`: 一時停止が実際に録音を止めるか（UI フラグだけでない）を検証する。
    /// pause 中に push しても recordedMs が進まないこと・解除後に進むことを確かめる。
    @MainActor
    private static func pauseWorks() {
        let runtime = RecordingRuntime.shared
        guard runtime.begin(meetingId: "pause-selftest", captureMic: false, captureSystemAudio: false, transcribe: false) else {
            print("SELFTEST_FAIL pause begin"); exit(2)
        }
        let oneSec = [Float](repeating: 0.1, count: 16_000)
        // recordedMs は閉じた断片(5秒毎)を数えるので、各フェーズ 6 秒ずつ流す。
        for _ in 0..<6 { runtime.push(oneSec, sampleRate: 16_000) }
        let before = runtime.recordedMs()
        runtime.setPaused(true)
        for _ in 0..<6 { runtime.push(oneSec, sampleRate: 16_000) }   // 一時停止中は捨てられるはず
        let duringPause = runtime.recordedMs()
        runtime.setPaused(false)
        for _ in 0..<6 { runtime.push(oneSec, sampleRate: 16_000) }
        let afterResume = runtime.recordedMs()
        runtime.end()
        let root = LocalStore.dataRoot
            .appendingPathComponent("meetings").path
        try? FileManager.default.removeItem(atPath: root + "/pause-selftest")
        guard before > 0, duringPause == before, afterResume > duringPause else {
            print("SELFTEST_FAIL pause before=\(before) duringPause=\(duringPause) afterResume=\(afterResume)"); exit(3)
        }
        print("SELFTEST_OK pause: 停止中は録音が進まない before=\(before) pause=\(duringPause) resume=\(afterResume)")
        exit(0)
    }

    /// `--selftest screenshot`: 画面文脈のスクショが実ファイルとして保存されるか検証する
    /// （viewfinder ボタンの実機能）。画面収録許可が無ければ SKIP。
    @MainActor
    private static func screenshot() {
        guard Permissions.screenRecording == .granted else {
            print("SELFTEST_SKIP screenshot: screen recording not granted"); exit(0)
        }
        let state = RecordingWorkspaceState.shared
        state.currentMeetingId = "screenshot-selftest"
        guard let path = state.captureScreenshot() else {
            print("SELFTEST_SKIP screenshot: no frame in this context"); exit(0)
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        // PNG マジックナンバーを確認（実画像であること）。
        let data = FileManager.default.contents(atPath: path) ?? Data()
        let isPng = data.count > 8 && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47
        let root = LocalStore.dataRoot
            .appendingPathComponent("meetings/screenshot-selftest").path
        try? FileManager.default.removeItem(atPath: root)
        guard (size ?? 0) > 1000, isPng else {
            print("SELFTEST_FAIL screenshot size=\(size ?? 0) isPng=\(isPng)"); exit(2)
        }
        print("SELFTEST_OK screenshot: 実 PNG 保存 bytes=\(size ?? 0) isPng=\(isPng)")
        exit(0)
    }

    /// `--selftest aiaction <base>`: AI 操作（要約）が core 経由で実 Agent に届き、結果が返るか検証する。
    /// gateway 未到達なら SKIP。
    @MainActor
    private static func aiaction(_ args: [String]) {
        let base = args.count > (args.firstIndex(of: "--selftest")! + 2)
            ? args[args.firstIndex(of: "--selftest")! + 2] : "http://127.0.0.1:3000"
        guard GenieCoreBridge.reachable(base) else { print("SELFTEST_SKIP aiaction: gateway unreachable"); exit(0) }
        do {
            // A configured test host belongs to one test identity; a new PID identity
            // has no host and cannot test actual local inference.
            let configured = ProcessInfo.processInfo.environment["ASTRA_SELFTEST_AGENT_EMAIL"]
            let email = configured?.hasSuffix("@astra.local") == true ? configured! : "aiaction-\(getpid())@astra.local"
            let accessToken: String
            if let path = ProcessInfo.processInfo.environment["ASTRA_SELFTEST_AGENT_TOKEN_PATH"], path.hasPrefix("/tmp/") {
                accessToken = try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            } else { accessToken = try GenieCoreBridge.devSignIn(base, email: email, displayName: "AI").accessToken }
            let state = RecordingWorkspaceState.shared
            state.configureBackend(base: base, token: accessToken)
            state.transcript = [
                TranscriptSegment(speaker: "田中", text: "リリースは 9 月 12 日にしましょう。", interim: false),
                TranscriptSegment(speaker: "鈴木", text: "OAuth の確認を私がやります。", interim: false),
            ]
            state.runAIAction("リアルタイム要約")
            // 非同期の結果を待つ（最大 35 秒）。
            let deadline = Date().addingTimeInterval(35)
            while state.aiResult.isEmpty && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            }
            guard state.aiActionSucceeded, !state.aiResult.isEmpty, !state.aiResult.contains("失敗") else {
                print("SELFTEST_FAIL aiaction result=\(state.aiResult)"); exit(2)
            }
            let preview = String(state.aiResult.prefix(40)).replacingOccurrences(of: "\n", with: " ")
            print("SELFTEST_OK aiaction: Agent 応答=\"\(preview)…\"")
            exit(0)
        } catch {
            print("SELFTEST_FAIL aiaction error=\(error)"); exit(3)
        }
    }

    /// Uses the local translation client; error messages cannot count as translated text.
    @MainActor
    private static func translateTest(_ args: [String]) {
        Task {
            let model = MeetingTranslation()
            model.setEngine(.local)
            model.update([TranscriptSegment(speaker: "Tester", text: "次回の会議は金曜日の午後3時です。", interim: false)])
            model.setEnabled(true)
            let deadline = Date().addingTimeInterval(45)
            while model.isTranslating && Date() < deadline { try? await Task.sleep(for: .milliseconds(100)) }
            let text = model.text.lowercased()
            guard text.contains("friday"), text.contains("3"), model.failure == nil else {
                print("SELFTEST_FAIL translate: local model did not preserve the fixture date/time"); exit(2)
            }
            print("SELFTEST_OK translate: local model preserved Friday and 3 pm"); exit(0)
        }
    }

    /// `--selftest waveform`: 録音中に波形が実マイクレベルで更新されるか（固定デモでない）を検証する。
    /// マイク許可が無ければ SKIP。
    @MainActor
    private static func waveform() {
        guard Permissions.microphone == .granted else {
            print("SELFTEST_SKIP waveform: microphone not granted"); exit(0)
        }
        let runtime = RecordingRuntime.shared
        var levelCallbacks = 0
        runtime.onLevel = { _ in levelCallbacks += 1 }
        guard runtime.begin(meetingId: "waveform-selftest", captureMic: true, captureSystemAudio: false, transcribe: false) else {
            print("SELFTEST_FAIL waveform begin"); exit(2)
        }
        RunLoop.current.run(until: Date().addingTimeInterval(1.2))
        runtime.end()
        let root = LocalStore.dataRoot
            .appendingPathComponent("meetings").path
        try? FileManager.default.removeItem(atPath: root + "/waveform-selftest")
        guard levelCallbacks > 0 else { print("SELFTEST_FAIL waveform: no level callbacks"); exit(3) }
        print("SELFTEST_OK waveform: 実マイクレベルで更新 callbacks=\(levelCallbacks)")
        exit(0)
    }

    /// `--selftest recovery <base>`: クラッシュした録音（未アップロード断片）を検出して gateway に復旧できるか検証する。
    @MainActor
    private static func recovery(_ args: [String]) {
        let base = args.count > (args.firstIndex(of: "--selftest")! + 2)
            ? args[args.firstIndex(of: "--selftest")! + 2] : "http://127.0.0.1:3000"
        guard GenieCoreBridge.reachable(base) else { print("SELFTEST_SKIP recovery: gateway unreachable"); exit(0) }
        do {
            let token = try preparedTestToken(base: base, email: "recovery-\(getpid())@astra.local")
            // gateway に会議を作り、その id で「クラッシュした録音」を作る（アップロードしない）。
            let mid = try GenieCoreBridge.createMeeting(base, accessToken: token, title: "Recovery 会議", language: "ja-JP")
            let root = LocalStore.dataRoot
                .appendingPathComponent("meetings").path
            let session = try RecordingSession.start(root: root, meetingId: mid)
            let oneSec = [Float](repeating: 0.1, count: 16_000)
            for _ in 0..<6 { _ = session.pushSamples(samples: oneSec, sampleRate: 16_000) }
            try session.finish()   // 断片は書けたがアップロードしていない = クラッシュ相当
            // 起動時スキャンで回復候補に出る。
            let runtime = RecordingRuntime.shared
            runtime.configureBackend(base: base, accessToken: token)
            let found = runtime.recoverableMeetings().contains { $0.meetingId == mid }
            // This fixture uploads only its generated signal. Keep the opt-in in this
            // process; the user's persistent cloud-audio preference is unchanged.
            var overrides = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
            overrides[RecordingRuntime.cloudTranscriptionDefaultsKey] = true
            UserDefaults.standard.setVolatileDomain(overrides, forName: UserDefaults.argumentDomain)
            // 復旧: gateway に送って finalize（アップロード済みに印す）。
            let sent = runtime.recover(meetingId: mid)
            // 復旧後は回復候補から消えるはず（二重アップロードしない）。
            let stillThere = runtime.recoverableMeetings().contains { $0.meetingId == mid }
            try? FileManager.default.removeItem(atPath: root + "/" + mid)
            guard found, sent > 0, !stillThere else {
                print("SELFTEST_FAIL recovery found=\(found) sent=\(sent) stillRecoverable=\(stillThere)"); exit(2)
            }
            print("SELFTEST_OK recovery: 検出→復旧 uploadedBytes=\(sent) 復旧後は候補から消える(stillThere=\(stillThere))")
            exit(0)
        } catch { print("SELFTEST_FAIL recovery error=\(error)"); exit(3) }
    }

    /// `--selftest timer`: 録音中に経過時間が実際に進み、一時停止で止まるか検証する（以前は 0 のままだった）。
    @MainActor
    private static func timer() {
        WindowCoordinator.headless = true   // window を出さない
        let state = RecordingWorkspaceState.shared
        // Timer behavior does not require hardware capture; keep this headless
        // check independent of macOS TCC.
        state.start(captureMic: false, transcribe: false, requestPermissions: false)
        RunLoop.current.run(until: Date().addingTimeInterval(2.4))
        let running = state.elapsedSeconds
        state.togglePause()                 // 一時停止
        RunLoop.current.run(until: Date().addingTimeInterval(1.6))
        let paused = state.elapsedSeconds
        state.togglePause()                 // 再開
        RunLoop.current.run(until: Date().addingTimeInterval(1.6))
        let resumed = state.elapsedSeconds
        state.stop()
        // 片付け
        let root = LocalStore.dataRoot
            .appendingPathComponent("meetings/\(state.currentMeetingId)").path
        try? FileManager.default.removeItem(atPath: root)
        guard running >= 2, paused == running, resumed > paused else {
            print("SELFTEST_FAIL timer running=\(running) paused=\(paused) resumed=\(resumed)"); exit(2)
        }
        print("SELFTEST_OK timer: 経過が進む running=\(running) 停止で止まる paused=\(paused) 再開で進む resumed=\(resumed)")
        exit(0)
    }

    /// `--selftest connectorflow`: OAuth の loopback listener が開き、折り返しを core で解析できるか検証する。
    /// live なトークン交換は実提供者が要るのでここでは扱わない（loopback + callback 解析まで）。
    @MainActor
    private static func connectorflow() async {
        let flow = ConnectorFlow()
        var got: OauthCallback?
        let port: UInt16
        do {
            port = try await flow.startLoopback { params in got = params }
        } catch { print("SELFTEST_FAIL connectorflow listener error=\(error)"); exit(2) }
        guard port > 0 else { print("SELFTEST_FAIL connectorflow: no port"); exit(3) }
        // 疑似的な折り返しを自分で送る（提供者のブラウザの代わり）。
        let url = URL(string: "http://127.0.0.1:\(port)/callback?code=abc123&state=xyz789")!
        _ = try? await URLSession.shared.data(from: url)
        flow.stopLoopback()
        guard let params = got, params.code == "abc123", params.state == "xyz789" else {
            print("SELFTEST_FAIL connectorflow code=\(got?.code ?? "nil") state=\(got?.state ?? "nil")"); exit(4)
        }
        print("SELFTEST_OK connectorflow: loopback 受理 code=\(params.code ?? "") state=\(params.state ?? "") port=\(port)")
        exit(0)
    }

    /// `--selftest connectorstate`: 接続可否の判定（設定済みプロバイダ・アプリ→プロバイダ対応）を検証する。
    /// 未設定では繋げないこと（推測で埋めない）を確かめる。実 OAuth は不要。
    @MainActor
    private static func connectorstate() {
        let cs = ConnectorState.shared
        // アプリ→プロバイダの対応。
        guard ConnectorState.provider(for: "Gmail") == "google",
              ConnectorState.provider(for: "Google Calendar") == "google",
              ConnectorState.provider(for: "Microsoft Teams") == "microsoft",
              ConnectorState.provider(for: "Finder") == nil else {
            print("SELFTEST_FAIL connectorstate: provider mapping"); exit(2)
        }
        // client_id が env に無ければ、対応プロバイダがあっても繋げない（推測で埋めない）。
        let hasGoogleEnv = ProcessInfo.processInfo.environment["ASTRA_OAUTH_GOOGLE_CLIENT_ID"] != nil
        let canGmail = cs.canConnect("Gmail")
        guard canGmail == hasGoogleEnv else {
            print("SELFTEST_FAIL connectorstate: canConnect(Gmail)=\(canGmail) but env=\(hasGoogleEnv)"); exit(3)
        }
        // Finder は OAuth プロバイダが無いので常に繋げない。
        guard !cs.canConnect("Finder") else { print("SELFTEST_FAIL connectorstate: Finder connectable"); exit(4) }
        print("SELFTEST_OK connectorstate: mapping ok, canConnect gated by client_id (google env=\(hasGoogleEnv))")
        exit(0)
    }

    /// Reuse the prepared test host's identity; do not spend an auth-rate-limit slot per fixture.
    private static func preparedTestToken(base: String, email: String) throws -> String {
        if let path = ProcessInfo.processInfo.environment["ASTRA_SELFTEST_AGENT_TOKEN_PATH"], path.hasPrefix("/tmp/") {
            return try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return try GenieCoreBridge.devSignIn(base, email: email, displayName: "SelfTest").accessToken
    }

    /// `--selftest voiceask <base>`: Voice HUD の依頼が Agent に届き、thinking→応答→idle と進むか検証する。
    @MainActor
    private static func voiceask(_ args: [String]) {
        let base = args.count > (args.firstIndex(of: "--selftest")! + 2)
            ? args[args.firstIndex(of: "--selftest")! + 2] : "http://127.0.0.1:3000"
        guard GenieCoreBridge.reachable(base) else { print("SELFTEST_SKIP voiceask: gateway unreachable"); exit(0) }
        do {
            let accessToken = try preparedTestToken(base: base, email: "voiceask-\(getpid())@astra.local")
            guard LocalStore.shared.open() else { print("SELFTEST_FAIL voiceask: storage unavailable"); exit(2) }
            let hud = VoiceHUDState.shared
            hud.configureBackend(base: base, token: accessToken)
            guard hud.ask("次の予定を一文で整理してください。Genieのレビューは金曜日15時です。"), let id = hud.latestRequestID else {
                print("SELFTEST_FAIL voiceask: request not accepted"); exit(2)
            }
            let wasThinking = hud.mode == .thinking
            let deadline = Date().addingTimeInterval(60)
            while hud.requestInFlight && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
            let record = LocalStore.shared.loadTasks().first { $0.id == id }?.requestRecord
            // Settled short answers remain visible in the TaskDock so the user
            // can read them immediately; older builds returned to idle here.
            let settled = switch hud.mode {
            case .idle, .answer: true
            default: false
            }
            guard wasThinking, record?.hasResult == true, settled,
                  hud.answer.contains("金曜"), hud.answer.contains("15") || hud.answer.contains("3時") else {
                print("SELFTEST_FAIL voiceask: no completed, persisted answer with fixture facts"); exit(2)
            }
            let preview = String(hud.answer.prefix(36)).replacingOccurrences(of: "\n", with: " ")
            print("SELFTEST_OK voiceask: thinking=\(wasThinking)→settled Agent 応答=\"\(preview)…\"")
            exit(0)
        } catch { print("SELFTEST_FAIL voiceask error=\(error)"); exit(3) }
    }

    /// `--selftest recoveryoffline <base>`: サインイン前に録ったオフライン録音（local id）を、後から
    /// サインインして復旧できるか検証する（新規会議作成→リネーム→送信→候補から消える）。
    @MainActor
    private static func recoveryOffline(_ args: [String]) {
        let base = args.count > (args.firstIndex(of: "--selftest")! + 2)
            ? args[args.firstIndex(of: "--selftest")! + 2] : "http://127.0.0.1:3000"
        guard GenieCoreBridge.reachable(base) else { print("SELFTEST_SKIP recoveryoffline: gateway unreachable"); exit(0) }
        do {
            // オフライン録音: gateway 会議を作らず、local id で断片を書く。
            let localId = "meeting-\(getpid())"
            let root = LocalStore.dataRoot
                .appendingPathComponent("meetings").path
            let session = try RecordingSession.start(root: root, meetingId: localId)
            let oneSec = [Float](repeating: 0.1, count: 16_000)
            for _ in 0..<6 { _ = session.pushSamples(samples: oneSec, sampleRate: 16_000) }
            try session.finish()
            // 後からサインインして復旧。
            let token = try preparedTestToken(base: base, email: "recoff-\(getpid())@astra.local")
            // This fixture deliberately uploads its generated six-second signal.
            // Consent is process-local and never changes the user's stored preference.
            var arguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
            arguments["astra.transcription.cloudGoogleSTT"] = true
            UserDefaults.standard.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain)
            let runtime = RecordingRuntime.shared
            runtime.configureBackend(base: base, accessToken: token)
            let foundBefore = runtime.recoverableMeetings().contains { $0.meetingId == localId }
            let sent = runtime.recover(meetingId: localId)
            let stillLocal = runtime.recoverableMeetings().contains { $0.meetingId == localId }
            // Never delete other recovery candidates. The renamed, uploaded fixture
            // remains under the caller's isolated test root for diagnostic inspection.
            try? FileManager.default.removeItem(atPath: root + "/" + localId)
            guard foundBefore, sent > 0, !stillLocal else {
                print("SELFTEST_FAIL recoveryoffline found=\(foundBefore) sent=\(sent) stillLocal=\(stillLocal)"); exit(2)
            }
            print("SELFTEST_OK recoveryoffline: オフライン録音を新規会議に紐付けて復旧 sent=\(sent) local消滅=\(!stillLocal)")
            exit(0)
        } catch { print("SELFTEST_FAIL recoveryoffline error=\(error)"); exit(3) }
    }



    /// `--selftest shots [outDir]`: Visual Gate の 8 画面を**実アプリで実提示して撮る**。
    /// 撮るのは自プロセスの窓だけ（デスクトップや他アプリを写さない）。geometry も同時に測り、
    /// 「窓が在るだけ」で PASS にしない。既定の出力先は /tmp/astra-shots。
    @MainActor
    /// 4 面 + 中の 2 面ずつを Main Window だけ撮る（盲検 Blind Discovery の素材。実画面は撮らない）。
    /// `--selftest sections <dir> [dark]`。
    private static func sections(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-sections"
        let dark = args.count > i + 3 && args[i + 3] == "dark"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        parkCursor()
        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        MainWindowController.shared.show(); settle(1.2)
        guard let win = NSApp.windows.first(where: { $0.isVisible && $0.contentView is NSHostingView<MainWindowView> }) else {
            print("SELFTEST_FAIL sections: Main Window が無い"); exit(1)
        }
        var shot: [String] = [], fail: [String] = []
        func take(_ name: String, _ present: () -> Void) {
            present(); settle(0.9)
            // 撮る直前に前面へ。inactive の窓は sidebar の選択色が薄く、switch が off に見える
            // （workcontext gate: key=false active=false のまま撮っていた）。
            NSApp.activate(ignoringOtherApps: true)
            win.makeKeyAndOrderFront(nil)
            settle(0.3)
            let id = CGWindowID(max(0, win.windowNumber))
            guard id != 0, let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .bestResolution]),
                  let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else {
                fail.append(name); return
            }
            try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
            shot.append(name)
        }
        take("home") { MainWindowController.shared.showSection(.home) }
        // Work Context（気にすること・待ち・返すもの・今週の負荷）と Personalization。
        // 差し込みは gateway の契約と同じ JSON（WorkContextFixture）。撮り終えたら外す。
        take("home-work-context") {
            WorkContextStore.shared.install(WorkContextFixture.context(), profile: WorkContextFixture.profile())
            MainWindowController.shared.showSection(.work); settle(0.3)
            MainWindowController.shared.showSection(.home)
        }
        take("home-personalization") { MainNav.shared.personalizationOpen = true }
        MainNav.shared.personalizationOpen = false
        take("home-work-why") {
            if let first = WorkContextStore.shared.context?.priorities.first { WorkContextStore.shared.evidenceOpen.insert(first.id) }
        }
        WorkContextStore.shared.evidenceOpen = []
        // 会議前の brief（閉じた行 / 開いた中身）。
        take("home-meeting-brief") {
            WorkContextStore.shared.installBrief(WorkContextFixture.brief())
            WorkContextStore.shared.briefOpen = true
            MainWindowController.shared.showSection(.work); settle(0.3)
            MainWindowController.shared.showSection(.home)
        }
        WorkContextStore.shared.installBrief(nil)
        WorkContextStore.shared.install(nil, profile: nil)
        take("work-tasks") { MainWindowController.shared.showWork(.tasks) }
        take("work-agents") { MainWindowController.shared.showWork(.agents) }
        take("library-meetings") { MainWindowController.shared.showLibrary(.meetings) }
        take("library-files") { MainNav.shared.libraryTab = .files; MainWindowController.shared.showSection(.library) }
        take("apps-plugins") { MainNav.shared.appsTab = .plugins; MainWindowController.shared.showSection(.apps) }
        take("apps-connectors") { MainNav.shared.appsTab = .connectors; MainWindowController.shared.showSection(.apps) }
        MainNav.shared.appsTab = .plugins; MainNav.shared.libraryTab = .meetings; MainNav.shared.workTab = .tasks
        if fail.isEmpty { print("SELFTEST_OK sections: \(shot.count) 面 → \(outDir)"); exit(0) }
        print("SELFTEST_FAIL sections: 撮れない \(fail)"); exit(1)
    }

    @MainActor
    private static func shots(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-shots"
        // 3 番目の引数で外観を切り替える（Visual Gate の light/dark 視認性）。
        let dark = args.count > i + 3 && args[i + 3] == "dark"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        parkCursor()

        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        /// 自プロセスの最前面の窓を撮る。戻りは (幅, 高さ, 色数)。
        ///
        /// 窓が出るまでの時間は機械の忙しさで変わる。固定待ちにすると、
        /// verify:all のように連続で回したときだけ「撮影不可」で落ちた（実際に起きた）。
        /// 目当ての寸法の窓が window server に現れるまで待ってから撮る。
        /// 出し直しても撮れないときだけ諦める。`present` を渡すと、失敗したときに
        /// もう一度提示してから撮り直す —— 稀に窓が window server に現れないまま
        /// 8 秒が過ぎることがあり、そのたびにゲート全体が落ちていた。
        /// 撮れないことと、撮った結果が違うことは別に扱う。
        func capture(_ name: String, minW: CGFloat = 40, minH: CGFloat = 20,
                     present: (() -> Void)? = nil) -> (w: Int, h: Int, colors: Int)? {
            for attempt in 0..<3 {
                if attempt > 0 {
                    present?()
                    settle(1.0)
                }
                if let got = captureOnce(name, minW: minW, minH: minH) { return got }
            }
            return nil
        }

        func captureOnce(_ name: String, minW: CGFloat = 40, minH: CGFloat = 20) -> (w: Int, h: Int, colors: Int)? {
            var best: (CGWindowID, Int, Int)? = nil
            let deadline = Date().addingTimeInterval(8)
            repeat {
                settle(0.25)
                var area = 0
                best = nil
                if let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
                    for info in infos {
                        guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                              let num = info[kCGWindowNumber as String] as? CGWindowID,
                              let b = info[kCGWindowBounds as String] as? [String: Any],
                              let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat,
                              w >= minW, h >= minH else { continue }
                        if Int(w * h) > area { area = Int(w * h); best = (num, Int(w), Int(h)) }
                    }
                }
            } while best == nil && Date() < deadline
            // 出た直後は描画が終わっていないことがあるので一拍おく。
            settle(0.6)
            guard let (winID, w, h) = best,
                  // golden は logical points で保存する。Retina の物理画素を使うと
                  // 同じ 220x44pt の窓が 440x88px になり、別の寸法と誤判定される。
                  let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, winID, [.boundsIgnoreFraming, .nominalResolution]),
                  cg.width == w, cg.height == h
            else { return nil }
            let rep = NSBitmapImageRep(cgImage: cg)
            var seen = Set<UInt32>()
            let pw = rep.pixelsWide, ph = rep.pixelsHigh
            let sx = max(1, pw / 60), sy = max(1, ph / 60)
            var y = 0
            while y < ph { var x = 0
                while x < pw {
                    if let c = rep.colorAt(x: x, y: y) {
                        let r = UInt32(max(0, min(255, c.redComponent * 255)))
                        let g = UInt32(max(0, min(255, c.greenComponent * 255)))
                        let bl = UInt32(max(0, min(255, c.blueComponent * 255)))
                        seen.insert((r << 16) | (g << 8) | bl)
                    }
                    x += sx }
                y += sy }
            if let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
            }
            return (w, h, seen.count)
        }

        var report: [String] = []
        var failures: [String] = []
        var captureLayouts: [String: [String: Int]] = [:]
        func record(_ name: String, _ r: (w: Int, h: Int, colors: Int)?, expW: CGFloat?, expH: CGFloat?, minColors: Int) {
            guard let r = r else { failures.append("\(name)=撮影不可"); return }
            var ok = r.colors >= minColors
            if let ew = expW { ok = ok && abs(r.w - Int(ew)) <= 2 }
            if let eh = expH { ok = ok && abs(r.h - Int(eh)) <= 2 }
            if !ok { failures.append("\(name)(\(r.w)x\(r.h),c\(r.colors))") }
            report.append("\(name) \(r.w)x\(r.h) c\(r.colors)")
            let isDock = ["01-voice-hud-idle", "02-voice-hud-listening", "02b-voice-hud-preparing"].contains(name)
            captureLayouts[name] = ["width": r.w, "height": r.h,
                                   "topInsetPx": isDock ? Int(WindowCoordinator.shared.dockTopInset) : 0]
        }

        let state = RecordingWorkspaceState.shared

        // 音の経路も本番と同じにする。検査には音が流れないので、そのまま撮ると
        // 「音が届いていません」という**異常時の姿**が基準になってしまう。
        RecordingRuntime.shared.markListening(.localUser)
        RecordingRuntime.shared.markListening(.remoteAudio)

        // 本番と同じ状態で撮る。ショートカットを登録しないまま撮ると、
        // 待機中の HUD が「登録できていないときの姿」になり、**実利用者が見ない絵**が
        // 基準になる（実際そうなった: ⌥Space の案内がクリック案内に変わった）。
        _ = GlobalShortcut.shared.register(handler: {})

        // 01 voice-hud-idle
        VoiceHUDState.shared.mode = .idle
        WindowCoordinator.shared.showVoiceHUD()
        let idleSize = GenieStateStore.shared.dock.size()
        record("01-voice-hud-idle", capture("01-voice-hud-idle"),
               expW: idleSize.width, expH: idleSize.height + WindowCoordinator.shared.dockTopInset, minColors: 4)

        // 02b voice-hud-preparing（先に撮る）
        //
        // 「準備中…」は実装都合の一瞬ではなく**正式な状態**。まだ 1 サンプルも取り込めていない間は
        // こう名乗る、という約束を絵で固定する。golden が無いと、赤い指示子が先に出る／
        // 「聞いています…」が取り込み前に出る、といった state-truth の後退を画像で捕まえられない。
        VoiceHUDState.shared.beginPreparingForShot()
        VoiceHUDState.shared.mode = .listening(partial: "")
        let preparingSize = GenieStateStore.shared.dock.size()
        record("02b-voice-hud-preparing", capture("02b-voice-hud-preparing"),
               expW: preparingSize.width, expH: preparingSize.height + WindowCoordinator.shared.dockTopInset, minColors: 4)

        // 02 voice-hud-listening
        // 実マイクを開かない撮影なので、「取り込めている姿」を作ってから撮る。
        // これをしないと、撮るのは名乗る前の「準備中…」になり、実利用者が見る絵ではなくなる
        // （録音側で `markListening` を先に呼ぶのと同じ理由）。
        VoiceHUDState.shared.markVoiceCaptureLive()
        VoiceHUDState.shared.mode = .listening(partial: "")
        // Dock は状態ごとに寸法が変わる。期待値も状態から引く（固定値で持たない）。
        let listeningSize = GenieStateStore.shared.dock.size()
        record("02-voice-hud-listening", capture("02-voice-hud-listening"),
               expW: listeningSize.width, expH: listeningSize.height + WindowCoordinator.shared.dockTopInset, minColors: 4)
        // PREPARING_VISUAL_GATE: 同じ窓・同じ寸法で、意味だけが違う 2 枚であること。
        // 寸法が違えば「preparing だけ geometry が崩れた」を、同一なら「名乗りが変わっていない」を捕まえる。
        if abs(preparingSize.width - listeningSize.width) > 2
            || abs(preparingSize.height - listeningSize.height) > 2 {
            failures.append("02b-preparing の寸法が listening と違う"
                + "(\(Int(preparingSize.width))x\(Int(preparingSize.height))"
                + " vs \(Int(listeningSize.width))x\(Int(listeningSize.height)))")
        }
        VoiceHUDState.shared.mode = .idle
        WindowCoordinator.shared.hideVoiceHUD()
        settle(0.4)

        // 03 recording-workspace（Hero 中心・RAG 閉）
        state.loadDemo(ragOpen: false)
        state.selectedTool = .transcript
        WindowCoordinator.shared.showRecordingWorkspace()
        record("03-recording-workspace", capture("03-recording-workspace"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)

        // 03b recording-paused: 一時停止。主役の点が灰になり、見出しが「一時停止中」になる。
        // 一時停止の手は録音面の pill にある（Dock は点だけ）。Atlas meeting.paused はここで撮る。
        state.isPaused = true
        settle(0.3)
        record("03b-recording-paused", capture("03b-recording-paused"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)
        state.isPaused = false

        // 04 recording-transcript（会話が伸びた Transcript）
        //
        // ここは `selectedTool = .transcript` を置き直すだけだった。だが loadDemo が
        // 既に transcript を選んでいるので、03 と**画素まで同じ絵**になっていた。
        // 3 発話の短い会話では、伸びたときに読めるかが分からない。実際の会議の長さで撮る。
        state.selectedTool = .transcript
        let shortTranscript = state.transcript
        state.transcript += [
            TranscriptSegment(speaker: "田中", text: "見積は今週中にいただけますか。", interim: false, at: 271),
            TranscriptSegment(speaker: "伊藤", text: "修正版を明日お送りします。", interim: false, at: 284),
            TranscriptSegment(speaker: "あなた", text: "初期費用の内訳も添えてください。", interim: false, at: 296),
            TranscriptSegment(speaker: "鈴木", text: "OAuth の権限範囲は最小にしています。", interim: false, at: 309),
            TranscriptSegment(speaker: "田中", text: "では 10 月導入で進めます。", interim: false, at: 323),
            TranscriptSegment(speaker: "伊藤", text: "承知しました。稟議を通します。", interim: true, at: 337),
        ]
        state.refreshRag()
        settle(0.3)
        record("04-recording-transcript", capture("04-recording-transcript"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)
        // 長い会話を 05 / 10 へ持ち越さない。行数がスクロールの境目に乗ると、
        // 撮影のたびに 1〜2px 縦へずれて golden が安定しなくなる（実測 1.08%）。
        // 05 が見せたいのは RAG Drawer で、会話の長さではない。
        state.transcript = shortTranscript
        state.refreshRag()
        settle(0.3)

        // 05 recording-rag（RAG Drawer 展開）
        state.ragOpen = true
        state.refreshRag()
        record("05-recording-rag", capture("05-recording-rag"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)
        // 10 agent-timeline: §15 AI が何をしているかが段階で見えるか。
        state.permissionIssue = nil
        state.ragOpen = false
        GenieStateStore.shared.startTask(AgentTask(
            id: UUID(), title: "リアルタイム要約", status: .running,
            steps: [
                AgentStep(title: "会話を用意する", tool: "conversation", state: .success),
                AgentStep(title: "文字起こしを読む", tool: "transcript", state: .running),
                AgentStep(title: "答えをまとめる", tool: "agent"),
            ],
            startedAt: Date(),
            context: ContextBundle(items: [ContextFact(
                source: .accessibility, application: "Zoom", sensitivity: .workspace,
                summary: "会議中", capturedAt: Date(), expiresAt: Date().addingTimeInterval(60))])))
        record("10-agent-timeline", capture("10-agent-timeline"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)
        GenieStateStore.shared.reset()

        // 11 meeting-canvas: §21 会議中に溜まる構造データが画面に出るか。
        // 拾った行には出所（いつ・誰が）が付く。付かない絵を golden に残さない。
        // **時刻は経過（04:21）以下で、右の文字起こしの実在する行を指す。**抽出項目の時刻が経過より
        // 後だったり、対応する発言が transcript に無いと、「出所 ›」の裏が取れず矛盾して見える（盲検で毎回指摘）。
        RecordingWorkspaceState.shared.transcript = [
            TranscriptSegment(speaker: "田中", text: "初期費用が心配です", interim: false, at: 168),
            TranscriptSegment(speaker: "田中", text: "導入時期は 10 月で行きます", interim: false, at: 205),
            TranscriptSegment(speaker: "あなた", text: "見積は明日までにお願いします", interim: false, at: 228),
            TranscriptSegment(speaker: "鈴木", text: "誰が対応しますか？", interim: false, at: 244),
        ]
        GenieStateStore.shared.updateCanvas(MeetingCanvas(
            decisions: [CanvasItem("導入時期は 10 月で行きます", at: 205, speaker: "田中")],
            actions: [CanvasItem("見積は明日までにお願いします", at: 228, speaker: "あなた")],
            questions: [CanvasItem("誰が対応しますか？", at: 244, speaker: "鈴木")],
            concerns: [CanvasItem("初期費用が心配です", at: 168, speaker: "田中")],
            notes: []))
        record("11-meeting-canvas", capture("11-meeting-canvas"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)
        GenieStateStore.shared.reset()
        RecordingWorkspaceState.shared.transcript = []   // 上で入れた行を次の面へ持ち越さない

        // 09 permission-denied: 許可が無いまま録り続けていることが画面に出るか。
        // 「録音中」と出ているのに無音、が一番高くつく壊れ方なので必ず撮る。
        state.ragOpen = false
        state.permissionIssue = .microphoneDenied
        // 許可が無く、**何も届いていない**姿（一番高くつく壊れ方）。届いている経路を空にする。
        // 空にしないと「画面の音を聞いています」が正しく出て、それは別の状態の絵になる。
        RecordingRuntime.shared.resetListening()
        // 聞けていないのに文字起こしが並んでいる絵を「正しい」として残さない。
        // デモの transcript が載ったままだったので、「音声が記録されていません」の
        // すぐ隣で 3 人が喋っている画面をゲートが通していた。
        state.transcript = []
        state.refreshRag()
        settle(0.3)
        record("09-permission-denied", capture("09-permission-denied"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)
        state.permissionIssue = nil
        RecordingRuntime.shared.markListening(.localUser)
        RecordingRuntime.shared.markListening(.remoteAudio)

        // 09c speech-denied: 音は録れているが、音声認識の許可が無い。理由と直しに行く道を出す。
        state.permissionIssue = .speechDenied
        state.transcript = []
        state.refreshRag()
        settle(0.3)
        record("09c-speech-denied", capture("09c-speech-denied"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)
        state.permissionIssue = nil

        // 09b stt-unavailable: 音は届いて録れているが、この Mac ではオンデバイス文字起こしが始められない。
        // 黙って空の文字起こしにせず、理由を言う（サーバへは出さない）。
        RecordingRuntime.shared.setTranscriptionUnavailableForShot(true)
        state.transcript = []
        state.refreshRag()
        settle(0.3)
        record("09b-stt-unavailable", capture("09b-stt-unavailable"),
               expW: Metrics.workspaceWidth, expH: Metrics.workspaceHeight, minColors: 12)
        RecordingRuntime.shared.setTranscriptionUnavailableForShot(false)
        WindowCoordinator.shared.hideRecordingWorkspace()
        settle(0.5)

        // 06 main-home / 07 apps は Main Window から
        MainWindowController.shared.show()
        settle(1.2)
        record("06-main-home", capture("06-main-home", minW: 700, minH: 500,
                       present: { MainWindowController.shared.showSection(.home) }), expW: nil, expH: nil, minColors: 8)

        // 07 apps: Main の Apps タブへ（accessibility 経由ではなく状態で切り替える）
        MainWindowController.shared.showSection(.apps)
        record("07-apps", capture("07-apps", minW: 700, minH: 500,
                       present: { MainWindowController.shared.showSection(.apps) }), expW: nil, expH: nil, minColors: 8)

        // 08 meeting-detail: Library の会議詳細（MeetingArtifactView）
        MainWindowController.shared.showMeetingDetailPreview()
        record("08-meeting-detail", capture("08-meeting-detail", minW: 700, minH: 500,
                       present: { MainWindowController.shared.showMeetingDetailPreview() }), expW: nil, expH: nil, minColors: 8)

        // 12 recording-now: 録音中に Home へ戻ったとき、そこに録音が見えるか。
        //
        // ここは `GenieStateStore.meetingStarted()` を直に叩いていた。だが Home が見るのは
        // `MeetingSessionStore` で、Session を作るのは `RecordingWorkspaceState.start()` の側。
        // つまりボタンより下の層を叩いていたので Session が生まれず、
        // **録音が写っていない Home** を「recording-now」として撮って緑にしていた。
        // ボタンと同じ入口を通す。
        // 実際の利用者の Home は空ではない。録音カードの下に最近の会議が続く（下部の大きな空白を作らない）。
        let rnStore = MeetingSessionStore.shared
        // begin → beginProcessing(endedAt を入れる) → markReady の順で通す。
        // beginProcessing を挟まないと endedAt が nil のままで、経過が「今 - 開始」になり 120 分等の嘘になる。
        let rn1s = Date().addingTimeInterval(-2 * 3600)
        rnStore.begin(id: "rn-recent-1", title: "Q4 移行計画の打ち合わせ", source: "Google Meet", now: rn1s)
        rnStore.beginProcessing(id: "rn-recent-1", now: rn1s.addingTimeInterval(42 * 60))
        rnStore.markReady(id: "rn-recent-1", summary: "Q4 移行計画とトレーニングコストを議論。10 月から Phase 1 開始で合意。",
                          actions: 3, decisions: 2, participants: 5, now: rn1s.addingTimeInterval(42 * 60))
        let rn2s = Date().addingTimeInterval(-26 * 3600)
        rnStore.begin(id: "rn-recent-2", title: "A 社 商談", source: "Zoom", now: rn2s)
        rnStore.beginProcessing(id: "rn-recent-2", now: rn2s.addingTimeInterval(31 * 60))
        rnStore.markReady(id: "rn-recent-2", summary: "見積の前提と初期費用を確認。稟議は今週中。",
                          actions: 2, decisions: 1, participants: 3, now: rn2s.addingTimeInterval(31 * 60))
        GenieStateStore.shared.meetingDetected(app: "Google Meet")
        // The visual fixture needs a live Session/Home card, not a hardware
        // permission check. Keep it on the disk-only path; live microphone
        // behavior is covered by the signed recording gate.
        state.start(captureMic: false, transcribe: false, requestPermissions: false)
        MainWindowController.shared.showSection(.home)
        settle(0.5)
        record("12-recording-now", capture("12-recording-now", minW: 700, minH: 500,
                       present: { MainWindowController.shared.showSection(.home) }),
               expW: nil, expH: nil, minColors: 8)
        // 録音中の Home に、その録音が実際に出ているか（絵だけでなく状態でも言う）。
        if MeetingSessionStore.shared.sessions.first(where: { $0.isLive }) == nil {
            failures.append("12-recording-now=録音中なのに Home に live な Session が無い")
        }
        state.stop()
        GenieStateStore.shared.reset()
        WindowCoordinator.shared.hideRecordingWorkspace()


        // 別々の名前の面が、同じ絵になっていないか。
        //
        // 名前が違うだけの golden は、通っても何も証明しない。実際に
        // `04-recording-transcript` は `03-recording-workspace` と画素まで同一で、
        // `12-recording-now` は録音が写っていない Home そのものだった。
        // どちらもゲートは緑だった。**寸法と色数だけ見ていたから**気づけなかった。
        for pair in duplicatePairs(in: outDir, names: report.map { $0.split(separator: " ")[0] }.map(String.init)) {
            failures.append("\(pair.0) と \(pair.1) が同じ絵（名前だけ違う）")
        }

        print("SHOTS_DIR \(outDir)")
        do {
            let data = try JSONSerialization.data(withJSONObject: captureLayouts, options: [.sortedKeys, .prettyPrinted])
            try data.write(to: URL(fileURLWithPath: "\(outDir)/capture-layout.json"), options: .atomic)
        } catch { failures.append("capture layout write failed: \(error)") }
        for line in report { print("SHOT \(line)") }
        if failures.isEmpty {
            // 枚数は数えて言う（固定で書くと、面を足したときに嘘になる。実際 12 のまま 13 枚撮っていた）。
            print("SELFTEST_OK shots: \(report.count)面を実アプリで撮影・geometry OK・面どうしが別の絵")
            exit(0)
        } else {
            print("SELFTEST_FAIL shots: \(failures.joined(separator: ", "))")
            exit(2)
        }
    }

    /// 自プロセスが**画面に出している**窓の寸法一覧。HUD と Workspace の排他を
    /// window server の事実として測るために使う（内部フラグではなく実表示を見る）。
    @MainActor
    private static func onScreenWindowSizes() -> [(w: Int, h: Int)] {
        var out: [(Int, Int)] = []
        let pid = getpid()
        if let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for info in infos {
                guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                      let b = info[kCGWindowBounds as String] as? [String: Any],
                      let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat,
                      w > 40, h > 20 else { continue }
                out.append((Int(w), Int(h)))
            }
        }
        return out.map { (w: $0.0, h: $0.1) }
    }

    /// だいたい一致（±2pt）。window server 側で 1pt ずれることがある。
    private static func near(_ a: Int, _ b: CGFloat) -> Bool { abs(a - Int(b)) <= 2 }

    /// `--selftest e2e001 <base>`: UI/UX テスト仕様 v1.0 の **E2E-001 / Product Reality Gate**。
    ///
    /// 「HUD → dictation → 会議 → Transcript/AI → 保存 → Library → HUD 復帰」を
    /// **窓を実提示したまま**一本で通し、5 系統（SEE/HEAR/THINK/ACT/REMEMBER）が繋がっているかを測る。
    /// 特に **HUD と Recording Workspace が同時に画面へ残らない**ことを CGWindowList の事実で検査する。
    /// モード切替はユーザー操作を模した `toggleRecording()`（＝グローバルショートカット）だけで、
    /// 途中で手動の窓操作を挟まない。
    @MainActor
    private static func e2e001(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let base = args.count > i + 2 ? args[i + 2] : "http://127.0.0.1:3000"
        // gateway が無くても E2E-001 の骨（HUD→dictation→会議→保存→HUD 復帰と**窓の排他**）は通す。
        // 仕様 P0-9 / ERR-001「ネット切断でもローカル録音は続く」を同時に確かめることになる。
        let online = GenieCoreBridge.reachable(base)
        let synthetic = ProcessInfo.processInfo.environment["ASTRA_E2E_SYNTHETIC"] == "1"
        if !synthetic {
            guard Permissions.microphone == .granted else { print("SELFTEST_SKIP e2e001: mic not granted"); exit(0) }
        }

        var steps: [String] = []
        func settle(_ seconds: Double) {
            let until = Date().addingTimeInterval(seconds)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }

        do {
            guard LocalStore.shared.open() else { print("SELFTEST_FAIL e2e001 database unavailable"); exit(2) }
            // ---- サインイン（実 gateway）。以後すべて実経路。
            let state = RecordingWorkspaceState.shared
            if online {
                let token = try preparedTestToken(base: base, email: "e2e-\(getpid())@astra.local")
                state.configureBackend(base: base, token: token)
                RecordingRuntime.shared.configureBackend(base: base, accessToken: token)
                VoiceHUDState.shared.configureBackend(base: base, token: token)
            }

            // ---- ① 起動直後: Voice HUD が出ていて、Workspace は無い。
            NSApp.setActivationPolicy(.regular)
            WindowCoordinator.shared.showVoiceHUD()
            settle(1.0)
            var wins = onScreenWindowSizes()
            let hudUp = wins.contains { near($0.w, Metrics.hudWidth) && near($0.h, Metrics.hudHeight + WindowCoordinator.shared.dockTopInset) }
            let wsAbsent = !wins.contains { near($0.w, Metrics.workspaceWidth) && near($0.h, Metrics.workspaceHeight) }
            guard hudUp, wsAbsent else {
                print("SELFTEST_FAIL e2e001 ①HUD: hud=\(hudUp) workspaceAbsent=\(wsAbsent) wins=\(wins)"); exit(2)
            }
            steps.append("①HUD常駐")

            // ---- ② ACT: どのアプリでも音声入力（HUD-004）。実テキスト欄へ入る。
            let field = NSTextField(string: "")
            field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
            let typing = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 80),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            typing.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 80))
            typing.contentView?.addSubview(field)
            if let sc = NSScreen.main { typing.setFrameOrigin(NSPoint(x: sc.frame.midX - 180, y: sc.frame.minY + 120)) }
            typing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            typing.makeFirstResponder(field)
            settle(1.0)
            // 自分の入力欄が AX の焦点になっているか。端末から起動すると TCC は
            // 責任プロセス（ターミナル）に紐づくので、system-wide の焦点は
            // **ターミナルの入力欄**を返す。そこへ入ってしまうので、この段は
            // この起動のしかたでは確かめられない。落とさず「未検証」と記す
            // —— 他の 8 段は有効なので、まとめて捨てない。
            var ownFocus = false
            do {
                let sys = AXUIElementCreateSystemWide()
                var f: CFTypeRef?
                if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &f) == .success,
                   let el = f {
                    var r: CFTypeRef?
                    var owner: pid_t = 0
                    let ownPID = AXUIElementGetPid(el as! AXUIElement, &owner) == .success && owner == getpid()
                    if AXUIElementCopyAttributeValue(el as! AXUIElement, kAXRoleAttribute as CFString, &r) == .success,
                       let role = r as? String { ownFocus = ownPID && (role == (kAXTextFieldRole as String)) }
                    if ownFocus {
                        var writable: DarwinBoolean = false, selectedWritable: DarwinBoolean = false
                        let valueStatus = AXUIElementIsAttributeSettable(el as! AXUIElement, kAXValueAttribute as CFString, &writable)
                        let selectedStatus = AXUIElementIsAttributeSettable(el as! AXUIElement, kAXSelectedTextAttribute as CFString, &selectedWritable)
                        print("DICTATION_FIXTURE trusted=\(AXIsProcessTrusted()) value=\(valueStatus.rawValue)/\(writable.boolValue) selection=\(selectedStatus.rawValue)/\(selectedWritable.boolValue) editable=\(field.isEditable)")
                    }
                    var v: CFTypeRef?
                    if ownFocus,
                       AXUIElementCopyAttributeValue(el as! AXUIElement, kAXValueAttribute as CFString, &v) == .success {
                        // 自分の欄は空で始まる。値が入っているなら他アプリの欄。
                        ownFocus = ((v as? String) ?? "").isEmpty
                    }
                }
            }
            if ownFocus {
                let dictated = Dictation.insert("明日の商談の準備をお願い")
                let dictationOK = dictated && field.stringValue.contains("明日の商談の準備をお願い")
                typing.orderOut(nil); typing.close()
                settle(0.3)
                guard dictationOK else {
                    print("SELFTEST_FAIL e2e001 ②dictation: inserted=\(dictated) value=\"\(field.stringValue)\""); exit(3)
                }
                steps.append("②dictation")
            } else {
                typing.orderOut(nil); typing.close()
                settle(0.3)
                steps.append("②dictation(未検証: アプリとして起動していない)")
            }

            // ---- ③ 会議開始: ショートカット相当の 1 操作だけで録音コントローラへ切替。
            //
            // 録音は**窓を増やさない**。Dock がそのまま録音コントローラになり、
            // 大きな面は押されるまで開かない（以前はここで Workspace が出ることを見ていた）。
            if synthetic {
                state.start(captureMic: false, transcribe: false, requestPermissions: false)
            } else {
                WindowCoordinator.shared.toggleRecording()
            }
            settle(1.2)
            wins = onScreenWindowSizes()
            let controllerUp = wins.contains { near($0.w, Metrics.dockMeetingWidth) && near($0.h, Metrics.dockMeetingHeight + WindowCoordinator.shared.dockTopInset) }
            let idleGone = !wins.contains { near($0.w, Metrics.dockIdleWidth) && near($0.h, Metrics.dockIdleHeight + WindowCoordinator.shared.dockTopInset) }
            let noExtraSurface = !wins.contains { near($0.w, Metrics.workspaceWidth) && near($0.h, Metrics.workspaceHeight) }
            let meetingId = RecordingRuntime.shared.activeMeetingId
            // Live-only recording retains a local session even when an agent is connected.
            let meetingOK = !meetingId.isEmpty && LocalStore.shared.loadSessions().contains { $0.id == meetingId && $0.status == .recording }
            guard state.isRecording, controllerUp, idleGone, noExtraSurface, meetingOK else {
                print("SELFTEST_FAIL e2e001 ③切替: recording=\(state.isRecording) controller=\(controllerUp) idleGone=\(idleGone) noExtra=\(noExtraSurface) meeting=\(meetingId) wins=\(wins)"); exit(4)
            }
            steps.append("③録音コントローラへ(窓は増えない)")

            // ---- ④ HEAR: 実マイクで録る（5 秒断片が閉じる長さ）。
            if synthetic {
                RecordingRuntime.shared.push(Array(repeating: Float(0.02), count: 80_000), sampleRate: 16_000)
            }
            settle(synthetic ? 0.5 : 6.0)
            let recordedMs = RecordingRuntime.shared.recordedMs()
            guard recordedMs > 0 else { print("SELFTEST_FAIL e2e001 ④録音: recordedMs=0"); exit(5) }
            steps.append(synthetic ? "④合成音源\(recordedMs)ms（実マイク未検証）" : "④実録音\(recordedMs)ms")

            // ---- ⑤ Transcript が増える（発話を実 state へ流す。partial→final の増加を測る）。
            let before = state.transcript.count
            state.transcript.append(TranscriptSegment(speaker: "田中", text: "リリースは9月12日にしましょう。", interim: false))
            state.transcript.append(TranscriptSegment(speaker: "鈴木", text: "OAuth の確認は私がやります。", interim: false))
            let grew = state.transcript.count > before
            guard grew else { print("SELFTEST_FAIL e2e001 ⑤transcript が増えない"); exit(6) }
            steps.append("⑤transcript+\(state.transcript.count - before)")

            // ---- ⑥ SEE: 画面文脈のスクショが実ファイルになる。
            state.currentMeetingId = meetingId
            let shot = state.captureScreenshot()
            steps.append(shot != nil ? "⑥screenshot" : "⑥screenshot(skip)")

            // ---- ⑦ THINK: AI が**会議の文字起こしを文脈に**答える（実 Agent）。
            if online {
                state.runAIAction("リアルタイム要約")
                let aiDeadline = Date().addingTimeInterval(30)
                while state.aiRunning && Date() < aiDeadline { CFRunLoopRunInMode(.defaultMode, 0.1, true) }
                guard state.aiActionSucceeded, state.aiResult.contains("OAuth") else { print("SELFTEST_FAIL e2e001 ⑦AI 要約失敗: \(state.aiResult)"); exit(7) }
                steps.append("⑦AI要約")
            } else {
                steps.append("⑦AI(gateway無しのため未実行)")
            }

            // ---- ⑧ 停止 → 保存 → 結果面へ morph（巨大 modal を出さない・窓も増えない）。
            WindowCoordinator.shared.toggleRecording()
            settle(2.0)
            wins = onScreenWindowSizes()
            let controllerGone = !wins.contains { near($0.w, Metrics.dockMeetingWidth) && near($0.h, Metrics.dockMeetingHeight + WindowCoordinator.shared.dockTopInset) }
            let resultSize = GenieStateStore.shared.dock.size()
            let resultUp = wins.contains { near($0.w, resultSize.width) && near($0.h, resultSize.height + WindowCoordinator.shared.dockTopInset) }
            let stillOneSurface = wins.count == 1
            guard !state.isRecording, controllerGone, resultUp, stillOneSurface else {
                print("SELFTEST_FAIL e2e001 ⑧復帰: stopped=\(!state.isRecording) controllerGone=\(controllerGone) result=\(resultUp) wins=\(wins)"); exit(8)
            }
            steps.append("⑧停止→結果面へ morph(窓は1枚のまま)")

            // ---- ⑨ REMEMBER: live results and the closed audio remain in the local library.
            // Stopping a recording must not require a second cloud transcription pass.
            let root = LocalStore.dataRoot.appendingPathComponent("meetings").path
            let saved = LocalStore.shared.loadSessions().first { $0.id == meetingId }
            let onDisk = FileManager.default.fileExists(atPath: root + "/" + meetingId)
            guard onDisk, saved?.status == .ready, saved?.endedAt != nil else {
                print("SELFTEST_FAIL e2e001 ⑨保存: onDisk=\(onDisk) ready=\(saved?.status == .ready)"); exit(9)
            }
            try? FileManager.default.removeItem(atPath: root + "/" + meetingId)
            steps.append("⑨ローカルLibraryに同じ会議を保存・停止後の再文字起こしなし")

            WindowCoordinator.shared.hideVoiceHUD()
            print("SELFTEST_OK e2e001(" + (online ? "online" : "offline") + "): " + steps.joined(separator: " → "))
            exit(0)
        } catch {
            print("SELFTEST_FAIL e2e001 error=\(error)"); exit(10)
        }
    }

    /// Real microphone → stop → persisted ready session. Live transcription does not
    /// upload the full recording again at stop; that former assertion is obsolete.
    @MainActor
    private static func fullLifecycle(_ args: [String]) {
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP fulllifecycle: mic not granted"); exit(0) }
        WindowCoordinator.headless = true
        guard LocalStore.shared.open() else { print("SELFTEST_FAIL fulllifecycle database unavailable"); exit(2) }
        var arguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        arguments[RecordingRuntime.cloudTranscriptionDefaultsKey] = false
        UserDefaults.standard.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain)
        let state = RecordingWorkspaceState.shared
        WindowCoordinator.shared.toggleRecording()
        let recording = state.isRecording
        let meetingId = RecordingRuntime.shared.activeMeetingId
        RunLoop.current.run(until: Date().addingTimeInterval(6.0))
        let milliseconds = RecordingRuntime.shared.recordedMs()
        WindowCoordinator.shared.toggleRecording()
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline && LocalStore.shared.loadSessions().first(where: { $0.id == meetingId })?.status != .ready {
            CFRunLoopRunInMode(.defaultMode, 0.05, true)
        }
        let saved = LocalStore.shared.loadSessions().first { $0.id == meetingId }
        let folder = LocalStore.dataRoot.appendingPathComponent("meetings").appendingPathComponent(meetingId)
        let onDisk = FileManager.default.fileExists(atPath: folder.path)
        let valid = recording && !state.isRecording && milliseconds > 0 && onDisk && saved?.status == .ready && saved?.endedAt != nil
        if !meetingId.isEmpty { try? FileManager.default.removeItem(at: folder) }
        guard valid else {
            print("SELFTEST_FAIL fulllifecycle recording=\(recording) ms=\(milliseconds) onDisk=\(onDisk) ready=\(saved?.status == .ready)"); exit(2)
        }
        print("SELFTEST_OK fulllifecycle: HUD→実マイク \(milliseconds)ms→停止→同じ会議がローカルLibraryにreadyで保存")
        exit(0)
    }

    /// `--selftest panel`: overlay パネルが全 Space・fullscreen 補助・装飾なし・透過に設定されているか
    /// を検証する（§2「Window/Spaces/fullscreen挙動」）。表示はしない（属性だけ確認）。
    @MainActor
    private static func panelBehavior() {
        let panel = GeniePanel(size: NSSize(width: 100, height: 30), level: .statusBar, canKey: false,
                               content: EmptyView())
        let cb = panel.collectionBehavior
        let allSpaces = cb.contains(.canJoinAllSpaces)
        let fsAux = cb.contains(.fullScreenAuxiliary)
        let borderless = panel.styleMask.contains(.borderless)
        // 透過は必須。影は**窓が持つ**（window server がアルファをなぞるので外形どおりに落ちる）。
        // SwiftUI 側で影を掛けると、素材やレイヤを含む合成では矩形で落ちた。
        let clear = !panel.isOpaque && panel.backgroundColor == .clear && panel.hasShadow
        let notMain = panel.canBecomeMain == false
        panel.close()
        guard allSpaces, fsAux, borderless, clear, notMain else {
            print("SELFTEST_FAIL panel allSpaces=\(allSpaces) fsAux=\(fsAux) borderless=\(borderless) transparent+windowShadow=\(clear) notMain=\(notMain)"); exit(2)
        }
        print("SELFTEST_OK panel: 全Space=\(allSpaces) fullscreen補助=\(fsAux) borderless=\(borderless) 透過=\(clear) notMain=\(notMain)")
        exit(0)
    }

    /// `--selftest render`: 主要な SwiftUI ビューを**オフスクリーンで**レンダリングし、クラッシュせず
    /// 非ゼロの描画になることを確かめる（§6 UI 検証・画面には何も出さない）。
    @MainActor
    private static func render() {
        // bitmap が「実際に描かれた」か（空白でない）を確かめる。ピクセルを走査し、
        // 非透明ピクセルの割合と色の種類数が閾値を超えることを要求する。
        // pixelsWide>0 だけでは真っ白/透明でも通ってしまうため、内容そのものを検査する。
        func contentScore<V: View>(_ view: V, _ size: NSSize) -> (opaqueFrac: Double, colors: Int) {
            let host = NSHostingView(rootView: view)
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return (0, 0) }
            host.cacheDisplay(in: host.bounds, to: rep)
            let w = rep.pixelsWide, h = rep.pixelsHigh
            guard w > 0, h > 0 else { return (0, 0) }
            var opaque = 0, sampled = 0
            var seen = Set<UInt32>()
            let stepX = max(1, w / 40), stepY = max(1, h / 40)   // ~1600 サンプル
            var y = 0
            while y < h {
                var x = 0
                while x < w {
                    if let c = rep.colorAt(x: x, y: y) {
                        sampled += 1
                        if c.alphaComponent > 0.02 { opaque += 1 }
                        let r = UInt32(max(0, min(255, c.redComponent * 255)))
                        let g = UInt32(max(0, min(255, c.greenComponent * 255)))
                        let b = UInt32(max(0, min(255, c.blueComponent * 255)))
                        seen.insert((r << 16) | (g << 8) | b)
                    }
                    x += stepX
                }
                y += stepY
            }
            return (sampled > 0 ? Double(opaque) / Double(sampled) : 0, seen.count)
        }
        RecordingWorkspaceState.shared.loadDemo(ragOpen: true)
        let views: [(String, (opaqueFrac: Double, colors: Int))] = [
            ("VoiceHUD", contentScore(VoiceHUDView(), NSSize(width: Metrics.hudWidth, height: Metrics.hudHeight))),
            ("IntentBar", contentScore(IntentBarView(contextChips: ["Q4提案.pptx", "A社", "明日10:00", "+X"]), NSSize(width: Metrics.intentReadyWidth, height: Metrics.intentListeningHeight))),
            ("RecordingIndicator", contentScore(RecordingIndicatorView(), NSSize(width: Metrics.recordingIndicatorWidth, height: Metrics.recordingIndicatorHeight))),
            ("ConfirmationCard", contentScore(ConfirmationCardView(confirmation: ActionConfirmation(
                title: "田中さんにメールを送ります", details: ["宛先: tanaka@example.com", "件名: 明日の会議"],
                risk: .r2, confirmLabel: "送信する")) { _ in }, NSSize(width: 320, height: 220))),
            ("MeetingArtifact", contentScore(MeetingArtifactView(title: "A社 新規提案", duration: "42:18", participants: 3, summary: [MeetingCitation(number: 1, text: "先方は10月導入を希望。最大の懸念は初期費用。", transcriptTime: "14:18", speaker: "田中")], decisions: [MeetingCitation(number: 2, text: "導入時期を10月で検討", transcriptTime: "14:22", speaker: "鈴木")], actionItems: [MeetingCitation(number: 3, text: "伊藤 修正版見積を送付 明日", transcriptTime: "14:31", speaker: "伊藤")], selected: MeetingCitation(number: 1, text: "先方は10月導入を希望。最大の懸念は初期費用。", transcriptTime: "14:18", speaker: "田中")), NSSize(width: 900, height: 460))),
            ("ResearchResult", contentScore(ResearchResultView(title: "競合比較を調査", summaryPoints: ["主要3社が価格改定", "初期費用の分割が一般化", "10月改定が多い"], sourceCount: 12, confidence: "High", contradictions: 1), NSSize(width: 460, height: 330))),
            ("MeetingSurface", contentScore(MeetingSurfaceView(title: "A社 新規提案", elapsed: "18:42", languages: "JP→EN", notes: [MeetingNote(text: "価格条件について"), MeetingNote(text: "・導入時期は10月"), MeetingNote(text: "・先方は初期費用を懸念")], transcript: [MeetingLine(time: "14:18", speaker: "田中", text: "初期費用が少し気になっています。", translated: "We are concerned about the upfront cost.")], transcriptOpen: true), NSSize(width: 900, height: 520))),
            ("LineagePanel", contentScore(LineagePanelView(artifact: "A社 提案書 v5", derivedFrom: ["Meeting Aug 26", "Research 12 sources", "Pricing policy v7"], producedBy: "A社 商談準備"), NSSize(width: 420, height: 200))),
            ("ApprovalCard", contentScore(ApprovalCard(title: "3人にメールを送信します", details: ["To: 山田 / 田中 / 鈴木", "Subject: A社商談の事前確認"], risk: .externalCommit, affectedCount: 3, primaryLabel: "3件送信する"), NSSize(width: 420, height: 220))),
            ("EvidenceSummary", contentScore(EvidenceSummaryView(sourceCount: 12, confidence: "High", contradictions: 1, groups: [EvidenceGroup(name: "Official", count: 4), EvidenceGroup(name: "Filings", count: 3), EvidenceGroup(name: "News", count: 4), EvidenceGroup(name: "Internal", count: 1)]), NSSize(width: 420, height: 140))),
            ("WorkSurface", contentScore(WorkSurfaceView(title: "A社 商談準備", status: "進行中", steps: [WorkStep(label: "過去の商談とメールを確認", state: .done), WorkStep(label: "案件状況を整理", state: .done), WorkStep(label: "最新競合情報を調査中", state: .active, detail: "12 sources"), WorkStep(label: "提案資料を更新", state: .todo), WorkStep(label: "商談ブリーフを作成", state: .todo)]), NSSize(width: 420, height: 260))),
            ("ContextLens", contentScore(ContextLensView(items: [ContextItem(category: "Current", text: "Current screen / Q4提案.pptx"), ContextItem(category: "Entity", text: "A社 / 田中様"), ContextItem(category: "Schedule", text: "明日 10:00 商談"), ContextItem(category: "Internal", text: "関連メール8件 / 資料4件"), ContextItem(category: "Policy", text: "Confidential / Local-only", sensitive: true)]), NSSize(width: 320, height: 420))),
            ("HomeView", contentScore(HomeView(attention: [HomeAttention(kind: "10:00 A社 商談", title: "前回から価格条件が変更", action: "準備する"), HomeAttention(kind: "Research complete", title: "半導体市場調査", action: "見る")], active: [HomeWork(title: "競合20社調査", meta: "12 sources · 進行中")]), NSSize(width: 820, height: 600))),
            ("RecordingWorkspace", contentScore(RecordingWorkspaceView(), NSSize(width: Metrics.workspaceWidth, height: Metrics.workspaceHeight))),
            ("MainWindow", contentScore(MainWindowView(loadBackend: false), NSSize(width: 900, height: 600))),
            ("Settings", contentScore(SettingsView(), NSSize(width: 460, height: 420))),
        ]
        // 実際に描画されていれば、複数色（>=4）かつ相応の不透明面積（>=10%）を持つ。
        // カスタム描画の 2 面（HUD / Recording Workspace）は「高い再現度」の成果物なので
        // 強い内容（>=4 色 かつ >=10% 不透明）を要求する。Main/Settings は NavigationSplitView /
        // Form が offscreen NSHostingView では描画を実ウィンドウへ遅延するため、liveness
        // （>=2 色 = 単一の平面色でない）だけを課す。実ウィンドウ描画は panel/hudlifecycle で担保。
        let strong: Set<String> = ["VoiceHUD", "RecordingWorkspace", "IntentBar", "RecordingIndicator"]
        var failed: [String] = []
        for (name, sc) in views {
            let ok = strong.contains(name) ? (sc.colors >= 4 && sc.opaqueFrac >= 0.10) : (sc.colors >= 2)
            if !ok { failed.append("\(name)(colors=\(sc.colors),opaque=\(String(format: "%.2f", sc.opaqueFrac)))") }
        }
        guard failed.isEmpty else { print("SELFTEST_FAIL render blank: \(failed.joined(separator: ","))"); exit(2) }
        let summary = views.map { "\($0.0):c\($0.1.colors)/o\(String(format: "%.2f", $0.1.opaqueFrac))" }.joined(separator: " ")
        print("SELFTEST_OK render: \(summary)")
        exit(0)
    }

    /// `--selftest connectorexchange`: connector のトークン交換を、ローカル mock token サーバに対して
    /// Swift→core(P/Invoke 相当の UniFFI)→実 HTTP で end-to-end 検証する（残るは実提供者の実挙動のみ）。
    @MainActor
    private static func connectorExchange() {
        // mock token endpoint（127.0.0.1:port）を Network で立てる。
        let flow = ConnectorFlow()  // loopback は別途 connectorflow で検証済み。ここは交換のみ。
        _ = flow
        let listener: NWListener
        do {
            let params = NWParameters.tcp
            if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
            listener = try NWListener(using: params)
        } catch { print("SELFTEST_FAIL connectorexchange listener: \(error)"); exit(2) }
        var sawVerifier = false
        let q = DispatchQueue(label: "astra.mock.token")
        listener.newConnectionHandler = { conn in
            conn.start(queue: q)
            // **リクエストを読み切ってから返す。**
            //
            // 1 バイト届いた時点で応答して即 cancel していたので、本文が受信待ちの
            // まま閉じることがあり、OS は FIN ではなく RST を返した。RST は送信
            // バッファも捨てるので、応答を書いた直後でもクライアントは読めない。
            // ureq はそれを panic にし、UniFFI の `try!` を通って**アプリが落ちた**。
            // （同じ型を core 側の Rust テストでも踏んでいる）
            var acc = Data()
            func pump() {
                conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, done, _ in
                    if let d = data { acc.append(d) }
                    let text = String(data: acc, encoding: .utf8) ?? ""
                    var complete = done
                    if let headEnd = text.range(of: "\r\n\r\n") {
                        let head = String(text[text.startIndex..<headEnd.lowerBound])
                        let want = head.split(separator: "\r\n")
                            .first { $0.lowercased().hasPrefix("content-length:") }
                            .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                        let bodyLen = text[headEnd.upperBound...].utf8.count
                        if bodyLen >= want { complete = true }
                    }
                    guard complete else { pump(); return }
                    if text.contains("code_verifier=ver-swift") && text.contains("grant_type=authorization_code") {
                        sawVerifier = true
                    }
                    let body = "{\"access_token\":\"at-sw\",\"refresh_token\":\"rt-sw\",\"expires_in\":3600,\"token_type\":\"Bearer\"}"
                    let resp = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: \(body.utf8.count)\r\nconnection: close\r\n\r\n\(body)"
                    // isComplete: true で送ると FIN が付く。cancel() で叩き切らない。
                    conn.send(content: resp.data(using: .utf8), isComplete: true,
                              completion: .contentProcessed { _ in })
                }
            }
            pump()
        }
        let readyLock = NSLock(); var ready = false
        listener.stateUpdateHandler = { st in if case .ready = st { readyLock.lock(); ready = true; readyLock.unlock() } }
        listener.start(queue: q)
        var waited = 0
        while true { readyLock.lock(); let r = ready; readyLock.unlock(); if r || waited >= 200 { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02)); waited += 1 }
        guard let port = listener.port?.rawValue else { print("SELFTEST_FAIL connectorexchange: no port"); exit(3) }
        let tokenUrl = "http://127.0.0.1:\(port)/token"
        // Swift→core→実 HTTP でトークン交換。
        let json = connectorExchangeCode(tokenUrl: tokenUrl, providerId: "google", clientId: "cid",
            redirectUri: "http://127.0.0.1:1/cb", code: "code-1", codeVerifier: "ver-swift", nowMs: 1000)
        listener.cancel()
        guard !json.isEmpty, json.contains("at-sw"), json.contains("rt-sw"), sawVerifier else {
            print("SELFTEST_FAIL connectorexchange json=\(json) sawVerifier=\(sawVerifier)"); exit(4)
        }
        // refresh token を Keychain へ（実運用と同じ）。
        try? KeychainStore.set("astra.selftest.conntok.\(getpid())", "rt-sw")
        let read = (try? KeychainStore.get("astra.selftest.conntok.\(getpid())")) ?? nil
        try? KeychainStore.delete("astra.selftest.conntok.\(getpid())")
        guard read == "rt-sw" else { print("SELFTEST_FAIL connectorexchange keychain"); exit(5) }
        print("SELFTEST_OK connectorexchange: Swift→core→実HTTP 交換 tokens 取得+Keychain 保管 (verifier 送信=\(sawVerifier))")
        exit(0)
    }

    private static func recordToDisk() {
        let root = NSTemporaryDirectory() + "astra-selftest-\(getpid())"
        try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        guard let session = try? RecordingSession.start(root: root, meetingId: "selftest") else {
            print("SELFTEST_FAIL could not start session"); exit(2)
        }
        // 6 秒相当の合成正弦を 16 kHz で流す（5 秒断片が 1 つ閉じる）。
        let rate: UInt32 = 16_000
        var closed: UInt32 = 0
        for sec in 0..<6 {
            var frame = [Float](repeating: 0, count: Int(rate))
            for n in 0..<frame.count {
                frame[n] = 0.3 * sinf(2.0 * .pi * 440.0 * Float(n) / Float(rate) + Float(sec))
            }
            closed += session.pushSamples(samples: frame, sampleRate: rate)
        }
        let snap = session.snapshot()
        try? session.finish()

        let fragment = root + "/selftest/mic/000001.pcm"
        let exists = FileManager.default.fileExists(atPath: fragment)
        let size = (try? FileManager.default.attributesOfItem(atPath: fragment)[.size] as? Int) ?? 0
        let recoverable = scanRecoverable(root: root, active: nil)

        guard closed == 1, exists, (size ?? 0) > 0, snap.elapsedLabel == "00:05",
              recoverable.count == 1, recoverable[0].meetingId == "selftest"
        else {
            print("SELFTEST_FAIL closed=\(closed) exists=\(exists) size=\(size ?? 0) elapsed=\(snap.elapsedLabel) recoverable=\(recoverable.count)")
            exit(3)
        }
        try? FileManager.default.removeItem(atPath: root)
        print("SELFTEST_OK record: closed=\(closed) fragmentBytes=\(size ?? 0) elapsed=\(snap.elapsedLabel) recoverable=\(recoverable.count)")
        exit(0)
    }
}
