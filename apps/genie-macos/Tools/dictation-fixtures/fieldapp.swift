import AppKit
// 検査用の入力欄だけのアプリ。欄の中身が変わるたびにファイルへ書く（Genie の音声入力の着地点）。
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/fieldapp.txt"
final class D: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    var window: NSWindow!
    let field = NSTextField(frame: NSRect(x: 20, y: 20, width: 460, height: 28))
    func applicationDidFinishLaunching(_ n: Notification) {
        window = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 500, height: 70), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Genie 音声入力の検査"
        field.delegate = self
        window.contentView?.addSubview(field)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(field)
        NSApp.activate(ignoringOtherApps: true)
        Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
            try? self.field.stringValue.write(toFile: out, atomically: true, encoding: .utf8)
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let d = D(); app.delegate = d
app.run()
