import AppKit

/// `--selftest inputfocus`: キーボードで入力できるか。実キー・実クリックをこのプロセスへ送り、欄に入ったかを読み戻す。
///
/// 1. Dock: 「会話」を始めた直後、Dock が key になり、入力欄に文字が入るか。
/// 2. 設定: 「会話（Gemini Live）」の API キーの欄をクリックして、文字が入るか。
/// 本番と同じく Dock にアイコンを出さない（accessory）で動かす。
extension SelfTest {
    @MainActor
    static func inputFocus() async {
        NSApp.setActivationPolicy(.accessory)
        let pid = ProcessInfo.processInfo.processIdentifier
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        func type(_ keys: [CGKeyCode]) {
            let src = CGEventSource(stateID: .hidSystemState)
            for key in keys {
                guard let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true),
                      let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) else { continue }
                down.postToPid(pid); up.postToPid(pid)
            }
        }
        func click(_ point: CGPoint) {
            let src = CGEventSource(stateID: .hidSystemState)
            for type in [CGEventType.leftMouseDown, .leftMouseUp] {
                CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.postToPid(pid)
            }
        }
        /// 窓の中の文字の欄（NSTextField / 編集中の NSTextView）に入っている文字。
        func typedText(in window: NSWindow?) -> String {
            guard let window else { return "" }
            if let editor = window.firstResponder as? NSTextView { return editor.string }
            var found = ""
            func walk(_ v: NSView) {
                if let f = v as? NSTextField, f.isEditable, !f.stringValue.isEmpty { found = f.stringValue }
                v.subviews.forEach(walk)
            }
            if let root = window.contentView { walk(root) }
            return found
        }
        let a: CGKeyCode = 0, b: CGKeyCode = 11, c: CGKeyCode = 8, x: CGKeyCode = 7, y: CGKeyCode = 16, z: CGKeyCode = 6

        // 1. Dock
        WindowCoordinator.shared.showVoiceHUD()
        await pause(0.5)
        VoiceHUDState.shared.beginConversation()
        await pause(1.5)
        let panel = WindowCoordinator.shared.hudPanelForTest
        let dockKey = panel?.isKeyWindow ?? false
        type([a, b, c])
        await pause(0.8)
        let dockText = typedText(in: panel)
        VoiceHUDState.shared.endConversation(.user)
        await pause(0.5)

        // 2. 設定の API キーの欄
        SettingsWindowController.shared.show()
        await pause(1.0)
        let settings = SettingsWindowController.shared.windowForTest
        var secure: NSSecureTextField?
        func find(_ v: NSView) { if let s = v as? NSSecureTextField { secure = s }; v.subviews.forEach(find) }
        if let root = settings?.contentView { find(root) }
        var settingsText = ""
        var settingsKey = false
        if let settings, let secure {
            // 欄の真ん中をクリック（画面座標は左上原点）。
            let inWindow = secure.convert(NSPoint(x: secure.bounds.midX, y: secure.bounds.midY), to: nil)
            let onScreen = settings.convertPoint(toScreen: inWindow)
            let mainHeight = NSScreen.screens.first?.frame.height ?? 0
            click(CGPoint(x: onScreen.x, y: mainHeight - onScreen.y))
            await pause(0.5)
            settingsKey = settings.isKeyWindow
            type([x, y, z])
            await pause(0.8)
            settingsText = (settings.firstResponder as? NSTextView)?.string ?? secure.stringValue
        }
        let report = "dock(key=\(dockKey) text=\"\(dockText)\") settings(window=\(settings != nil) field=\(secure != nil) key=\(settingsKey) textLength=\(settingsText.count))"
        let dockOK = dockKey && !dockText.isEmpty
        let settingsOK = settingsKey && settingsText.count >= 3
        print((dockOK && settingsOK ? "SELFTEST_OK" : "SELFTEST_FAIL") + " inputfocus: \(report)")
        exit(dockOK && settingsOK ? 0 : 2)
    }
}
