// Disposable local target. Never reads user files or uses the network.
import AppKit

final class Demo: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var label: NSTextField!
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 640, height: 400),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Genie Computer Use Test"
        let view = NSView(frame: window.contentView!.bounds)
        let title = NSTextField(labelWithString: "Computer Use — local test")
        title.font = .systemFont(ofSize: 25, weight: .semibold)
        title.frame = NSRect(x: 40, y: 310, width: 550, height: 40)
        view.addSubview(title)
        let info = NSTextField(labelWithString: "This test app has no network, account or private documents.")
        info.frame = NSRect(x: 40, y: 265, width: 570, height: 30)
        view.addSubview(info)
        let button = NSButton(title: "Show details", target: self, action: #selector(showDetails))
        button.bezelStyle = .rounded
        button.frame = NSRect(x: 40, y: 190, width: 220, height: 50)
        view.addSubview(button)
        label = NSTextField(labelWithString: "Details are closed")
        label.font = .systemFont(ofSize: 22)
        label.frame = NSRect(x: 40, y: 100, width: 550, height: 55)
        view.addSubview(label)
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func showDetails() {
        label.stringValue = "Details open — LOCAL TEST PASSED"
        // Independent structured readback of the actual native button callback.
        if let path = ProcessInfo.processInfo.environment["GENIE_TEST_RESULT"] {
            try? Data("{\"detailsOpen\":true}\n".utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }
}
let app = NSApplication.shared
let delegate = Demo()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
