import AppKit
import Foundation

/// `--selftest surfacemotion <outDir>`: 面が姿を変える**途中**を 60fps で測る。
///
/// これまでの journey は段の前後しか撮っていない。静止画 2 枚が「同じ面」に見えても、
/// 途中で別の窓になっていたり、上辺が揺れていたり、フレームが抜けていたりすれば
/// 利用者には「別のものが載った」と映る。ここは Meeting → Notes（同じ panel の伸縮）と
/// Notes → Workspace（頼んで開く 2 枚目）を、状態を変えた瞬間から 16.7ms 刻みで見る。
///
/// 測るのは層 A だけ: 窓 id・枚数・前面・上辺・中心・抜け・間隔・寸法の連続。
/// 「同じ面に感じるか」は別の層で、ここでは **NOT_MEASURED** と明記する。
/// 撮るのは自分の窓だけ（`CGWindowListCreateImageFromArray`）。画面全体は撮らない。
@MainActor
enum SurfaceMotionGate {
    /// 1 tick ぶんの観測。
    struct Sample: Codable {
        let ms: Double
        /// Dock（statusBar level の panel）の窓 id と枠。screen 座標、Y は上辺（CG 座標）。
        let dockId: UInt32?
        let dockX: Double?, dockTop: Double?, dockW: Double?, dockH: Double?
        /// 2 枚目（Workspace）の id・枠・不透明度。無ければ nil。
        let otherId: UInt32?
        let otherX: Double?, otherTop: Double?, otherW: Double?, otherH: Double?, otherAlpha: Double?
        /// 同じ窓を AppKit 側から見た alpha（window server の値と食い違えば測定器の側の問題）。
        let otherNSAlpha: Double?
        /// 自分の窓の枚数（画面に出ているもの）。
        let windows: Int
        let front: String?
        let key: UInt32?
        /// 直前のフレームとの画素差（0–255 の平均）。最初は nil。
        var contentDelta: Double?
        let captured: Bool
    }

    struct Transition: Codable {
        let name: String
        let expectedWindows: Int
        var samples: [Sample] = []
        // 集計（層 A）
        var frames = 0
        var capturedFrames = 0
        var effectiveFps = 0.0
        var maxGapMs = 0.0
        var sameDockIdPct = 0.0
        var unexpectedWindows = 0
        var focusTheft = 0
        var topDriftPt = 0.0
        var centerDriftPt = 0.0
        var missingSurfaceFrames = 0
        /// 高さの逆行（伸びている途中で縮んだ回数）。
        var heightReversals = 0
        /// 1 フレームで動いた高さの最大（全変化量に対する割合）。1.0 なら一瞬で飛んでいる。
        var maxHeightStepRatio = 0.0
        var maxContentDelta = 0.0
        /// 2 枚目: 出ている間に枠が動いた量と、不透明度の逆行。
        var otherLayoutShiftPt = 0.0
        var otherAlphaReversals = 0
        var settledMs = 0
        var verdict: [String] = []
    }

    struct Result: Codable {
        let product = "Genie"
        let startedAt: String
        let targetFps = 60
        var transitions: [Transition] = []
        var notMeasured: [String] = []
        /// 測れない項目ではなく、別の層で測っているものの所在。
        var observations: [String] = []
        var pass = false
    }

