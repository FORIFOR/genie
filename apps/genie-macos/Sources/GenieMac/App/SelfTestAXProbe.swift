import AppKit
import ApplicationServices

/// `--selftest axprobe`: 開いているアプリごとに、フォーカス中の要素が何で、音声入力が今の方法で入れられるかを読む。
/// **読むだけ**（何も打ち込まない・値を変えない）。欄が値の書き換えを受けないアプリを見つけるため。
extension SelfTest {
    @MainActor
    static func axProbe() {
        guard AXIsProcessTrusted() else { print("SELFTEST_SKIP axprobe: AX not trusted"); exit(0) }
        func attr(_ e: AXUIElement, _ name: String) -> String {
            var v: CFTypeRef?
            guard AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success, let v else { return "-" }
            return (v as? String) ?? "\(v)".prefix(20).description
        }
        var rows: [String] = []
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && app.processIdentifier != getpid() {
            let el = AXUIElementCreateApplication(app.processIdentifier)
            var f: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, kAXFocusedUIElementAttribute as CFString, &f) == .success, let f else {
                rows.append("\(app.localizedName ?? "?"): focus=なし"); continue
            }
            let e = f as! AXUIElement
            var settable: DarwinBoolean = false
            AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable)
            var selSettable: DarwinBoolean = false
            AXUIElementIsAttributeSettable(e, kAXSelectedTextAttribute as CFString, &selSettable)
            let ok = Dictation.focusedTextTarget(excludingOwnProcess: true, appPID: app.processIdentifier) != nil
            rows.append("\(app.localizedName ?? "?"): role=\(attr(e, kAXRoleAttribute)) sub=\(attr(e, kAXSubroleAttribute)) value書換=\(settable.boolValue) 選択書換=\(selSettable.boolValue) 今の方法で入る=\(ok) 前面=\(app.isActive)")
        }
        print("SELFTEST_OK axprobe:\n" + rows.joined(separator: "\n"))
        exit(0)
    }
}
