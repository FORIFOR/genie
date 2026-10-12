import AppKit
import ApplicationServices
import CryptoKit

// A single confirmed insertion into a pinned, non-secure Accessibility text field.
// No global keyboard events, clipboard, scripts or shell are used.
struct Refusal: Error {}
func require(_ value: Bool) throws { if !value { throw Refusal() } }
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}
func element(_ parent: AXUIElement, _ key: String) -> AXUIElement? {
    guard let value = attribute(parent, key), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func focused(_ pid: pid_t) -> AXUIElement? {
    element(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute)
}
func textValue(_ element: AXUIElement) -> String? { attribute(element, kAXValueAttribute) as? String }
func selectedRange(_ element: AXUIElement) -> CFRange? {
    guard let raw = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = raw as! AXValue
    guard AXValueGetType(value) == .cfRange else { return nil }
    var range = CFRange()
    return AXValueGetValue(value, .cfRange, &range) ? range : nil
}
func replacement(_ original: String, _ range: CFRange, _ text: String) throws -> String {
    let value = original as NSString
    try require(range.location >= 0 && range.length >= 0 && range.location <= value.length && range.length <= value.length - range.location)
    return value.replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
}
func confirm(_ title: String, _ body: String, _ verb: String) -> Bool {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = body
    alert.addButton(withTitle: verb)
    alert.addButton(withTitle: "やめる")
    NSApp.activate(ignoringOtherApps: true)
    return alert.runModal() == .alertFirstButtonReturn
}
func chooseApp() throws -> NSRunningApplication {
    let apps = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
    }.sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
    try require(!apps.isEmpty)
    let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 320, height: 30))
    picker.addItems(withTitles: apps.map { $0.localizedName ?? $0.bundleIdentifier ?? "アプリ" })
    let alert = NSAlert()
    alert.messageText = "入力するアプリを選んでください"
    alert.informativeText = "選んだアプリで最後に使用した入力欄を確認します。内容はこのMac内で照合します。"
    alert.accessoryView = picker
    alert.addButton(withTitle: "入力欄を確認")
    alert.addButton(withTitle: "やめる")
    NSApp.activate(ignoringOtherApps: true)
    try require(alert.runModal() == .alertFirstButtonReturn)
    return apps[picker.indexOfSelectedItem]
}
func insert(_ request: [String: Any]) throws -> [String: Any] {
    try require(AXIsProcessTrusted())
    guard let text = request["text"] as? String, let expires = request["expiresAt"] as? Double else { throw Refusal() }
    try require(!text.isEmpty && text.utf16.count <= 2000 && !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }))
    try require(expires.isFinite && Date().timeIntervalSince1970 * 1000 < expires)
    let app = try chooseApp()
    let pid = app.processIdentifier
    try require(app.activate(options: [.activateIgnoringOtherApps]))
    Thread.sleep(forTimeInterval: 0.3)
    guard let field = focused(pid), let original = textValue(field), let range = selectedRange(field),
          let role = attribute(field, kAXRoleAttribute) as? String else { throw Refusal() }
    try require([kAXTextFieldRole, kAXTextAreaRole].contains(role))
    let subrole = attribute(field, kAXSubroleAttribute) as? String ?? ""
    try require(!subrole.lowercased().contains("secure") && original.utf16.count <= 50000)
    var settable = DarwinBoolean(false)
    try require(AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &settable) == .success && settable.boolValue)
    let expected = try replacement(original, range, text)
    try require(confirm("この入力欄へ挿入します", "対象: \(app.localizedName ?? "アプリ")\n\n入力: \(text)\n\nアプリによっては自動保存されます。送信や保存の完了は保証しません。", "挿入する"))
    try require(Date().timeIntervalSince1970 * 1000 < expires && AXIsProcessTrusted() && !app.isTerminated)
    try require(app.activate(options: [.activateIgnoringOtherApps]))
    Thread.sleep(forTimeInterval: 0.2)
    guard let current = focused(pid), let nowRange = selectedRange(field) else { throw Refusal() }
    try require(NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && CFEqual(current, field) &&
        textValue(field) == original && nowRange.location == range.location && nowRange.length == range.length)
    try require(AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute as CFString, text as CFString) == .success)
    // Read back the entire expected value, not just the submitted string.
    guard let actual = textValue(field), let after = focused(pid) else { throw Refusal() }
    let verified = CFEqual(field, after) && actual == expected
    return ["verified": verified, "evidence": verified ? SHA256.hash(data: Data(actual.utf8)).map { String(format: "%02x", $0) }.joined() : ""]
}
func main() throws {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    let data = FileHandle.standardInput.readDataToEndOfFile()
    try require(data.count <= 20000)
    guard let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Refusal() }
    let output: [String: Any]
    switch input["command"] as? String {
    case "probe": output = ["available": AXIsProcessTrusted()]
    case "selftest":
        try require(try replacement("A🐻B", CFRange(location: 1, length: 2), "日本語") == "A日本語B")
        do { _ = try replacement("a", CFRange(location: 2, length: 1), "b"); throw NSError(domain: "test", code: 1) }
        catch is Refusal {} // Invalid UTF-16 range must refuse.
        output = ["selftest": true]
    case "insert": output = try insert(input)
    default: throw Refusal()
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output))
}
do { try main() } catch { FileHandle.standardError.write(Data("Field operation refused; no automatic retry.\n".utf8)); exit(1) }
