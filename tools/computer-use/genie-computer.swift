import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import ScreenCaptureKit
import Foundation

// A narrow JSON-over-stdin helper. No shell, URL, credential or arbitrary file-read commands.
// Screen/window bounds and CGEvent coordinates are both Quartz points (top-left origin).
struct Failure: Error { let code: String; init(_ code: String) { self.code = code } }
struct Bounds: Codable, Equatable {
    let x: Double; let y: Double; let width: Double; let height: Double
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}
struct Frame: Codable {
    let id: String; let bundleId: String; let windowId: UInt32; let pid: Int32
    let capturedAt: Double; let width: Int; let height: Int; let bounds: Bounds; let sha256: String
}
struct Action: Decodable {
    let action: String; let frameId: String; let target: [Double]; let expectation: String
    let confidence: Double; let risk: String; let text: String?; let key: String?
}
struct Request: Decodable {
    let op: String; let id: String?; let outputPath: String?; let referencePath: String?
    let goal: String?; let recipient: String?; let scope: Frame?; let action: Action?; let authorizationExpiresAt: Double?
}
struct Target {
    let bundleId: String; let windowId: UInt32; let pid: Int32; let bounds: Bounds
}
let navigationKeys: [String: CGKeyCode] = ["TAB": 48, "ESC": 53, "LEFT": 123, "RIGHT": 124, "UP": 126, "DOWN": 125]
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func point(_ a: Action, _ f: Frame) throws -> CGPoint {
    guard a.frameId == f.id, a.target.count == 4, a.target.allSatisfy({ $0.isFinite }),
          f.width > 0, f.height > 0, f.bounds.width > 0, f.bounds.height > 0,
          f.bounds.x.isFinite, f.bounds.y.isFinite,
          a.target[0] >= 0, a.target[1] >= 0,
          a.target[2] <= Double(f.width), a.target[3] <= Double(f.height),
          a.target[2] - a.target[0] >= 2, a.target[3] - a.target[1] >= 2,
          a.confidence >= 0.9, a.confidence <= 1,
          ["navigation", "draft"].contains(a.risk) else { throw Failure("invalid_target") }
    return CGPoint(x: f.bounds.x + (a.target[0] + a.target[2]) / 2 / Double(f.width) * f.bounds.width,
                   y: f.bounds.y + (a.target[1] + a.target[3]) / 2 / Double(f.height) * f.bounds.height)
}

