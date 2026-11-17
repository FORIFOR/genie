// Local checkout session. It cannot connect to a restaurant, broker or payment processor.
import AppKit
import Foundation
import CryptoKit
import Darwin

// A removed button can never confirm the replacement order, even if an old AX reference survives.
final class CheckoutConfirmation: NSObject {
    weak var owner: CheckoutSimulation?
    let commandId: String
    init(_ owner: CheckoutSimulation, _ commandId: String) { self.owner = owner; self.commandId = commandId }
    @objc func confirm() { owner?.confirm(commandId) }
}

final class CheckoutSimulation: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var resultLabel: NSTextField!
    var button: NSButton!
    var confirmation: CheckoutConfirmation?
    var checkout: [String: Any] = [:]
    var path = "", directory = "", quoteHash = "", sessionId = "", commandId = ""
    var activations = 0, clicks = 0
    var armed = false
    var idleTimer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--session",
              UUID(uuidString: CommandLine.arguments[2]) != nil else { fail(); return }
        sessionId = CommandLine.arguments[2]
        scheduleIdleExit()
        // The only command channel is the parent's private pipe, never a shared socket or global file.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var buffer = Data()
            do {
                var chunk = [UInt8](repeating: 0, count: 4096)
                while true {
                    // read(upToCount:) can wait to fill a pipe buffer. Each command
                    // must become visible while the parent keeps stdin open.
                    let count = Darwin.read(STDIN_FILENO, &chunk, chunk.count)
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 { break }
                    buffer.append(contentsOf: chunk.prefix(count))
                    guard buffer.count <= 1_000_000 else { throw Fault.invalid }
                    while let newline = buffer.firstIndex(of: 10) {
                        let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                        DispatchQueue.main.async { self?.receive(line) }
                    }
                }
            } catch { }
            // Host exit/crash closes stdin; do not leave an orphaned checkout window.
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    enum Fault: Error { case invalid, expired, changed }
    func fail() { fputs("simulation_invalid_input\n", stderr); NSApp.terminate(nil) }
    func scheduleIdleExit() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { _ in NSApp.terminate(nil) }
    }
    func receive(_ data: Data) {
        do {
            guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  message["sessionId"] as? String == sessionId,
                  let nonce = message["commandId"] as? String, UUID(uuidString: nonce) != nil,
                  let op = message["op"] as? String else { throw Fault.invalid }
            if op == "idle" {
                guard nonce == commandId, !armed else { throw Fault.invalid }
                button?.isEnabled = false
                resultLabel?.stringValue += "\n次の模擬注文を待機しています（5分で閉じます）"
                scheduleIdleExit(); saveWindow(); return
            }
            guard op == "load", !armed, nonce != commandId,
                  let file = message["path"] as? String, (file as NSString).isAbsolutePath,
                  (file as NSString).lastPathComponent == "checkout.json" else { throw Fault.invalid }
            idleTimer?.invalidate()
            // Invalidate the previous order before parsing or displaying any replacement.
            button?.isEnabled = false; confirmation = nil; armed = false
            let next = try readPrivate(file)
            guard let quote = next["quote"] as? [String: Any],
                  quote["mode"] as? String == "simulation", quote["provider"] as? String == "genie.simulation",
                  let hash = next["quoteHash"] as? String, hash.count == 64,
                  let candidate = next["candidate"] as? [String: Any], candidate["quoteHash"] as? String == hash,
                  candidate["providerOrderId"] is String,
                  let deadline = next["authorizationExpiresAt"] as? Double,
                  deadline > Date().timeIntervalSince1970 * 1000,
                  let total = quote["totals"] as? [String: Any], let items = quote["items"] as? [[String: Any]],
                  let destination = quote["destination"] as? [String: Any] else { throw Fault.invalid }
            let bytes = try JSONSerialization.data(withJSONObject: quote, options: [.sortedKeys, .withoutEscapingSlashes])
            guard SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == hash else { throw Fault.changed }
            path = file; directory = (file as NSString).deletingLastPathComponent
            checkout = next; quoteHash = hash; commandId = nonce; clicks = 0; activations = 0
            let first = window == nil
            if first {
                window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 620, height: 440),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
                window.title = "Genie 模擬注文 — 課金なし"
                window.delegate = self
            }
            window.contentView!.subviews.forEach { $0.removeFromSuperview() }
            let stack = NSStackView()
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
            stack.translatesAutoresizingMaskIntoConstraints = false
            window.contentView!.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
                stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
                stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 28),
            ])
            let heading = NSTextField(labelWithString: "模擬注文の内容")
            heading.font = .systemFont(ofSize: 23, weight: .semibold); stack.addArrangedSubview(heading)
            stack.addArrangedSubview(NSTextField(wrappingLabelWithString: "この画面は動作検証用です。実際の配送・支払い・証券売買は発生しません。"))
            let rows = items.map { "\($0["label"] ?? "") × \($0["quantity"] ?? 0)　\($0["lineMinor"] ?? 0) 円" }
            stack.addArrangedSubview(NSTextField(wrappingLabelWithString: rows.joined(separator: "\n")))
            stack.addArrangedSubview(NSTextField(labelWithString: "合計（手数料込み）: \(total["totalMinor"] ?? 0) 円"))
            stack.addArrangedSubview(NSTextField(labelWithString: "宛先: \(destination["label"] ?? "")"))
            if let stock = quote["stock"] as? [String: Any] {
                stack.addArrangedSubview(NSTextField(labelWithString: "模擬市場: \(stock["symbol"] ?? "") / \(stock["side"] ?? "") / \(stock["orderType"] ?? "")"))
            }
            confirmation = CheckoutConfirmation(self, nonce)
            button = NSButton(title: "模擬注文を確定 \(hash.prefix(12))", target: confirmation, action: #selector(CheckoutConfirmation.confirm))
            button.bezelStyle = .rounded; stack.addArrangedSubview(button)
            resultLabel = NSTextField(wrappingLabelWithString: "受付前")
            stack.addArrangedSubview(resultLabel)
            armed = true
            if first {
                window.orderFrontRegardless()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    NSApp.setActivationPolicy(.regular); self.saveWindow()
                }
            } else { saveWindow() } // Do not reveal, raise, activate, or replace the consented window.
        } catch { fail() }
    }

    func readPrivate(_ file: String) throws -> [String: Any] {
        let fd = Darwin.open(file, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw Fault.invalid }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              info.st_mode & S_IFMT == S_IFREG, info.st_size < 1_000_000 else { throw Fault.invalid }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        guard let data = try handle.readToEnd(), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw Fault.invalid }
        return value
    }
    func confirm(_ nonce: String) {
        // A stale button target is harmless even after a different order has been loaded.
        guard armed, nonce == commandId else { return }
        armed = false; button.isEnabled = false
        do {
            let current = try readPrivate(path)
            guard NSDictionary(dictionary: current).isEqual(to: checkout),
                  let quote = checkout["quote"] as? [String: Any],
                  let saved = try readPrivate(directory + "/quote.json")["quote"] as? [String: Any],
                  NSDictionary(dictionary: quote).isEqual(to: saved),
                  let deadline = checkout["authorizationExpiresAt"] as? Double,
                  deadline > Date().timeIntervalSince1970 * 1000 else { throw Fault.changed }
            var receipt = checkout["candidate"] as! [String: Any]
            let timestamp = ISO8601DateFormatter()
            timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            receipt["observedAt"] = timestamp.string(from: Date())
            let receiptPath = directory + "/receipt.json"
            let temporary = directory + "/receipt-" + UUID().uuidString + ".tmp"
            let fd = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
            guard fd >= 0 else { throw Fault.invalid }
            defer { Darwin.unlink(temporary) }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            try handle.write(contentsOf: JSONSerialization.data(withJSONObject: receipt))
            try handle.synchronize(); try handle.close()
            if Darwin.link(temporary, receiptPath) != 0 {
                guard errno == EEXIST else { throw Fault.invalid }
                receipt = try readPrivate(receiptPath)
                guard receipt["quoteHash"] as? String == quoteHash else { throw Fault.changed }
            } else {
                let parent = Darwin.open(directory, O_RDONLY | O_NOFOLLOW)
                guard parent >= 0 else { throw Fault.invalid }
                defer { Darwin.close(parent) }
                guard Darwin.fsync(parent) == 0 else { throw Fault.invalid }
                clicks += 1
            }
            resultLabel.stringValue = "模擬受付: \(receipt["providerOrderId"] ?? "")\n状態: \(receipt["status"] ?? "")"
        } catch { resultLabel.stringValue = "内容または許可を確認できません。注文は再送しません。" }
        scheduleIdleExit(); saveWindow()
    }
    func windowWillClose(_ note: Notification) { NSApp.terminate(nil) }
    func applicationDidBecomeActive(_ note: Notification) { activations += 1; saveWindow() }
    func saveWindow() {
        guard let window, !directory.isEmpty else { return }
        let record: [String: Any] = ["pid": getpid(), "sessionId": sessionId, "commandId": commandId,
            "windowId": window.windowNumber, "quoteHash": quoteHash, "ready": armed,
            "activations": activations, "clicks": clicks, "visible": window.isVisible,
            "onActiveSpace": window.isOnActiveSpace, "status": resultLabel.stringValue]
        if let data = try? JSONSerialization.data(withJSONObject: record) {
            try? data.write(to: URL(fileURLWithPath: directory + "/window.json"), options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: directory + "/window.json")
        }
    }
}

let app = NSApplication.shared
let delegate = CheckoutSimulation()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
