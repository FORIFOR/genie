import AppKit

extension SelfTest {
    /// 作業面に「いま操作している画面」を出した姿（DESIGN.md §8.1）。写真は**合成**（実際の画面は撮らない）。
    @MainActor
    static func liveScreenFixture() -> (frame: LiveScreenFrame, image: NSImage) {
        let size = NSSize(width: 1280, height: 800)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.white.setFill(); NSRect(origin: .zero, size: size).fill()
        NSColor(calibratedRed: 0.86, green: 0.12, blue: 0.10, alpha: 1).setFill()
        NSRect(x: 0, y: size.height - 96, width: size.width, height: 96).fill()
        let title: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 40, weight: .semibold), .foregroundColor: NSColor.white]
        ("ご注文内容の確認（合成）" as NSString).draw(at: NSPoint(x: 48, y: size.height - 70), withAttributes: title)
        let row: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 34), .foregroundColor: NSColor.black]
        for (i, line) in ["ビッグマック × 1", "お届け: できるだけ早く", "合計（税込・配達料込み）: 未確認"].enumerated() {
            (line as NSString).draw(at: NSPoint(x: 64, y: size.height - 200 - CGFloat(i) * 90), withAttributes: row)
        }
        image.unlockFocus()
        let frame = LiveScreenFrame(imageURL: URL(fileURLWithPath: "/tmp/cv-fixture.png"),
                                    capturedAt: Date().addingTimeInterval(-2), host: "www.mcdonalds.co.jp")
        return (frame, image)
    }

    /// 作業面（段 3 つ）＋操作中の画面。occupation と liveshot が同じ姿を使う。
    @MainActor
    static func presentLiveScreenState() {
        let store = GenieStateStore.shared
        store.reset()
        LiveScreenFeed.shared.fixture = liveScreenFixture()
        store.startTask(AgentTask(
            id: UUID(), title: "マクドナルドのカートを準備（未注文）", status: .running,
            steps: [AgentStep(title: "公式サイト", tool: "checkout.open", state: .success),
                    AgentStep(title: "カート", tool: "computer.run", state: .running),
                    AgentStep(title: "確認", tool: "review")],
            startedAt: Date(), context: ContextBundle(items: [])))
    }

    /// 上限（DESIGN.md §8.1 の候補 B）: 720 x (190 + 36·3 + agentLiveHeight)。
    static var liveScreenCeiling: (CGFloat, CGFloat) {
        (Metrics.dockAgentWidth, Metrics.dockAgentHeightBase + Metrics.dockAgentRowHeight * 3 + Metrics.dockAgentLiveHeight)
    }

    /// `--selftest liveshot <dir> [dark]`: 作業面に操作中の画面を出した姿を撮り、寸法を上限と突き合わせる。
    @MainActor
    static func liveShot(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/genie-liveshot"
        let dark = args.count > i + 3 && args[i + 3] == "dark"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        func settle(_ s: Double) {
            let until = Date().addingTimeInterval(s)
            while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        }
        WindowCoordinator.shared.showVoiceHUD()
        presentLiveScreenState()
        settle(1.5)
        let key = "window:GeniePanel<VoiceTaskDockView>"
        guard let win = NSApp.windows.first(where: { $0.isVisible && "window:" + ($0.identifier?.rawValue ?? String(describing: type(of: $0))) == key }) else {
            print("SELFTEST_FAIL liveshot: Dock が出ていない"); exit(2)
        }
        let (maxW, contentMaxH) = liveScreenCeiling
        let maxH = contentMaxH + WindowCoordinator.shared.dockTopInset
        let f = win.frame
        print(String(format: "LIVESHOT dock %.0fx%.0f（上限 %.0fx%.0f）", f.width, f.height, maxW, maxH))
        guard let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(win.windowNumber),
                                               [.boundsIgnoreFraming, .bestResolution]),
              let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else {
            print("SELFTEST_FAIL liveshot: 撮れない"); exit(2)
        }
        let name = "03b-task-dock-live\(dark ? "-dark" : "").png"
        try? png.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(name))
        LiveScreenFeed.shared.fixture = nil
        GenieStateStore.shared.reset()
        if f.width > maxW + 1 || f.height > maxH + 1 {
            print("SELFTEST_FAIL liveshot: 宣言した寸法より大きい"); exit(2)
        }
        print("SELFTEST_OK liveshot \(outDir)/\(name)")
        exit(0)
    }
}