@available(macOS 14.4, *)
@MainActor
struct Helper {
    static func selectTarget(goal: String, recipient: String) async throws -> Target {
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && $0.processIdentifier != getpid() &&
            $0.localizedName != "Genie" && $0.bundleIdentifier != nil
        }.sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
        guard !apps.isEmpty else { throw Failure("no_target_window") }
        let choice = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 30))
        for app in apps { choice.addItem(withTitle: "\(app.localizedName ?? "App") (\(app.bundleIdentifier ?? ""))") }
        if let front = NSWorkspace.shared.frontmostApplication,
           let index = apps.firstIndex(where: { $0.processIdentifier == front.processIdentifier }) { choice.selectItem(at: index) }
        let destination = recipient == "local" ? "端末内の選択したモデル" : "外部の選択したモデル（\(recipient)）"
        let alert = NSAlert()
        alert.messageText = "画像で確認するアプリを選んでください"
        alert.informativeText = "目的: \(goal)\n画像の送信先: \(destination)\n選択したアプリの前面ウィンドウだけを扱います。各操作は別途確認し、画像は実行終了時に削除します。"
        alert.accessoryView = choice
        alert.addButton(withTitle: "このアプリで始める"); alert.addButton(withTitle: "中止")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn, apps.indices.contains(choice.indexOfSelectedItem)
        else { throw Failure("user_cancelled") }
        let selected = apps[choice.indexOfSelectedItem]
        selected.activate(options: [.activateIgnoringOtherApps])
        try await Task.sleep(nanoseconds: 300_000_000)
        let target = try currentTarget()
        guard target.pid == selected.processIdentifier else { throw Failure("target_changed") }
        return target
    }
    static func currentTarget() throws -> Target {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid(),
              let bundle = app.bundleIdentifier else { throw Failure("no_target_window") }
        let denied = ["com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.keychainaccess"]
        guard !denied.contains(bundle), !bundle.hasPrefix("com.1password"),
              !bundle.hasPrefix("com.agilebits.onepassword") else { throw Failure("protected_application") }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let w = windows.first(where: {
                  ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier &&
                  ($0[kCGWindowLayer as String] as? Int) == 0
              }),
              let id = w[kCGWindowNumber as String] as? UInt32,
              let bounds = w[kCGWindowBounds as String] as? [String: Double],
              let x = bounds["X"], let y = bounds["Y"], let width = bounds["Width"], let height = bounds["Height"],
              x.isFinite, y.isFinite, width.isFinite, height.isFinite, width > 0, height > 0
        else { throw Failure("no_target_window") }
        return Target(bundleId: bundle, windowId: id, pid: app.processIdentifier,
                      bounds: Bounds(x: x, y: y, width: width, height: height))
    }
    static func checkPermissions() throws {
        guard AXIsProcessTrusted() else { throw Failure("accessibility_required") }
        guard CGPreflightScreenCaptureAccess() else { throw Failure("screen_capture_required") }
    }
    static func checkScope(_ f: Frame) throws -> Target {
        try checkPermissions()
        let t = try currentTarget()
        guard t.bundleId == f.bundleId, t.windowId == f.windowId, t.pid == f.pid else { throw Failure("target_changed") }
        guard t.bounds == f.bounds else { throw Failure("stale_frame") }
        return t
    }
    static func secureFocus() -> Bool {
        let system = AXUIElementCreateSystemWide()
        var focus: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focus) == .success,
              let focus else { return true }
        var subrole: CFTypeRef?
        guard AXUIElementCopyAttributeValue(focus as! AXUIElement, kAXSubroleAttribute as CFString, &subrole) == .success
        else { return false }
        return (subrole as? String) == (kAXSecureTextFieldSubrole as String)
    }
    static func canType(at p: CGPoint) -> Bool {
        guard !secureFocus() else { return false }
        let system = AXUIElementCreateSystemWide()
        var focus: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focus) == .success,
              let focus else { return false }
        let element = focus as! AXUIElement
        var role: CFTypeRef?, pos: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
              [kAXTextFieldRole as String, kAXTextAreaRole as String, kAXComboBoxRole as String].contains(role as? String ?? ""),
              AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &pos) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
              let pos, let size, CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
        else { return false }
        var origin = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetValue(pos as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions)
        else { return false }
        return CGRect(origin: origin, size: dimensions).contains(p)
    }
    static func consent(_ title: String, _ detail: String, image: NSImage? = nil) throws {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "続ける")
        alert.addButton(withTitle: "中止")
        alert.alertStyle = .warning
        if let image {
            let view = NSImageView(frame: NSRect(x: 0, y: 0, width: 360, height: 220))
            view.image = image; view.imageScaling = .scaleProportionallyUpOrDown
            alert.accessoryView = view
        }
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { throw Failure("user_cancelled") }
    }
    static func restore(_ t: Target) async throws {
        guard let app = NSRunningApplication(processIdentifier: t.pid), !app.isTerminated else { throw Failure("target_changed") }
        app.activate(options: [.activateIgnoringOtherApps])
        try await Task.sleep(nanoseconds: 300_000_000)
        let now = try currentTarget()
        guard now.pid == t.pid, now.windowId == t.windowId, now.bounds == t.bounds else { throw Failure("target_changed") }
    }
    static func capture(_ t: Target) async throws -> (CGImage, Data) {
        try checkPermissions()
        guard !secureFocus() else { throw Failure("protected_field") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let w = content.windows.first(where: { $0.windowID == t.windowId && $0.owningApplication?.processID == t.pid })
        else { throw Failure("target_changed") }
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let config = SCStreamConfiguration()
        let scale = min(1.0, 1440.0 / max(t.bounds.width, t.bounds.height))
        config.width = max(1, Int((t.bounds.width * scale).rounded()))
        config.height = max(1, Int((t.bounds.height * scale).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let latest = try currentTarget()
        guard latest.pid == t.pid, latest.windowId == t.windowId, latest.bounds == t.bounds else { throw Failure("stale_frame") }
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), data.count <= 10 * 1024 * 1024
        else { throw Failure("capture_failed") }
        return (image, data)
    }
    static func privateWrite(_ data: Data, id: String, path: String) throws {
        guard id.hasPrefix("cv-"), UUID(uuidString: String(id.dropFirst(3))) != nil,
              URL(fileURLWithPath: path).lastPathComponent == "\(id).png",
              URL(fileURLWithPath: path).deletingLastPathComponent().resolvingSymlinksInPath().path == URL(fileURLWithPath: path).deletingLastPathComponent().path
        else { throw Failure("invalid_cache") }
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Failure("cache_write_failed") }
        defer { close(fd) }
        try data.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { throw Failure("cache_write_failed") }
            var offset = 0
            while offset < buffer.count {
                let count = write(fd, base.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw Failure("cache_write_failed") }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw Failure("cache_write_failed") }
    }
    static func respond(_ request: Request) async throws -> Data {
        try checkPermissions()
        if request.op == "begin" || request.op == "capture" {
            let t: Target
            if request.op == "begin" {
                t = try await selectTarget(goal: request.goal ?? "", recipient: request.recipient ?? "unknown")
            } else {
                guard let scope = request.scope else { throw Failure("invalid_scope") }
                t = try checkScope(scope)
            }
            let (image, png) = try await capture(t)
            guard let id = request.id, let path = request.outputPath else { throw Failure("invalid_request") }
            try privateWrite(png, id: id, path: path)
            return try JSONEncoder().encode(Frame(id: id, bundleId: t.bundleId, windowId: t.windowId, pid: t.pid,
                capturedAt: Date().timeIntervalSince1970 * 1000, width: image.width, height: image.height,
                bounds: t.bounds, sha256: digest(png)))
        }
        guard request.op == "apply", let f = request.scope, let a = request.action,
              let reference = request.referencePath, URL(fileURLWithPath: reference).lastPathComponent == "\(f.id).png"
        else { throw Failure("invalid_request") }
        guard let expires = request.authorizationExpiresAt, expires.isFinite,
              expires > Date().timeIntervalSince1970 * 1000 else { throw Failure("approval_expired") }
        let t = try checkScope(f)
        guard Date().timeIntervalSince1970 * 1000 - f.capturedAt <= 60_000 else { throw Failure("stale_frame") }
        let p = try point(a, f)
        guard ["click", "type", "key"].contains(a.action), !secureFocus() else { throw Failure("protected_field") }
        if a.action == "type" {
            guard let text = a.text, !text.isEmpty, text.utf16.count <= 2000,
                  !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }), canType(at: p)
            else { throw Failure("invalid_text_target") }
        }
        if a.action == "key", navigationKeys[a.key ?? ""] == nil { throw Failure("invalid_key") }
        // Exact pixel equality is intentionally conservative. Animation/caret changes can require replanning.
        let (_, before) = try await capture(t)
        guard digest(before) == f.sha256 else { throw Failure("stale_frame") }
        let detail = a.action == "type" ? "入力内容: \(a.text ?? "")" : "操作: \(a.action) \(a.key ?? "")\n位置: \(Int(p.x)), \(Int(p.y))"
        let preview = NSImage(data: before)
        try consent("この1操作を実行しますか？", "対象: \(t.bundleId)\n\(detail)\n期待する結果: \(a.expectation)", image: preview)
        try await restore(t)
        _ = try checkScope(f)
        let (_, fresh) = try await capture(t)
        guard digest(fresh) == f.sha256 else { throw Failure("stale_frame") }
        guard expires > Date().timeIntervalSince1970 * 1000 else { throw Failure("approval_expired") }
        if a.action == "type", !canType(at: p) { throw Failure("invalid_text_target") }
        guard let source = CGEventSource(stateID: .hidSystemState) else { throw Failure("input_failed") }
        if a.action == "click" {
            guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)
            else { throw Failure("input_failed") }
            down.setIntegerValueField(.mouseEventClickState, value: 1)
            up.setIntegerValueField(.mouseEventClickState, value: 1)
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        } else if a.action == "key" {
            guard let code = navigationKeys[a.key ?? ""],
                  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
            else { throw Failure("input_failed") }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        } else {
            // UTF-16 chunks never split a surrogate pair. Japanese and non-BMP emoji are preserved.
            var units = Array((a.text ?? "").utf16)
            while !units.isEmpty {
                var count = min(20, units.count)
                if count < units.count && (0xD800...0xDBFF).contains(units[count - 1]) { count -= 1 }
                let chunk = Array(units.prefix(count)); units.removeFirst(count)
                for pressed in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: pressed) else { throw Failure("input_failed") }
                    chunk.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                    event.post(tap: .cghidEventTap)
                }
            }
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        return Data("{\"status\":\"applied\"}".utf8)
    }
}

