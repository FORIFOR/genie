import AppKit
import Foundation

@main @MainActor struct RegistrationAssistTests {
    static func main() throws {
        if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--blocked-child" {
            do {
                try RegistrationCapturePrivacy.requireUnblocked(key: CommandLine.arguments[3], directory: URL(fileURLWithPath: CommandLine.arguments[2]))
                exit(2)
            } catch let error as Failure { exit(error.code == "registration_capture_paused" ? 0 : 3) }
        }
        var count = 0
        func check(_ value: Bool) { precondition(value); count += 1 }
        func refused(_ code: String, _ operation: () throws -> Void) {
            do { try operation(); preconditionFailure("expected refusal: \(code)") }
            catch let error as Failure { check(error.code == code) }
            catch { preconditionFailure("unexpected error type") }
        }
        func field(_ subrole: String = "", label: String = "メールアドレス", empty: Bool? = true,
                   role: String = "AXTextField", enabled: Bool = true, settable: Bool = true,
                   visible: Bool = true, form: [Int]? = nil) -> RegistrationFieldPolicy.Field {
            .init(role: role, subrole: subrole, labels: [label], empty: empty,
                  enabled: enabled, settable: settable, visible: visible, form: form)
        }
        let password = field("AXSecureTextField", label: "パスワード")
        check(RegistrationCapturePrivacy.supportedBrowserBundles.contains("com.apple.Safari"))
        check(RegistrationCapturePrivacy.supportedBrowserBundles.contains("com.google.Chrome"))
        check(!RegistrationCapturePrivacy.supportedBrowserBundles.contains("com.apple.finder"))
        check(RegistrationFieldPolicy.select([field(), password])?.email == 0)
        check(RegistrationFieldPolicy.select([password, field("AXEmailField")])?.email == 1)
        check(RegistrationFieldPolicy.select([field(label: "Email address"), password]) != nil)
        for fields in [[], [field()], [field(), password, password], [field(), field()],
                       [field(label: "Search"), password], [field(label: "Email password"), password],
                       [field("AXSearchField"), password], [field(empty: false), password],
                       [field(empty: nil), password], [field(), field("AXSecureTextField", empty: nil)],
                       [field(settable: false), password], [field(enabled: false), password],
                       [field(visible: false), password], [field(role: "AXComboBox"), password],
                       [field(form: [1]), field("AXSecureTextField", form: [2])],
                       [field(form: [1]), password]] {
            check(RegistrationFieldPolicy.select(fields) == nil)
        }
        check(RegistrationFieldPolicy.select([field(form: [1]), field("AXSecureTextField", form: [1])]) != nil)

        let expected = ["validate", "lock", "validate", "email", "passwordTarget", "password", "finish"]
        for failedAt in -1..<expected.count {
            var trace: [String] = []
            func step(_ value: String) throws {
                trace.append(value)
                if trace.count - 1 == failedAt { throw Failure("fixture_failure") }
            }
            do {
                try RegistrationFillSequence.run(validate: { try step("validate") }, lock: { try step("lock") },
                    email: { try step("email") }, passwordTarget: { try step("passwordTarget") },
                    password: { try step("password") }, finish: { try step("finish") })
                check(failedAt == -1)
            } catch let error as Failure { check(error.code == "fixture_failure" && failedAt >= 0) }
            check(trace == Array(expected.prefix(failedAt < 0 ? expected.count : failedAt + 1)))
        }

        let work = FileManager.default.temporaryDirectory.appendingPathComponent("genie-registration-privacy-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: work) }
        let dir = work.appendingPathComponent("barrier"), key = String(repeating: "a", count: 64)
        try RegistrationCapturePrivacy.requireUnblocked(key: key, directory: dir)
        check(!FileManager.default.fileExists(atPath: dir.path))
        check(try !RegistrationCapturePrivacy.activeBlock(directory: dir, currentKeys: { preconditionFailure("absent directory must not enumerate windows") }))
        check(RegistrationCapturePrivacy.markerKey(pid: 123, seconds: 789, microseconds: 10) == "70914e5657f58d5bfc427de00aa1d1fd79d6b0ae9657cea014ee935f62be7d6f")
        try RegistrationCapturePrivacy.block(key: key, directory: dir)
        refused("registration_capture_paused") { try RegistrationCapturePrivacy.requireUnblocked(key: key, directory: dir) }
        refused("registration_capture_paused") { try RegistrationCapturePrivacy.block(key: key, directory: dir) }
        try RegistrationCapturePrivacy.requireUnblocked(key: String(repeating: "b", count: 64), directory: dir)
        let marker = dir.appendingPathComponent(key)
        check(try Data(contentsOf: marker).isEmpty)
        let attributes = try FileManager.default.attributesOfItem(atPath: marker.path)
        check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["--blocked-child", dir.path, key]
        try child.run(); child.waitUntilExit()
        check(child.terminationStatus == 0) // persists across native helper processes
        check(try RegistrationCapturePrivacy.activeBlock(directory: dir, currentKeys: { [key] }))
        check(try RegistrationCapturePrivacy.activeBlock(directory: dir, currentKeys: { [key] })) // tab moved/new window, same process
        check(try RegistrationCapturePrivacy.activeBlock(directory: dir, currentKeys: { [key] })) // zero windows, process still running
        check(try !RegistrationCapturePrivacy.activeBlock(directory: dir, currentKeys: { [] })) // browser process exited
        check(try !RegistrationCapturePrivacy.activeBlock(directory: dir, currentKeys: { [String(repeating: "b", count: 64)] })) // new process generation
        let one = Target(bundleId: "fixture", windowId: 1, pid: getpid(), bounds: Bounds(x: 0, y: 0, width: 100, height: 100))
        let moved = Target(bundleId: "fixture", windowId: 99, pid: getpid(), bounds: Bounds(x: 100, y: 100, width: 100, height: 100))
        check(try RegistrationCapturePrivacy.key(one) == RegistrationCapturePrivacy.key(moved))
        refused("registration_capture_paused") {
            _ = try RegistrationCapturePrivacy.activeBlock(directory: dir, currentKeys: { throw Failure("registration_capture_paused") })
        }
        refused("registration_capture_paused") { try RegistrationCapturePrivacy.requireUnblocked(key: "../escape", directory: dir) }
        let symlink = work.appendingPathComponent("linked")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: dir)
        refused("registration_capture_paused") { try RegistrationCapturePrivacy.requireUnblocked(key: key, directory: symlink) }
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
        refused("registration_capture_paused") { try RegistrationCapturePrivacy.requireUnblocked(key: String(repeating: "b", count: 64), directory: dir) }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        let corrupt = dir.appendingPathComponent("unexpected-marker")
        try Data().write(to: corrupt)
        refused("registration_capture_paused") { _ = try RegistrationCapturePrivacy.activeBlock(directory: dir, currentKeys: { [] }) }

