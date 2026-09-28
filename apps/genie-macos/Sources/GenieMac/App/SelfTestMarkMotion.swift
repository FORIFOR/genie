import AppKit

/// `--selftest markmotion`（`GENIE_ANIMATE_IN_SELFTEST=1` で起動）: 印が本当に動くか・待機では動かないか。
///
/// 撮影の検査（dock8）は時間を止めるので、動きは写らない。ここでは実際の Dock の窓を 50ms ごとに撮り、
/// 印の場所（左上）と下辺（作業中の流れ）の画素が、聞く・作業中には変わり、待機では変わらないことを見る。
extension SelfTest {
    @MainActor
    static func markMotion() async {
        NSApp.setActivationPolicy(.accessory)
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        guard !GeniePresenceMotion.frozen else {
            print("SELFTEST_FAIL markmotion: GENIE_ANIMATE_IN_SELFTEST=1 で起動していない（時間が止まっている）"); exit(2)
        }
        let hud = VoiceHUDState.shared
        let store = GenieStateStore.shared
        store.reset()
        WindowCoordinator.shared.showVoiceHUD()
        await pause(1.0)

        /// 窓の中の矩形（左上原点、pt=px）の画素を、フレームごとに比べて「変わったフレームの数」を返す。
        func frames(_ name: String, count: Int = 30, region: (NSRect) -> NSRect, feed: ((Int) -> Void)? = nil) async -> (changed: Int, total: Int) {
            // 250ms 前のフレームと比べる（作業中の流れは 2.6 秒で一巡するので、50ms では 1 画素の差が小さい）。
            var history: [[UInt8]] = []
            var changed = 0
            for i in 0..<count {
                feed?(i)
                await pause(0.05)
                guard let (id, _, _) = SelfTest.dockWindow(),
                      let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .nominalResolution]) else { continue }
                let r = region(NSRect(x: 0, y: 0, width: cg.width, height: cg.height)).integral
                guard let crop = cg.cropping(to: r) else { continue }
                let rep = NSBitmapImageRep(cgImage: crop)
                var px: [UInt8] = []
                for y in stride(from: 0, to: rep.pixelsHigh, by: 1) {
                    for x in stride(from: 0, to: rep.pixelsWide, by: 1) {
                        let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB)
                        px.append(UInt8(((c?.blueComponent ?? 0) * 255).rounded()))
                        px.append(UInt8(((c?.greenComponent ?? 0) * 255).rounded()))
                    }
                }
                if history.count >= 5, let past = Optional(history[history.count - 5]), past.count == px.count {
                    let diff = zip(past, px).filter { abs(Int($0) - Int($1)) > 12 }.count
                    if diff > 3 { changed += 1 }
                }
                history.append(px)
            }
            return (changed, max(0, count - 5))
        }
        // 印は Dock の左上（上の余白 + 行の中）。窓の上端には safe-top ぶんの余白がある。
        let inset = WindowCoordinator.shared.dockTopInset
        let markRegion: (NSRect) -> NSRect = { w in NSRect(x: 0, y: inset, width: min(90, w.width), height: min(70, w.height - inset)) }
        let bottomRegion: (NSRect) -> NSRect = { w in NSRect(x: 0, y: w.height - 6, width: w.width, height: 6) }

        // 聞く（入力の大きさを揺らす）
        hud.presentConversationForShot(ending: false)
        await pause(0.6)
        let levels: [Float] = [0.02, 0.2, 0.05, 0.3, 0.1, 0.25, 0.03, 0.18]
        let listening = await frames("listening", region: markRegion) { i in hud.receiveInputLevel(levels[i % levels.count]) }
        hud.clearConversationForShot(); hud.mode = .idle
        await pause(0.8)

        // 作業中（本物の仕事を 1 件走らせる）
        let task = AgentTask(id: UUID(), title: "動きの検査", status: .running,
                             steps: [AgentStep(title: "読む", tool: "agent", detail: "読んでいます", state: .running)],
                             startedAt: Date(), context: ContextBundle())
        store.startTask(task)
        await pause(0.8)
        for k in 0..<2 {   // 目で確かめる用に 2 枚（0.6 秒あけて）
            if let (id, _, _) = SelfTest.dockWindow(),
               let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .nominalResolution]),
               let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: NSTemporaryDirectory() + "markmotion-working-\(k).png"))
            }
            await pause(0.6)
        }
        let working = await frames("working", region: markRegion)
        let flow = await frames("flow", region: bottomRegion)
        store.stopTask()
        store.dismissResult()
        await pause(1.0)

        // 待機（何も動かない＝連続描画しない）
        let idle = await frames("idle", region: markRegion)

        let report = "聞く=\(listening.changed)/\(listening.total) 作業中の印=\(working.changed)/\(working.total) 下辺の流れ=\(flow.changed)/\(flow.total) 待機=\(idle.changed)/\(idle.total)"
        let ok = listening.changed >= 5 && working.changed >= 5 && flow.changed >= 5 && idle.changed == 0
        print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " markmotion: " + report)
        exit(ok ? 0 : 2)
    }
}
