import AppKit

private enum Mode: String, Sendable { case legacy, scheduled, direct, signal }

private func record(_ value: String) {
    FileHandle.standardError.write(Data((value + "\n").utf8))
}

@MainActor
private final class Delegate: NSObject, NSApplicationDelegate {
    let mode: Mode
    var source: DispatchSourceSignal?

    init(mode: Mode) { self.mode = mode }

    func applicationDidFinishLaunching(_ notification: Notification) {
        record("launched")
        if mode == .signal {
            // Matches the app's caught (not ignored) signal disposition. The
            // fixture signals only itself, after its event source is running.
            Darwin.signal(SIGTERM, { _ in })
            let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            source.setEventHandler {
                record("signal-received")
                TerminationDispatch.perform { NSApp.terminate(nil) }
                record("dispatch-returned")
            }
            source.resume()
            self.source = source
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
                kill(getpid(), SIGTERM)
            }
        } else {
            DispatchQueue.main.async { [self] in
                record("dispatch-entered")
                if mode == .scheduled {
                    TerminationDispatch.perform { NSApp.terminate(nil) }
                } else {
                    NSApp.terminate(nil)
                }
                record("dispatch-returned")
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        record("should-terminate")
        if mode == .legacy {
            // Regression control: this was the production deadlock. Its caller
            // remains in a main-dispatch callback while AppKit runs a nested loop.
            Task { @MainActor in
                record("cleanup-started")
                sender.reply(toApplicationShouldTerminate: true)
            }
        } else {
            let needsMainActor = mode != .direct
            TerminationDispatch.afterCleanup({
                record("cleanup-started")
                if needsMainActor {
                    await MainActor.run { record("cleanup-mainactor") }
                }
                try? await Task.sleep(nanoseconds: 20_000_000)
                record("cleanup-finished")
            }, reply: {
                record("reply")
                sender.reply(toApplicationShouldTerminate: true)
            })
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        record("will-terminate")
    }
}

@main
private enum Harness {
    @MainActor static func main() {
        guard CommandLine.arguments.count == 2,
              let mode = Mode(rawValue: CommandLine.arguments[1]) else { exit(64) }
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let delegate = Delegate(mode: mode)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
        // A successful AppKit termination exits from NSApplication itself.
        exit(65)
    }
}
