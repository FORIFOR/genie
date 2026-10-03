import AppKit
import SwiftUI

extension SelfTest {
    /// Own-window fixtures only: no OS grant requests, backend, recording or OS UI automation.
    @MainActor static func permissionHelp(_ args: [String]) async {
        guard let i = args.firstIndex(of: "--selftest"), args.count > i + 2 else {
            print("SELFTEST_FAIL permission-help: output directory required"); exit(2)
        }
        let output = URL(fileURLWithPath: args[i + 2])
        try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let applicationURL = args.count > i + 3 ? URL(fileURLWithPath: args[i + 3]) : Bundle.main.bundleURL
        guard let application = GuideApplication(url: applicationURL) else {
            print("SELFTEST_FAIL permission-help: existing application bundle required"); exit(2)
        }
        NSApp.setActivationPolicy(.regular)
        var geometry: [String: [String: Double]] = [:]
        var failures: [String] = []

        func capture(_ name: String, host: NSView, window: NSWindow) async {
            host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
            window.displayIfNeeded()
            try? await Task.sleep(for: .milliseconds(600))
            guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow,
                CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .nominalResolution]),
                let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                failures.append(name); return
            }
            try? data.write(to: output.appendingPathComponent(name + ".png"))
            geometry[name] = ["width": host.bounds.width, "height": host.bounds.height,
                              "windowWidth": window.frame.width, "windowHeight": window.frame.height,
                              "fittingWidth": host.fittingSize.width, "fittingHeight": host.fittingSize.height]
            if let screen = window.screen, !screen.visibleFrame.contains(window.frame) { failures.append(name + " outside screen") }
        }

        for dark in [false, true] {
            let suffix = dark ? "dark" : "light"
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            Permissions.simulatedAccessibility = .notDetermined
            Permissions.simulatedScreenRecording = .notDetermined
            Permissions.simulatedMicrophone = .denied
            Permissions.simulatedSpeechRecognition = .denied
            Permissions.simulatedInputMonitoring = .notDetermined
            Permissions.simulatedCalendar = .notDetermined
            let settings = NSHostingView(rootView: settingsFixture().environment(\.colorScheme, dark ? .dark : .light))
            let window = NSWindow(contentRect: CGRect(x: 120, y: 140, width: 460, height: 620),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.title = "Genie 設定"
            window.animationBehavior = .none
            window.contentView = settings; window.setContentSize(settings.fittingSize)
            window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            await capture("settings-pending-" + suffix, host: settings, window: window)
            // Same retained SettingsView must refresh on return from System Settings.
            Permissions.simulatedAccessibility = .granted
            NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
            await capture("settings-refreshed-" + suffix, host: settings, window: window)
            window.orderOut(nil); window.close()

            let overlay = AvatarOverlayController()
            guard let screen = NSScreen.main else { failures.append("no screen"); continue }
            overlay.show(on: screen, state: .guiding, message: PermissionGuideCoordinator.messageAccessibility, onClose: {})
            overlay.model.applicationToAdd = application
            overlay.model.showsApplicationHelp = true
            overlay.update(state: .guiding, message: PermissionGuideCoordinator.messageAccessibility,
                           action: .init(title: PermissionGuideCoordinator.actionOpenSettings, run: {}))
            if let panel = overlay.window, let host = panel.contentView {
                await capture("accessibility-guide-" + suffix, host: host, window: panel)
            } else { failures.append("guide not visible") }
            overlay.model.applicationToAdd = nil
            overlay.update(state: .success, message: PermissionGuideCoordinator.messageDone(for: .accessibility))
            if let panel = overlay.window, let host = panel.contentView {
                await capture("confirmed-" + suffix, host: host, window: panel)
            }
            overlay.hide()
        }
        try? JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("geometry.json"))
        print(failures.isEmpty ? "SELFTEST_OK permission-help: 8 native captures; light/dark; state transitions simulated; no OS permissions changed" : "SELFTEST_FAIL permission-help: \(failures)")
        exit(failures.isEmpty ? 0 : 1)
    }
}
