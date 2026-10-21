import AppKit
import ApplicationServices
import UserNotifications
import CryptoKit

/// Only a visible leave-call control is evidence of a joined call. App launch,
/// calendar links and meeting landing pages alone must not trigger recording prompts.
struct MeetingReminderPolicy {
    private(set) var sessions: [String: String] = [:]
    private var missingSince: [String: Date] = [:]

    @MainActor static func provider(bundleId: String, title: String) -> String? {
        switch bundleId {
        case "us.zoom.xos": return "Zoom"
        case "com.microsoft.teams", "com.microsoft.teams2": return "Microsoft Teams"
        default:
            guard MeetingDetector.browsers.contains(bundleId) else { return nil }
            let t = title.lowercased()
            if t.contains("google meet") || t.contains("meet.google.com") || t.hasPrefix("meet - ") { return "Google Meet" }
            if t.contains("microsoft teams") || t.contains("teams.microsoft.com") || t.contains("teams.live.com") { return "Microsoft Teams" }
            if t.contains("zoom meeting") || t.contains("zoom workplace") { return "Zoom" }
            return nil
        }
    }

    static func isMeetingDocument(_ document: String, provider: String) -> Bool {
        guard let url = URL(string: document), url.scheme == "https", let host = url.host?.lowercased() else { return false }
        switch provider {
        case "Google Meet": return host == "meet.google.com"
        case "Microsoft Teams": return ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].contains(host)
        case "Zoom": return host == "zoom.us" || host.hasSuffix(".zoom.us") || host == "zoom.com" || host.hasSuffix(".zoom.com")
        default: return false
        }
    }

    static func sessionKey(pid: pid_t, provider: String, document: String?) -> String {
        let base = "\(pid):\(provider)"
        guard let document, let url = URL(string: document), url.scheme == "https" else { return base }
        // Keep document identity out of notification IDs/logs; different calls in one browser
        // are different sessions even if the previous call tab disappeared immediately.
        let digest = SHA256.hash(data: Data(document.utf8)).map { String(format: "%02x", $0) }.joined()
        return "\(base):\(digest)"
    }

    static func isLeaveControl(_ text: String) -> Bool {
        let label = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["leave", "leave call", "leave meeting", "leave the call", "hang up", "end call",
                "通話から退出", "通話を終了", "会議から退出", "ミーティングを退出", "退出"]
            .contains { label == $0 || label.hasPrefix($0 + " (") || label.hasPrefix($0 + "（") }
    }

    mutating func forget(key: String) {
        sessions[key] = nil
        missingSince[key] = nil
    }

    mutating func retryUndelivered(key: String, id: String) {
        guard sessions[key] == id else { return }
        forget(key: key)
    }

    /// Unknown/other-app observations preserve the session. A confirmed absence
    /// for 12 seconds rearms the next call, avoiding transient AX loading flicker.
    mutating func observe(key: String, inCall: Bool?, recording: Bool, now: Date) -> String? {
        guard let inCall else { return nil }
        if inCall {
            missingSince[key] = nil
            guard sessions[key] == nil else { return nil }
            let id = UUID().uuidString
            sessions[key] = id
            return recording ? nil : id
        }
        if missingSince[key] == nil { missingSince[key] = now }
        if now.timeIntervalSince(missingSince[key]!) >= 12 { sessions[key] = nil }
        return nil
    }
}

