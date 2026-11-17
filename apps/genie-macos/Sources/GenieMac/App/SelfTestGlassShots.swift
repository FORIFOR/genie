import AppKit

/// `--selftest glassshots <dir>`: 外殻の素材（Liquid Glass）を、**背後ごと**撮る。
///
/// dock8 は Dock の窓だけを撮るので、ガラスが背後の何を透かしているかが写らない。
/// ここでは Dock の真下に明るい・暗い・込み入った地の窓を敷き、画面のその範囲を撮る
/// （利用者が見るのと同じ合成）。各面で、文字の読みやすさの目安として
/// 面の中心付近の明るさ（0–255）も書き出す。
extension SelfTest {
    @MainActor
    static func glassShots(_ args: [String]) async {
        NSApp.setActivationPolicy(.accessory)
        let outDir = args.first { !$0.hasPrefix("-") } ?? NSTemporaryDirectory() + "genie-glass"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }

        let store = GenieStateStore.shared
        let hud = VoiceHUDState.shared
        store.reset()
        WindowCoordinator.shared.showVoiceHUD()
        await pause(0.8)
        guard let panel = WindowCoordinator.shared.hudPanelForTest, let screen = panel.screen ?? NSScreen.main else {
            print("SELFTEST_FAIL glassshots: Dock の窓が無い"); exit(2)
        }

        // 地の窓。Dock のすぐ下の段に置き、Dock が伸び縮みしても覆えるよう画面上部を広く取る。
        let backdropFrame = NSRect(x: screen.frame.midX - 560, y: screen.frame.maxY - 820, width: 1120, height: 820)
        let backdrop = NSWindow(contentRect: backdropFrame, styleMask: .borderless, backing: .buffered, defer: false)
        backdrop.level = NSWindow.Level(rawValue: panel.level.rawValue - 1)
        backdrop.isReleasedWhenClosed = false
        backdrop.ignoresMouseEvents = true
        backdrop.collectionBehavior = [.canJoinAllSpaces, .stationary]

        func busyImage() -> NSImage {
            NSImage(size: backdropFrame.size, flipped: false) { rect in
                let colors: [NSColor] = [.systemPink, .systemYellow, .systemTeal, .white, .systemIndigo, .black, .systemOrange, .systemGreen]
                var x: CGFloat = -rect.height
                var i = 0
                while x < rect.width {
                    let path = NSBezierPath()
                    path.move(to: NSPoint(x: x, y: 0)); path.line(to: NSPoint(x: x + 70, y: 0))
                    path.line(to: NSPoint(x: x + 70 + rect.height, y: rect.height)); path.line(to: NSPoint(x: x + rect.height, y: rect.height))
                    colors[i % colors.count].setFill(); path.fill()
                    x += 70; i += 1
                }
                let text = "Quarterly Review — 売上 ¥12,400,000 · 田中さんへ返信 · Figma Genie UI Atlas"
                for row in stride(from: 20.0, to: rect.height, by: 46.0) {
                    (text as NSString).draw(at: NSPoint(x: 12, y: row), withAttributes: [
                        .font: NSFont.systemFont(ofSize: 22, weight: .semibold), .foregroundColor: NSColor.black])
                }
                return true
            }
        }
        let grounds: [(String, NSView)] = [
            ("light", { let v = NSView(); v.wantsLayer = true; v.layer?.backgroundColor = NSColor(white: 0.97, alpha: 1).cgColor; return v }()),
            ("dark", { let v = NSView(); v.wantsLayer = true; v.layer?.backgroundColor = NSColor(white: 0.08, alpha: 1).cgColor; return v }()),
            ("busy", { let v = NSImageView(image: busyImage()); v.imageScaling = .scaleAxesIndependently; return v }()),
        ]

        let steps = [
            AgentStep(title: "Calendar", tool: "calendar", detail: "明日 10:00 / 田中さん", state: .success),
            AgentStep(title: "Gmail", tool: "gmail", detail: "直近 12 通を読んだ", state: .success),
            AgentStep(title: "Notion", tool: "notion", detail: "Q3 Proposal を読んでいます", state: .running),
            AgentStep(title: "Briefing", tool: "agent", detail: "資料をまとめる"),
        ]
        let states: [(String, () -> Void)] = [
            ("idle", { hud.clearConversationForShot(); store.reset(); hud.mode = .idle }),
            ("conversation", {
                hud.presentConversationForShot(ending: false)
                for level: Float in [0.2, 0.5, 0.9, 0.6, 0.3, 0.8, 0.45, 0.7, 0.25, 0.55, 0.85, 0.4, 0.65, 0.35] {
                    hud.receiveInputLevel(level)
                }
            }),
            ("agent", {
                hud.clearConversationForShot()
                store.startTask(AgentTask(id: UUID(), title: "週次ブリーフィングを作る", status: .running,
                                          steps: steps, startedAt: Date(), context: store.state.context))
            }),
            ("result", { store.finishTask(.success) }),
        ]

        var report: [String] = []
        var failures: [String] = []
        let mainHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        for (groundName, view) in grounds {
            backdrop.contentView = view
            backdrop.orderFront(nil)
            for (stateName, transition) in states {
                transition()
                WindowCoordinator.shared.syncDockPanels()
                await pause(1.2)
                // 画面座標（左上原点）で、Dock の外形と周り 24pt を撮る。
                let f = panel.frame.insetBy(dx: -24, dy: -24)
                let rect = CGRect(x: f.minX, y: mainHeight - f.maxY, width: f.width, height: f.height)
                guard let cg = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.nominalResolution]) else {
                    failures.append("\(groundName)/\(stateName)=撮影不可"); continue
                }
                let rep = NSBitmapImageRep(cgImage: cg)
                if let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(groundName)-\(stateName).png"))
                }
                // 面の中（左右 1/4 の帯・上下中央）の平均の明るさ。白い文字が読めるのは暗い面。
                var sum = 0.0, n = 0.0
                let x0 = Int(Double(rep.pixelsWide) * 0.25), x1 = Int(Double(rep.pixelsWide) * 0.75)
                let y0 = Int(Double(rep.pixelsHigh) * 0.4), y1 = Int(Double(rep.pixelsHigh) * 0.6)
                for y in stride(from: y0, to: y1, by: 3) {
                    for x in stride(from: x0, to: x1, by: 3) {
                        if let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) {
                            sum += (0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent) * 255; n += 1
                        }
                    }
                }
                let luma = n > 0 ? Int(sum / n) : -1
                report.append("\(groundName)/\(stateName) luma=\(luma)")
            }
        }
        backdrop.orderOut(nil)
        let ok = failures.isEmpty
        print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " glassshots: " + (report + failures).joined(separator: " "))
        exit(ok ? 0 : 2)
    }
}
