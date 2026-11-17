import AppKit
import SwiftUI

extension SelfTest {
    /// Own-window fixtures only: no OS grant requests, backend, recording or OS UI automation.
    @MainActor static func permissionCapabilities(_ args: [String]) async {
        guard let i = args.firstIndex(of: "--selftest"), args.count > i + 2 else {
            print("SELFTEST_FAIL permission-capabilities: output directory required"); exit(2)
        }
        let output = URL(fileURLWithPath: args[i + 2])
        try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let applicationURL = args.count > i + 3 ? URL(fileURLWithPath: args[i + 3]) : Bundle.main.bundleURL
        guard let application = GuideApplication(url: applicationURL) else {
            print("SELFTEST_FAIL permission-capabilities: existing application bundle required"); exit(2)
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
            let extra = NSHostingView(rootView: settingsFixture(showAdditionalPermissions: true).environment(\.colorScheme, dark ? .dark : .light))
            window.contentView = extra; window.setContentSize(extra.fittingSize)
            await capture("settings-additional-" + suffix, host: extra, window: window)
            window.orderOut(nil); window.close()

            let overlay = AvatarOverlayController()
            guard let screen = NSScreen.main else { failures.append("no screen"); continue }
            for permission in GuidePermission.capabilityOrder {
                overlay.show(on: screen, state: .guiding, message: permission.explanation, onClose: {})
                overlay.model.explanationLabel = "macOS：" + permission.systemPermissionName
                overlay.model.secondaryAction = .init(title: "あとで", run: {})
                overlay.update(state: .guiding, message: permission.explanation,
                               action: .init(title: permission.enableTitle, run: {}))
                if let panel = overlay.window, let host = panel.contentView {
                    await capture("why-" + permission.rawValue + "-" + suffix, host: host, window: panel)
                }
            }
            overlay.show(on: screen, state: .guiding, message: PermissionGuideCoordinator.messageAccessibility, onClose: {})
            overlay.model.applicationToAdd = application
            overlay.update(state: .guiding, message: PermissionGuideCoordinator.messageAccessibility,
                           action: .init(title: PermissionGuideCoordinator.actionOpenSettings, run: {}))
            if let panel = overlay.window, let host = panel.contentView {
                await capture("waiting-" + suffix, host: host, window: panel)
            }
            overlay.model.showsApplicationHelp = true
            overlay.relayout(on: screen)
            if let panel = overlay.window, let host = panel.contentView {
                await capture("missing-application-" + suffix, host: host, window: panel)
            }
            overlay.model.applicationToAdd = nil
            overlay.model.secondaryAction = .init(title: "あとで", run: {})
            overlay.update(state: .success, message: GuidePermission.accessibility.readyMessage,
                           action: .init(title: "試してみる", run: {}))
            if let panel = overlay.window, let host = panel.contentView {
                await capture("ready-" + suffix, host: host, window: panel)
            }
            overlay.hide()
            let home = NSHostingView(rootView: HomeView(greeting: "こんにちは").environment(\.colorScheme, dark ? .dark : .light))
            let homeWindow = NSWindow(contentRect: CGRect(x: 120, y: 140, width: 980, height: 800),
                                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
            homeWindow.isReleasedWhenClosed = false; homeWindow.animationBehavior = .none
            homeWindow.contentView = home; homeWindow.makeKeyAndOrderFront(nil)
            await capture("home-" + suffix, host: home, window: homeWindow)
            homeWindow.orderOut(nil); homeWindow.close()
            for scene in ["screen-result", "screen-reading", "control"] {
                let model = PermissionPractice()
                let sample = NSImage(size: NSSize(width: 400, height: 160), flipped: false) { rect in
                    NSColor.windowBackgroundColor.setFill(); rect.fill()
                    let copy = "チーム定例\n10:00 デザインの確認\n14:00 リリース準備"
                    (copy as NSString).draw(at: NSPoint(x: 24, y: 44), withAttributes: [
                        .font: NSFont.systemFont(ofSize: 18), .foregroundColor: NSColor.labelColor])
                    return true
                }
                model.configureForShot(scene == "control" ? .accessibility : .screenCapture,
                                       image: scene == "screen-result" ? sample : nil, reading: scene == "screen-reading")
                let host = NSHostingView(rootView: PermissionPracticeView(model: model).environment(\.colorScheme, dark ? .dark : .light))
                let win = NSWindow(contentRect: CGRect(x: 120, y: 140, width: 460, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
                win.isReleasedWhenClosed = false; win.animationBehavior = .none
                win.title = model.permission.capabilityTitle
                win.contentView = host; win.setContentSize(host.fittingSize)
                win.makeKeyAndOrderFront(nil)
                await capture("practice-" + scene + "-" + suffix, host: host, window: win)
                win.orderOut(nil); win.close()
            }
        }
        try? JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("geometry.json"))
        print(failures.isEmpty ? "SELFTEST_OK permission-capabilities: 26 native captures; light/dark; state transitions simulated; no OS permissions changed" : "SELFTEST_FAIL permission-capabilities: \(failures)")
        exit(failures.isEmpty ? 0 : 1)
    }
}