/// Read only AX button names, never meeting contents. Bounded work runs away
/// from the main thread; a timeout is unknown, not evidence that a call ended.
private enum MeetingCallProbe {
    static func title(pid: pid_t) -> String? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success,
              let focused else { return nil }
        let window = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(window, 0.1)
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success else { return nil }
        return title as? String
    }

    static func inspect(pid: pid_t, provider: String, browser: Bool) -> (inCall: Bool?, document: String?) {
        guard AXIsProcessTrusted() else { return (nil, nil) }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success,
              let focused else { return (nil, nil) }
        let window = focused as! AXUIElement
        var incomplete = false
        var visited = 0
        let deadline = ProcessInfo.processInfo.systemUptime + 0.4
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            AXUIElementSetMessagingTimeout(element, 0.05)
            var value: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
            if result == .cannotComplete || result == .invalidUIElement || result == .failure { incomplete = true }
            return result == .success ? value : nil
        }
        func children(_ element: AXUIElement) -> [AXUIElement] {
            (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        }
        var scope = window
        var document: String?
        if browser {
            var queue = [window]
            var found: AXUIElement?
            while !queue.isEmpty, visited < 600, ProcessInfo.processInfo.systemUptime < deadline {
                let element = queue.removeLast(); visited += 1
                if (attribute(element, kAXRoleAttribute) as? String) == "AXWebArea" {
                    let value = attribute(element, "AXURL") ?? attribute(element, "AXDocument")
                    let url = (value as? URL)?.absoluteString ?? (value as? String)
                    if let url, MeetingReminderPolicy.isMeetingDocument(url, provider: provider) {
                        guard found == nil else { return (nil, nil) }
                        found = element; document = url
                    }
                    // Do not descend into page content while enumerating sibling web areas.
                    continue
                }
                queue.append(contentsOf: children(element))
            }
            guard queue.isEmpty, !incomplete else { return (nil, nil) }
            // Unknown page identity never falls back to process-wide consent.
            guard let found else { return (nil, nil) }
            scope = found
        }
        var queue = [scope]
        var joined = false
        while !queue.isEmpty {
            guard visited < 1200, ProcessInfo.processInfo.systemUptime < deadline else { return (nil, document) }
            let element = queue.removeLast(); visited += 1
            let role = attribute(element, kAXRoleAttribute) as? String
            if role == kAXButtonRole || role == "AXMenuButton" {
                let labels = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute]
                    .compactMap { attribute(element, $0) as? String }
                if labels.contains(where: MeetingReminderPolicy.isLeaveControl) { joined = true; break }
            }
            queue.append(contentsOf: children(element))
        }
        var stillFocused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &stillFocused) == .success,
              let stillFocused, CFEqual(window, stillFocused) else { return (nil, document) }
        if browser {
            let value = attribute(scope, "AXURL") ?? attribute(scope, "AXDocument")
            let current = (value as? URL)?.absoluteString ?? (value as? String)
            guard current == document else { return (nil, nil) }
        }
        return (joined ? true : (incomplete ? nil : false), document)
    }
}

@MainActor
final class MeetingRecordingReminder: NSObject, UNUserNotificationCenterDelegate {
    static let shared = MeetingRecordingReminder()
    private let center = UNUserNotificationCenter.current()
    private var timer: Timer?
    private var probing = false
    private var policy = MeetingReminderPolicy()
    private var requests: [String: (key: String, provider: String, pid: pid_t)] = [:]
    private static let category = "astra.meeting-recording"
    private static let begin = "astra.meeting-recording.begin"