@main struct Main {
    @MainActor static func main() async {
        do {
            if CommandLine.arguments.contains("--self-test") {
                let f = Frame(id: "test", bundleId: "test", windowId: 1, pid: 1, capturedAt: 0, width: 1000, height: 500,
                    bounds: Bounds(x: -1920, y: 200, width: 2000, height: 1000), sha256: "")
                let a = Action(action: "click", frameId: "test", target: [100, 50, 200, 100], expectation: "open",
                    confidence: 0.95, risk: "navigation", text: nil, key: nil)
                let p = try point(a, f)
                guard p.x == -1620, p.y == 350 else { throw Failure("coordinate_test_failed") }
                let bad = Action(action: "click", frameId: "other", target: [-1, 0, 20, 20], expectation: "open",
                    confidence: 1, risk: "navigation", text: nil, key: nil)
                do { _ = try point(bad, f); throw Failure("rejection_test_failed") }
                catch let error as Failure where error.code == "invalid_target" { }
                print("GENIE_COMPUTER_SELF_TEST_OK"); return
            }
            let input = FileHandle.standardInput.readDataToEndOfFile()
            guard input.count <= 128 * 1024 else { throw Failure("invalid_request") }
            let request = try JSONDecoder().decode(Request.self, from: input)
            _ = NSApplication.shared
            NSApp.setActivationPolicy(.accessory)
            if #available(macOS 14.4, *) {
                let data = try await Helper.respond(request)
                FileHandle.standardOutput.write(data)
            } else { throw Failure("macos_14_4_required") }
        } catch {
            let code = (error as? Failure)?.code ?? "helper_failed"
            let data = (try? JSONSerialization.data(withJSONObject: ["error": code])) ?? Data()
            FileHandle.standardOutput.write(data)
            exit(1)
        }
    }
}