        // Explicit metadata-only desktop integration. The production marker
        // directory is never used, and no IDs, titles, AX or pixels are output.
        if ProcessInfo.processInfo.environment["GENIE_REGISTRATION_METADATA_TEST"] == "1" {
            let metadataDir = work.appendingPathComponent("live-metadata-barrier")
            let inactive = String(repeating: "f", count: 64)
            let realKeys = try RegistrationCapturePrivacy.activeProcessKeys()
            check(!realKeys.isEmpty && !realKeys.contains(inactive))
            try RegistrationCapturePrivacy.block(key: inactive, directory: metadataDir)
            check(try !RegistrationCapturePrivacy.activeBlock(directory: metadataDir,
                currentKeys: RegistrationCapturePrivacy.activeProcessKeys))
            guard let browser = NSWorkspace.shared.runningApplications.first(where: {
                ["com.apple.Safari", "com.google.Chrome"].contains($0.bundleIdentifier ?? "")
            }) else { throw Failure("fixture_running_browser_required") }
            let browserTarget = Target(bundleId: browser.bundleIdentifier!, windowId: 1,
                pid: browser.processIdentifier, bounds: one.bounds)
            let movedTarget = Target(bundleId: browserTarget.bundleId, windowId: 999,
                pid: browserTarget.pid, bounds: one.bounds)
            let active = try RegistrationCapturePrivacy.key(browserTarget)
            check(realKeys.contains(active))
            check(try active == RegistrationCapturePrivacy.key(movedTarget))
            try RegistrationCapturePrivacy.block(key: active, directory: metadataDir)
            check(try RegistrationCapturePrivacy.activeBlock(directory: metadataDir,
                currentKeys: RegistrationCapturePrivacy.activeProcessKeys))
            print("PASS RegistrationAssist live metadata: inactive marker clear; running browser blocked independent of window ID; temporary markers only")
        }

        if #available(macOS 14.4, *) {
            if ProcessInfo.processInfo.environment["GENIE_REGISTRATION_ORIGIN_METADATA_TEST"] == "1" {
                guard AXIsProcessTrusted(), let safari = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.Safari" }),
                      let raw = BackgroundAX.attribute(AXUIElementCreateApplication(safari.processIdentifier), kAXMainWindowAttribute),
                      CFGetTypeID(raw) == AXUIElementGetTypeID()
                else { throw Failure("fixture_browser_ax_unavailable") }
                let main = raw as! AXUIElement
                guard let id = PrivateSPI.windowID(main),
                      let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]],
                      let entry = windows.first(where: {
                          ($0[kCGWindowNumber as String] as? UInt32) == id &&
                          ($0[kCGWindowOwnerPID as String] as? Int32) == safari.processIdentifier
                      }), let rect = entry[kCGWindowBounds as String] as? [String: Double],
                      let x = rect["X"], let y = rect["Y"], let width = rect["Width"], let height = rect["Height"]
                else { throw Failure("fixture_browser_window_unavailable") }
                let target = Target(bundleId: "com.apple.Safari", windowId: id, pid: safari.processIdentifier,
                    bounds: Bounds(x: x, y: y, width: width, height: height))
                check(try CFEqual(BackgroundAX.window(target), main))
                check(try BackgroundAX.documentOrigin(in: target, allowed: ["https://www.mcdonalds.co.jp"]) == "https://www.mcdonalds.co.jp")
                print("PASS RegistrationAssist live origin metadata: exact native window ID bound; official top-level origin verified; onscreen=\(entry[kCGWindowIsOnscreen as String] as? Bool ?? false); no screenshots or field values")
            }
            let request = try JSONDecoder().decode(Request.self, from: Data("{\"op\":\"registration_prepare\"}".utf8))
            refused("registration_invalid_request") { _ = try RegistrationAssist.prepare(request) }
            let receipt = try JSONSerialization.jsonObject(with: JSONEncoder().encode(RegistrationAssist.Receipt(credentialRef: "fixture-opaque-ref"))) as! [String: String]
            check(receipt == ["status": "awaiting_user_registration", "credentialRef": "fixture-opaque-ref"])
        }
        print("PASS RegistrationAssist: \(count) cases (native policy, ordering faults, durable filesystem barrier; no UI or Keychain)")
    }
}