    func start() {
        guard timer == nil else { return }
        center.delegate = self
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [
            UNNotificationAction(identifier: Self.begin, title: "収録を開始", options: []),
            UNNotificationAction(identifier: "astra.meeting-recording.dismiss", title: "今はしない", options: [])
        ], intentIdentifiers: [], options: [.customDismissAction])])
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { _ in
            Task { @MainActor in await Self.shared.refresh() }
        }
        Task { await refresh() }
    }

    private func refresh() async {
        guard !probing, let app = NSWorkspace.shared.frontmostApplication,
              let bundle = app.bundleIdentifier,
              MeetingDetector.apps[bundle] != nil || MeetingDetector.browsers.contains(bundle) else { return }
        let running = Set(NSWorkspace.shared.runningApplications.map { String($0.processIdentifier) })
        for key in Array(policy.sessions.keys) where !running.contains(String(key.split(separator: ":")[0])) {
            policy.forget(key: key)
        }
        for (id, context) in requests where policy.sessions[context.key] == nil {
            center.removeDeliveredNotifications(withIdentifiers: [id])
            center.removePendingNotificationRequests(withIdentifiers: [id])
            requests[id] = nil
        }
        probing = true
        defer { probing = false }
        let pid = app.processIdentifier
        let title = await Task.detached(priority: .utility) { MeetingCallProbe.title(pid: pid) }.value ?? ""
        guard let provider = MeetingReminderPolicy.provider(bundleId: bundle, title: title) else { return }
        let browser = MeetingDetector.browsers.contains(bundle)
        let observation = await Task.detached(priority: .utility) { MeetingCallProbe.inspect(pid: pid, provider: provider, browser: browser) }.value
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              !browser || observation.document != nil else { return }
        let key = MeetingReminderPolicy.sessionKey(pid: pid, provider: provider, document: observation.document)
        let joined = observation.inCall
        let recording = RecordingWorkspaceState.shared.isRecording
        let id = policy.observe(key: key, inCall: joined, recording: recording, now: Date())
        for (request, context) in requests where context.key == key && (policy.sessions[key] == nil || recording) {
            center.removeDeliveredNotifications(withIdentifiers: [request])
            center.removePendingNotificationRequests(withIdentifiers: [request])
            requests[request] = nil
        }
        guard let id else { return }
        var consumed = false
        defer {
            if !consumed {
                requests[id] = nil
                policy.retryUndelivered(key: key, id: id)
            }
        }
        do {
            // Ask only when there is a concrete reminder to show, never at launch.
            guard try await center.requestAuthorization(options: [.alert]) else {
                consumed = true // Explicit refusal must not repeatedly prompt for this call.
                return
            }
            // Consent may take longer than the call; sample again after it returns.
            let current = await Task.detached(priority: .utility) { MeetingCallProbe.inspect(pid: pid, provider: provider, browser: browser) }.value
            guard current.inCall == true, (!browser || current.document != nil),
                  MeetingReminderPolicy.sessionKey(pid: pid, provider: provider, document: current.document) == key, policy.sessions[key] == id,
                  !RecordingWorkspaceState.shared.isRecording else { return }
            let content = UNMutableNotificationContent()
            content.title = "\(provider)の会議を収録しますか？"
            content.body = "「収録を開始」を押すと、Genieで会議を記録します。"
            content.categoryIdentifier = Self.category
            requests[id] = (key, provider, pid)
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
            consumed = true
        } catch {
            requests[id] = nil
            NSLog("astra: meeting recording reminder delivery failed")
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.identifier
        // 予約のお知らせ（NoticeInbox）。通知の受け手は 1 つなので、ここで振り分ける
        if id.hasPrefix(NoticeInbox.prefix) {
            let notification = response.notification
            Task { @MainActor in
                if response.actionIdentifier == UNNotificationDefaultActionIdentifier { NoticeInbox.opened(notification) }
                completionHandler()
            }
            return
        }
        let start = response.actionIdentifier == "astra.meeting-recording.begin"
        let open = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        Task { @MainActor in
            defer { completionHandler() }
            guard let context = self.requests.removeValue(forKey: id) else { return }
            self.center.removeDeliveredNotifications(withIdentifiers: [id])
            if open { MainWindowController.shared.showSection(.home) }
            guard start, self.policy.sessions[context.key] == id,
                  !RecordingWorkspaceState.shared.isRecording else { return }
            let browser = NSRunningApplication(processIdentifier: context.pid)?.bundleIdentifier.map { MeetingDetector.browsers.contains($0) } == true
            let observation = await Task.detached(priority: .utility) { MeetingCallProbe.inspect(pid: context.pid, provider: context.provider, browser: browser) }.value
            let key = MeetingReminderPolicy.sessionKey(pid: context.pid, provider: context.provider, document: observation.document)
            guard observation.inCall == true, (!browser || observation.document != nil), key == context.key,
                  !RecordingWorkspaceState.shared.isRecording else {
                MainWindowController.shared.showSection(.home)
                return
            }
            // Explicit action only. Never toggle: an already running recording
            // must not be stopped by a late notification click.
            GenieStateStore.shared.meetingDetected(app: context.provider)
            RecordingWorkspaceState.shared.start()
        }
    }
}
