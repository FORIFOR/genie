import AppKit
// 検査用: ターミナルのように、欄の値を外から書き換えられない（AXValue が settable でない）文字欄。
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/termapp.txt"
final class LockedTextView: NSTextView {
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if selector == #selector(NSView.setAccessibilityValue(_:)) { return false }
        if selector == #selector(NSTextView.setAccessibilitySelectedText(_:)) { return false }
        return super.isAccessibilitySelectorAllowed(selector)
    }
    override func setAccessibilityValue(_ v: Any?) {}
    override func setAccessibilitySelectedText(_ v: String?) {}
}
final class D: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let view = LockedTextView(frame: NSRect(x: 0, y: 0, width: 500, height: 120))
    func applicationDidFinishLaunching(_ n: Notification) {
        window = NSWindow(contentRect: NSRect(x: 320, y: 320, width: 500, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Genie 音声入力の検査（書き換え不可の欄）"
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
        NSApp.activate(ignoringOtherApps: true)
        Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
            try? self.view.string.write(toFile: out, atomically: true, encoding: .utf8)
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let d = D(); app.delegate = d
app.run()
