import AppKit
import ApplicationServices

/// アクセシビリティ文脈（AX）。前面アプリで選択中のテキストを読み、RAG/依頼の文脈にする。
/// 正本 §3「Accessibility integration」/ §5「見たものだけ・推測で埋めない」。
///
/// **注意**: 実データの取得はアクセシビリティ許可(TCC)が要る。許可が無ければ nil を返す
/// （**推測で埋めない**・クラッシュしない）。`AXIsProcessTrusted()` は prompt を出さず読めるので、
/// 許可状態の確認と「許可なし→nil」の経路は headless で検証できる。
enum AccessibilityContext {
    /// 許可済みか（prompt を出さない）。
    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// 前面で選択中のテキスト。許可が無い / 選択が無ければ nil。
    static func selectedText() -> String? {
        guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked, isTrusted else { return nil }
        let system = AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
                system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let element = focused
        else { return nil }
        // CFTypeRef を AXUIElement として扱う（同一 CF 型）。
        let axElement = element as! AXUIElement
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
                axElement, kAXSelectedTextAttribute as CFString, &value) == .success,
              let text = value as? String, !text.isEmpty
        else { return nil }
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return nil }
        return text
    }

    /// 前面アプリの窓のタイトル。許可が無ければ nil（推測で埋めない）。
    static func frontmostWindowTitle() -> String? {
        guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked, isTrusted, let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
        let app = AXUIElementCreateApplication(pid)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let w = window else { return nil }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success,
              let text = title as? String, !text.isEmpty
        else { return nil }
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return nil }
        return text
    }

    /// §8 の AXContext。取れたものだけ入れる（取れないものは nil のまま）。
    static func snapshot() -> AXContext? {
        guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked, let app = NSWorkspace.shared.frontmostApplication else { return nil }
        // 自分自身は文脈ではない。Genie が前面のときに「Genie を見ています」と出すと、
        // Context Strip が何も言っていないのと同じになる（実機で出た）。
        if app.bundleIdentifier == Bundle.main.bundleIdentifier { return nil }
        if app.localizedName == "Genie" { return nil }
        let context = AXContext(
            appName: app.localizedName ?? app.bundleIdentifier ?? "?",
            bundleId: app.bundleIdentifier,
            windowTitle: frontmostWindowTitle(),
            focusedRole: focusedRole(),
            selectedText: selectedText()
        )
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return nil }
        return context
    }

    /// focus している要素の role（AXTextField など）。
    static func focusedRole() -> String? {
        guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked, isTrusted else { return nil }
        let system = AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let element = focused else { return nil }
        var role: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element as! AXUIElement, kAXRoleAttribute as CFString, &role) == .success
        else { return nil }
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return nil }
        return role as? String
    }

    /// 選択テキストを RAG 候補にする（あれば 1 件）。source は .message（外から来た文脈）。
    static func candidate(now: Date = Date()) -> [ContextCandidateLite] {
        guard let text = selectedText() else { return [] }
        return [ContextCandidateLite(id: "ax.selection", text: text)]
    }
}

/// §8 のデータモデル。取れなかった項目は nil のままにする（推測で埋めない）。
struct AXContext: Equatable {
    let appName: String
    let bundleId: String?
    let windowTitle: String?
    let focusedRole: String?
    let selectedText: String?

    /// §7/§25 の文脈へ詰め替える。出所は accessibility、機微度は選択の有無で分ける。
    func fact(now: Date = Date(), ttl: TimeInterval = 60) -> ContextFact {
        let summary = selectedText.map { "選択: \($0.prefix(120))" }
            ?? windowTitle.map { "画面: \($0)" }
            ?? "アプリ: \(appName)"
        return ContextFact(
            source: .accessibility,
            application: appName,
            sensitivity: selectedText == nil ? .workspace : .personal,
            summary: summary,
            capturedAt: now,
            expiresAt: now.addingTimeInterval(ttl)
        )
    }
}

/// AX 由来の軽量候補（core の ContextCandidate へ詰め替える前段。source/age は呼び出し側で決める）。
struct ContextCandidateLite {
    let id: String
    let text: String
}
