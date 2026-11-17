//  対象の窓の中身を、**モデルを介さずに**読む。試験の照合用。
//  読むだけで、押しも打ちもしない。
import AppKit
import ApplicationServices

@main struct Readback {
    static func attr(_ e: AXUIElement, _ k: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil
    }
    static func str(_ e: AXUIElement, _ k: String) -> String { attr(e, k) as? String ?? "" }
    static func main() {
        let wanted = CommandLine.arguments[1]
        var fields: [[String: String]] = [], texts: [String] = []
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(ax, 5)
            let windows = attr(ax, kAXWindowsAttribute) as? [AXUIElement] ?? []
            for w in windows where str(w, kAXTitleAttribute).contains(wanted) {
                var seen = 0
                func walk(_ e: AXUIElement, _ depth: Int) {
                    if seen > 4000 || depth > 40 { return }
                    seen += 1
                    let role = str(e, kAXRoleAttribute)
                    if [kAXTextFieldRole, kAXTextAreaRole].contains(role) {
                        fields.append(["role": role, "subrole": str(e, kAXSubroleAttribute),
                                       "name": str(e, kAXDescriptionAttribute) + str(e, kAXTitleAttribute),
                                       "value": String(str(e, kAXValueAttribute).prefix(120))])
                    }
                    if role == kAXStaticTextRole {
                        let t = str(e, kAXValueAttribute).trimmingCharacters(in: .whitespacesAndNewlines)
                        if !t.isEmpty, t.count < 60 { texts.append(t) }
                    }
                    for c in (attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? []) { walk(c, depth + 1) }
                }
                walk(w, 0)
                let out: [String: Any] = ["window": str(w, kAXTitleAttribute), "fields": fields,
                                          "texts": Array(texts.prefix(40))]
                print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
                return
            }
        }
        print("{\"error\":\"window_not_found\"}")
    }
}
