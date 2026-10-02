import AppKit
import Darwin

/// No Security API runs: only the production serialization policy and AppKit
/// termination path are exercised while a synthetic human confirmation waits.
@MainActor final class RecoveryQuitDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.global().async {
            let guarder = KeychainInteractionGuard(readAllowed: { false }, setAllowed: { _ in })
            try? guarder.perform(allowInteraction: true) {
                fputs("synthetic-read-waiting\n", stderr)
                TerminationDispatch.perform { NSApp.terminate(nil) }
                Thread.sleep(forTimeInterval: 10)
                fputs("synthetic-read-finished\n", stderr)
            }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        fputs("should-terminate\n", stderr)
        TerminationDispatch.afterCleanup({}, reply: { sender.reply(toApplicationShouldTerminate: true) })
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) { fputs("will-terminate\n", stderr) }
}

@main enum RecoveryQuitHarness {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = RecoveryQuitDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.prohibited)
        app.run()
    }
}
