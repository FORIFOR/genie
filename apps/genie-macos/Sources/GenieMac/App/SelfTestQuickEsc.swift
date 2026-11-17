import AppKit

/// `--selftest quickesc`: Dock を本物のクリックで押して Quick Actions を開き、本物の Esc で閉じられるか。
/// 閉じたら、キー入力が開く前のアプリへ戻っていること。クリックとキーは**この Genie 自身へだけ**送る。
extension SelfTest {
    @MainActor
    static func quickEsc() async {
        NSApp.setActivationPolicy(.accessory)
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        let hud = VoiceHUDState.shared
        GenieStateStore.shared.reset()
        WindowCoordinator.shared.showVoiceHUD()
        hud.mode = .idle
        await pause(1.0)
        guard let panel = WindowCoordinator.shared.hudPanelForTest else { print("SELFTEST_FAIL quickesc: Dock が無い"); exit(2) }
        let frontBefore = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"

        // 待機の Dock の左側（「Genie」の押せる所）を、画面座標（左上原点）でクリックする。
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let inset = WindowCoordinator.shared.dockTopInset
        let f = panel.frame
        let point = CGPoint(x: f.minX + 45, y: mainHeight - f.maxY + inset + (f.height - inset) / 2)
        // 窓へ直接マウスを渡す（プロセス宛ての合成イベントは、この種類の窓のボタンに届かなかった）。
        let local = NSPoint(x: 45, y: (f.height - inset) / 2)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: type, location: local, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                panel.sendEvent(e)
            }
        }
        await pause(0.8)
        let opened = hud.mode == .quickActions
        let keyWhenOpen = panel.isKeyWindow

        // Esc（キーコード 53）を、アプリの通常の経路（キーの窓へ届ける）で送る。Dock がキーでなければ届かない。
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: NSApp.keyWindow?.windowNumber ?? 0, context: nil, characters: "\u{1b}",
                                        charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
                NSApp.sendEvent(e)
            }
        }
        await pause(0.8)
        let closed = hud.mode == .idle
        let keyAfter = panel.isKeyWindow
        let frontAfter = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"

        let hitView = panel.contentView.map { v in v.hitTest(v.convert(NSPoint(x: 45, y: (f.height - inset) / 2), from: nil)).map { String(describing: type(of: $0)) } ?? "nil" } ?? "?"
        // --other-app <実行ファイル名>: キーを検査用のアプリへ移してから Esc（ほかのアプリにキーがある場面）。
        var otherApp = "（測らない）"
        if let k = CommandLine.arguments.firstIndex(of: "--other-app"), CommandLine.arguments.count > k + 1 {
            let name = CommandLine.arguments[k + 1]
            hud.toggleQuickActions()
            await pause(0.5)
            guard let fixture = NSWorkspace.shared.runningApplications.first(where: { $0.executableURL?.lastPathComponent == name }) else {
                print("SELFTEST_FAIL quickesc: 検査用のアプリ \(name) が動いていない"); exit(2)
            }
            fixture.activate()
            // 本人がほかのアプリをクリックした時と同じく、Dock はキーを持っていない状態にする。
            WindowCoordinator.shared.hudPanelForTest?.resignKey()
            await pause(0.8)
            guard WindowCoordinator.shared.hudPanelForTest?.isKeyWindow == false, NSApp.keyWindow == nil else {
                print("SELFTEST_FAIL quickesc: Dock がキーを持ったまま（ほかのアプリにキーがある場面を作れない）"); exit(2)
            }
            // 送る直前に、前面が検査用のアプリであることを確かめる（本人のアプリへ Esc を送らない）。
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == fixture.processIdentifier else {
                print("SELFTEST_FAIL quickesc: 前面が検査用のアプリにならない。Esc を送らずに止めた"); exit(2)
            }
            let before = hud.mode == .quickActions
            let src = CGEventSource(stateID: .hidSystemState)
            for down in [true, false] { CGEvent(keyboardEventSource: src, virtualKey: 53, keyDown: down)?.post(tap: .cghidEventTap) }
            await pause(0.8)
            otherApp = "開いていた=\(before) ほかのアプリにキーがあってもEscで閉じた=\(hud.mode == .idle)"
            if !(before && hud.mode == .idle) { print("SELFTEST_FAIL quickesc: \(otherApp)"); exit(2) }
        }
        let report = "ほかのアプリ: \(otherApp) 窓=\(Int(f.minX)),\(Int(f.minY)) \(Int(f.width))x\(Int(f.height)) 画面高=\(Int(mainHeight)) 押した点=\(Int(point.x)),\(Int(point.y)) hit=\(hitView) クリックで開いた=\(opened) 開いた間のキー=\(keyWhenOpen) Escで閉じた=\(closed) 閉じた後のキー=\(keyAfter) 前面: \(frontBefore)→\(frontAfter)"
        let ok = opened && keyWhenOpen && closed && !keyAfter
        print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " quickesc: " + report)
        exit(ok ? 0 : 2)
    }
}