    private static func settle(_ s: Double) {
        let until = Date().addingTimeInterval(s)
        while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.01, true) }
    }

    private struct Win { let id: UInt32; let x, top, w, h, alpha: Double; let layer: Int }

    /// 画面に出ている自分の窓。CG 座標（原点が左上、Y は上辺）。
    private static func ownWindows() -> [Win] {
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return infos.compactMap { info in
            guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                  let num = info[kCGWindowNumber as String] as? UInt32,
                  let b = info[kCGWindowBounds as String] as? [String: Any],
                  let x = b["X"] as? Double, let y = b["Y"] as? Double,
                  let w = b["Width"] as? Double, let h = b["Height"] as? Double,
                  w > 20, h > 10 else { return nil }
            let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
            let layer = info[kCGWindowLayer as String] as? Int ?? 0
            return Win(id: num, x: x, top: y, w: w, h: h, alpha: alpha, layer: layer)
        }
    }

    private struct Shot { let win: Win; let image: CGImage }

    /// 自分の窓だけを 1 枚ずつ撮る。他アプリの中身は入らない。
    private static func capture(_ wins: [Win]) -> [Shot] {
        wins.compactMap { win in
            CGWindowListCreateImage(.null, .optionIncludingWindow, win.id, [.boundsIgnoreFraming, .nominalResolution])
                .map { Shot(win: win, image: $0) }
        }
    }

    /// 画面上の位置関係のまま 1 枚に合成する（`CGWindowListCreateImageFromArray` は Swift から呼べない）。
    private static func composite(_ shots: [Shot], rect: CGRect) -> CGImage? {
        let w = Int(rect.width.rounded(.up)), h = Int(rect.height.rounded(.up))
        guard w > 0, h > 0,
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        for shot in shots.sorted(by: { $0.win.layer < $1.win.layer }) {
            let win = shot.win
            // CG 座標（上が原点）→ bitmap 座標（下が原点）。
            ctx.draw(shot.image, in: CGRect(x: win.x - rect.minX, y: rect.maxY - (win.top + win.h), width: win.w, height: win.h))
        }
        return ctx.makeImage()
    }

    private struct Gray { let w: Int; let h: Int; let px: [UInt8] }

    /// 灰色に落として 1/4 に縮める。row 0 が画像の上辺。
    private static func gray(_ img: CGImage) -> Gray? {
        let w = max(1, img.width / 4), h = max(1, img.height / 4)
        var buf = [UInt8](repeating: 0, count: w * h)
        guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return nil }
        ctx.interpolationQuality = .low
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return Gray(w: w, h: h, px: buf)
    }

    /// 上辺・左辺を揃えた重なりで画素差を取る。伸びている途中の frame でも、
    /// 元からあった部分が動いていないかをこれで見る。
    private static func meanAbsDiff(_ a: Gray?, _ b: Gray?) -> Double? {
        guard let a, let b else { return nil }
        let w = min(a.w, b.w), h = min(a.h, b.h)
        guard w > 0, h > 0 else { return nil }
        var sum = 0
        for y in 0..<h { for x in 0..<w { sum += abs(Int(a.px[y * a.w + x]) - Int(b.px[y * b.w + x])) } }
        return Double(sum) / Double(w * h)
    }

    /// 状態を変えてから `durationMs` の間、60fps で観測して frame を書き出す。
    private static func observe(_ name: String, expectedWindows: Int, outDir: String,
                                durationMs: Double = 700, _ run: () -> Void) -> Transition {
        var tr = Transition(name: name, expectedWindows: expectedWindows)
        let dir = "\(outDir)/\(name)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        // 基準: 変える前の Dock と前面。
        let before = ownWindows()
        let dock0 = before.max(by: { $0.layer < $1.layer })   // statusBar level がいちばん上
        let front0 = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let baseIds = Set(before.map(\.id))

        var shots: [(sample: Int, tick: Int, shots: [Shot], rect: CGRect)] = []
        let period = 1.0 / 60.0
        let t0 = Date()
        var lastTick = t0
        run()
        var i = 0
        while Date().timeIntervalSince(t0) < durationMs / 1000 {
            // 次の tick まで run loop を回す（描画を進めるため、寝ない）。撮影が重くて遅れていても
            // 最低 1 回は回す。回さないと AppKit のアニメーション timer が止まり、値が飛んで見える
            // （測定器が製品の欠陥を作ってしまう）。
            let due = t0.addingTimeInterval(Double(i) * period)
            repeat { CFRunLoopRunInMode(.defaultMode, 0.001, true) } while Date() < due
            let now = Date()
            tr.maxGapMs = max(tr.maxGapMs, now.timeIntervalSince(lastTick) * 1000)
            lastTick = now

            let wins = ownWindows()
            let dock = wins.first { $0.id == dock0?.id } ?? wins.max(by: { $0.layer < $1.layer })
            let other = wins.first { $0.id != dock?.id && !baseIds.contains($0.id) }
                ?? wins.first { $0.id != dock?.id && $0.w >= 600 }
            let nsAlpha = other.flatMap { o in NSApp.windows.first { $0.windowNumber == Int(o.id) }?.alphaValue }
            // 撮るだけ。合成と画素差はループの外（中でやると 60fps が保てない）。
            var rect = CGRect.null
            for w in wins { rect = rect.union(CGRect(x: w.x, y: w.top, width: w.w, height: w.h)) }
            let taken = capture(wins)
            if !taken.isEmpty { shots.append((tr.samples.count, i, taken, rect)) }
            tr.samples.append(Sample(
                ms: now.timeIntervalSince(t0) * 1000,
                dockId: dock?.id, dockX: dock?.x, dockTop: dock?.top, dockW: dock?.w, dockH: dock?.h,
                otherId: other?.id, otherX: other?.x, otherTop: other?.top, otherW: other?.w,
                otherH: other?.h, otherAlpha: other?.alpha, otherNSAlpha: nsAlpha.map(Double.init),
                windows: wins.count,
                front: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
                key: NSApp.keyWindow.map { UInt32($0.windowNumber) },
                contentDelta: nil, captured: !taken.isEmpty))
            // 遅れた分の tick は詰めて撮らない（抜けとして maxGap に残る）。
            i = max(i + 1, Int(Date().timeIntervalSince(t0) / period) + 1)
        }

        // 合成・画素差・書き出し。
        var lastGray: Gray? = nil
        var byIndex: [Int: Double] = [:]
        for entry in shots {
            guard let img = composite(entry.shots, rect: entry.rect) else { continue }
            let g = gray(img)
            if let d = meanAbsDiff(lastGray, g) { byIndex[entry.sample] = d }
            lastGray = g
            // ファイル名は tick 番号（16.7ms 刻み）。番号が飛んでいる所が撮れなかった tick。
            if let png = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: String(format: "%@/f%03d.png", dir, entry.tick)))
            }
        }
        for k in tr.samples.indices { tr.samples[k].contentDelta = byIndex[k] }

        // 集計。
        let s = tr.samples
        tr.frames = s.count
        tr.capturedFrames = s.filter(\.captured).count
        let span = (s.last?.ms ?? 0) / 1000
        tr.effectiveFps = span > 0 ? Double(tr.capturedFrames - 1) / span : 0
        let withDock = s.filter { $0.dockId != nil }
        tr.sameDockIdPct = s.isEmpty ? 0 : 100.0 * Double(withDock.filter { $0.dockId == dock0?.id }.count) / Double(s.count)
        tr.missingSurfaceFrames = s.filter { $0.dockId == nil || !$0.captured }.count
        tr.unexpectedWindows = max(0, (s.map(\.windows).max() ?? 0) - expectedWindows)
        tr.focusTheft = s.filter { $0.front != front0 }.count > 0 ? 1 : 0
        if let d0 = dock0 {
            tr.topDriftPt = withDock.map { abs(($0.dockTop ?? d0.top) - d0.top) }.max() ?? 0
            let c0 = d0.x + d0.w / 2
            tr.centerDriftPt = withDock.map { abs((($0.dockX ?? 0) + ($0.dockW ?? 0) / 2) - c0) }.max() ?? 0
        }
        let heights = withDock.compactMap(\.dockH)
        if heights.count > 1 {
            let total = abs((heights.last ?? 0) - (heights.first ?? 0))
            let dir = (heights.last ?? 0) >= (heights.first ?? 0) ? 1.0 : -1.0
            for k in 1..<heights.count {
                let step = heights[k] - heights[k - 1]
                if step * dir < -0.5 { tr.heightReversals += 1 }
                if total > 0 { tr.maxHeightStepRatio = max(tr.maxHeightStepRatio, abs(step) / total) }
            }
            // 落ち着いた時刻: 最後に高さが変わった sample。
            if let lastChange = Array(zip(withDock.dropFirst(), withDock)).last(where: { abs(($0.dockH ?? 0) - ($1.dockH ?? 0)) > 0.5 }) {
                tr.settledMs = Int(lastChange.0.ms)
            }
        }
        tr.maxContentDelta = s.compactMap(\.contentDelta).max() ?? 0
        let others = s.filter { $0.otherId != nil }
        if let o0 = others.first {
            tr.otherLayoutShiftPt = others.map {
                max(abs(($0.otherX ?? 0) - (o0.otherX ?? 0)), abs(($0.otherTop ?? 0) - (o0.otherTop ?? 0)),
                    abs(($0.otherW ?? 0) - (o0.otherW ?? 0)), abs(($0.otherH ?? 0) - (o0.otherH ?? 0)))
            }.max() ?? 0
            let alphas = others.compactMap(\.otherAlpha)
            for k in 1..<max(1, alphas.count) where alphas[k] < alphas[k - 1] - 0.01 { tr.otherAlphaReversals += 1 }
            if let lastA = Array(zip(others.dropFirst(), others)).last(where: { abs(($0.otherAlpha ?? 0) - ($1.otherAlpha ?? 0)) > 0.01 }) {
                tr.settledMs = max(tr.settledMs, Int(lastA.0.ms))
            }
        }

        // 判定（層 A のみ）。
        if tr.sameDockIdPct < 100 { tr.verdict.append("Dock の窓 id が途中で変わった (\(Int(tr.sameDockIdPct))%)") }
        if tr.unexpectedWindows > 0 { tr.verdict.append("宣言していない窓が \(tr.unexpectedWindows) 枚増えた") }
        if tr.focusTheft > 0 { tr.verdict.append("前面のアプリが変わった") }
        if tr.topDriftPt > 2 { tr.verdict.append(String(format: "上辺が %.1fpt 動いた", tr.topDriftPt)) }
        if tr.centerDriftPt > 2 { tr.verdict.append(String(format: "中心が %.1fpt 動いた", tr.centerDriftPt)) }
        if tr.missingSurfaceFrames > 0 { tr.verdict.append("面が撮れなかった frame が \(tr.missingSurfaceFrames)") }
        if tr.heightReversals > 0 { tr.verdict.append("高さが \(tr.heightReversals) 回逆行した") }
        if tr.otherLayoutShiftPt > 0.5 { tr.verdict.append(String(format: "2 枚目の枠が出ている途中で %.1fpt 動いた", tr.otherLayoutShiftPt)) }
        if tr.otherAlphaReversals > 0 { tr.verdict.append("2 枚目の不透明度が逆行した") }
        return tr
    }

    static func run(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-surface-motion"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        // 本番と同じ音の経路（journey と同じ理由: 無音の異常表示を測らない）。
        RecordingRuntime.shared.markListening(.localUser)
        RecordingRuntime.shared.markListening(.remoteAudio)
        _ = LocalStore.shared.open()
        MeetingSessionStore.shared.load()

        let f = ISO8601DateFormatter()
        var result = Result(startedAt: f.string(from: Date()))
        let recording = RecordingWorkspaceState.shared

        WindowCoordinator.shared.showVoiceHUD(); settle(0.6)

        // ⓪ Idle → Preparing → Listening: ⌥Space の直後。面は先に出て、見出しは最初の音声フレームまで
        //    「準備中…」。実マイクを開く（本番と同じ経路）。窓は 1 枚のまま、上辺は動かない。
        let t0 = observe("T0-idle-to-listening", expectedWindows: 1, outDir: outDir) {
            VoiceHUDState.shared.beginDictation()
        }
        result.transitions.append(t0)
        settle(0.4)
        VoiceHUDState.shared.cancelListening(); settle(0.5)

        // ③ Dock → Running: 頼んだ直後、同じ面が実行中の姿へ**下に**伸びる（幅は変えない）。
        let t3 = observe("T3-dock-to-running", expectedWindows: 1, outDir: outDir) {
            GenieStateStore.shared.startTask(AgentTask(
                id: UUID(), title: "週次ブリーフィングを作る", status: .running,
                steps: [
                    AgentStep(title: "Calendar", tool: "calendar", detail: "明日 10:00 / 田中さん", state: .success),
                    AgentStep(title: "Gmail", tool: "gmail", detail: "直近 12 通を読んだ", state: .success),
                    AgentStep(title: "Notion", tool: "notion", detail: "Q3 Proposal を読んでいます", state: .running),
                    AgentStep(title: "Web", tool: "web", detail: "先方の最新情報を調べる"),
                    AgentStep(title: "Briefing", tool: "agent", detail: "資料をまとめる"),
                ],
                startedAt: Date(), context: GenieStateStore.shared.state.context))
        }
        result.transitions.append(t3)
        settle(0.4)

        // ④ Running → Confirmation: 外へ出る直前、同じ面が決断の姿になる。
        let t4 = observe("T4-running-to-confirmation", expectedWindows: 1, outDir: outDir) {
            GenieStateStore.shared.requireConfirmation(ActionConfirmation(
                app: "Slack", appIcon: "number",
                title: "このメッセージを送りますか？",
                params: [.init(label: "宛先", value: "#sales"),
                         .init(label: "差出人", value: "あなた", editable: false)],
                preview: "明日の会議、資料を先に共有します。10 月の導入時期の件も入れておきました。",
                source: .init(title: "週次同期", speaker: "田中", time: "10:42"),
                details: [], risk: .r2, confirmLabel: Facts.confirmationConfirmExample))
        }
        result.transitions.append(t4)
        settle(0.4)
        GenieStateStore.shared.resolveConfirmation(approved: false)
        GenieStateStore.shared.finishTask(.success)
        GenieStateStore.shared.dismissResult()
        settle(0.5)

        // Motion sampling is a window-continuity check; use the disk-only
        // recording path so a raw debug executable does not invoke macOS TCC.
        recording.start(captureMic: false, transcribe: false, requestPermissions: false); settle(0.8)
        guard MeetingSessionStore.shared.live != nil else {
            print("SELFTEST_FAIL surfacemotion: 録音が始まっていない"); SelfTest.exit(2)
        }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            result.notMeasured.append("Reduce Motion が有効なので遷移は一瞬（アニメーションは測れない）")
        }

        // ① Meeting → Notes: 同じ panel が下へ伸びる。窓は 1 枚のまま。
        let t1 = observe("T1-meeting-to-notes", expectedWindows: 1, outDir: outDir) {
            VoiceHUDState.shared.toggleMeetingPanel(.notes)
        }
        result.transitions.append(t1)
        settle(0.4)

        // ② Notes → Workspace: 頼んだ 2 枚目。Dock は動かず、2 枚目は枠を固定したまま現れる。
        let t2 = observe("T2-notes-to-workspace", expectedWindows: 2, outDir: outDir) {
            WindowCoordinator.shared.detachMeetingSurface()
        }
        result.transitions.append(t2)
        settle(0.4)
        recording.stop(); settle(0.5)

        // 「同じ面に感じるか」はこの selftest（層 A）では測れない。層 B の盲検
        // （fixture 検証を通した判定者、`journeys/perceived/`）で測る。ここでは場所だけ示す。
        result.observations.append("PERCEIVED_SURFACE_CONTINUITY: この selftest は層 A だけ。層 B の盲検は docs/ux-benchmark/journeys/perceived/answers/aggregate.md")
        // 60fps に届かないのは測定器の都合。製品の失敗にはしない（別に記す）。
        for t in result.transitions where t.effectiveFps < 50 {
            result.notMeasured.append(String(format: "%@: 実効 %.0ffps（60 に届かない。frame pacing は参考値）", t.name, t.effectiveFps))
        }
        result.pass = result.transitions.allSatisfy { $0.verdict.isEmpty }

        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(result) {
            try? data.write(to: URL(fileURLWithPath: "\(outDir)/result.json"))
        }
        for t in result.transitions {
            print(String(format: "  MOTION %@ frames=%d captured=%d fps=%.0f maxGap=%.0fms sameId=%.0f%% windows+%d focusTheft=%d top=%.1fpt center=%.1fpt missing=%d heightRev=%d maxStep=%.2f contentΔmax=%.1f other(shift=%.1fpt alphaRev=%d) settled=%dms",
                         t.name, t.frames, t.capturedFrames, t.effectiveFps, t.maxGapMs, t.sameDockIdPct,
                         t.unexpectedWindows, t.focusTheft, t.topDriftPt, t.centerDriftPt, t.missingSurfaceFrames,
                         t.heightReversals, t.maxHeightStepRatio, t.maxContentDelta, t.otherLayoutShiftPt,
                         t.otherAlphaReversals, t.settledMs))
            for v in t.verdict { print("    ^ \(v)") }
        }
        for n in result.notMeasured { print("  NOT_MEASURED \(n)") }
        for o in result.observations { print("  SEE \(o)") }
        print("SURFACE_CONTINUITY_MOTION=\(result.pass ? "PASS" : "FAIL")")
        print("PERCEIVED_SURFACE_CONTINUITY=LAYER_B（この selftest では測らない。判定は journeys/perceived/answers/aggregate.md）")
        if result.pass {
            print("SELFTEST_OK surfacemotion: \(result.transitions.count) 遷移とも同じ窓 id・上辺と中心は 2pt 以内・抜け 0（60fps window-only）")
            SelfTest.exit(0)
        } else {
            print("SELFTEST_FAIL surfacemotion: \(result.transitions.flatMap(\.verdict).joined(separator: ", "))")
            SelfTest.exit(2)
        }
    }
}
