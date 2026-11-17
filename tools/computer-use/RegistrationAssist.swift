import AppKit
import ApplicationServices
import Foundation

/// The parser operates on native observations, never model-provided field names.
/// Values are reduced to emptiness before entering this policy.
enum RegistrationFieldPolicy {
    struct Field {
        let role: String, subrole: String
        let labels: [String]
        let empty: Bool?, enabled: Bool, settable: Bool, visible: Bool
        let form: [Int]?
    }
    struct Pair: Equatable { let email: Int, password: Int, emailLabel: String }
    static func emailLabel(_ labels: [String]) -> String? {
        let accepted = ["email", "e-mail", "email address", "e-mail address", "メールアドレス", "eメールアドレス"]
        return labels.first { label in
            let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return accepted.contains(normalized)
        }
    }
    static func select(_ fields: [Field]) -> Pair? {
        // Additional text inputs (including a repeated password or a search field)
        // make this minimal adapter unsupported. Do not choose a plausible pair.
        guard fields.count == 2,
              fields.allSatisfy({ $0.role == "AXTextField" && $0.empty == true && $0.enabled && $0.settable && $0.visible })
        else { return nil }
        let passwords = fields.indices.filter { fields[$0].subrole == "AXSecureTextField" }
        guard passwords.count == 1 else { return nil }
        let password = passwords[0], email = 1 - password
        guard ["", "AXEmailField"].contains(fields[email].subrole),
              let label = emailLabel(fields[email].labels), fields[email].form == fields[password].form
        else { return nil }
        return Pair(email: email, password: password, emailLabel: label)
    }
}

/// Explicit ordering is shared with the fault-injection tests. These closures
/// never enter the helper protocol and do not receive or return secret values.
enum RegistrationFillSequence {
    static func run(validate: () throws -> Void, lock: () throws -> Void,
                    email: () throws -> Void, passwordTarget: () throws -> Void,
                    password: () throws -> Void, finish: () throws -> Void) throws {
        try validate()
        try lock()
        try validate()
        try email()
        try passwordTarget()
        try password()
        try finish()
    }
}

/// No generation, storage or input happens before the separate native consent.
/// Kept separate from generic type/preview, which must never receive a secret.
@available(macOS 14.4, *) @MainActor
enum RegistrationAssist {
    struct Candidate {
        let element: AXUIElement, path: [Int], observation: RegistrationFieldPolicy.Field
    }
    struct Form {
        let email: Candidate, password: Candidate, area: AXUIElement, label: String
    }
    struct Receipt: Encodable {
        let status = "awaiting_user_registration"
        let credentialRef: String
    }

    static func prepare(_ request: Request) throws -> Data {
        do { return try prepareValidated(request) }
        catch let error as RegistrationVault.VaultError { throw Failure(error.rawValue) }
    }

    private static func prepareValidated(_ request: Request) throws -> Data {
        guard request.op == "registration_prepare", request.action == nil,
              request.outputPath == nil, request.goal == nil,
              let frame = request.scope, let reference = request.referencePath,
              let allowed = request.allowedOrigins, allowed == ["https://www.mcdonalds.co.jp"],
              BackgroundDocumentOrigin.valid(allowed), frame.allowedOrigins == allowed,
              frame.documentOrigin == allowed[0],
              let expires = request.authorizationExpiresAt, expires.isFinite,
              expires > Date().timeIntervalSince1970 * 1000,
              Date().timeIntervalSince1970 * 1000 - frame.capturedAt <= 60_000,
              URL(fileURLWithPath: reference).lastPathComponent == "\(frame.id).png"
        else { throw Failure("registration_invalid_request") }
        // Limited first-party rollout. A host or model cannot expand this native
        // operation to another origin or prompt for an email on an unsigned build.
        try RegistrationVault.verifyOwnSignature()
        let dir = URL(fileURLWithPath: reference).deletingLastPathComponent()
        let session = try BackgroundAX.sessionPath(dir, frame.backgroundSession ?? "")
        let snapshot = try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self, reference + ".snapshot.json")
        guard snapshot.frame.id == frame.id, snapshot.frame.sha256 == frame.sha256,
              snapshot.frame.pid == frame.pid, snapshot.frame.windowId == frame.windowId,
              snapshot.frame.bundleId == frame.bundleId, snapshot.frame.bounds == frame.bounds,
              snapshot.frame.backgroundSession == frame.backgroundSession,
              snapshot.frame.backgroundEpoch == frame.backgroundEpoch,
              snapshot.frame.documentOrigin == frame.documentOrigin,
              snapshot.frame.allowedOrigins == frame.allowedOrigins,
              snapshot.frame.capturedAt == frame.capturedAt
        else { throw Failure("registration_stale_form") }
        func current() throws -> Target {
            guard expires > Date().timeIntervalSince1970 * 1000 else { throw Failure("registration_consent_expired") }
            let target = try BackgroundAX.permitted(frame, dir: dir)
            guard try BackgroundAX.generation(target.pid, bundle: target.bundleId) == snapshot.generation,
                  (frame.backgroundEpoch ?? 0) == BackgroundAX.epoch(session),
                  try BackgroundAX.documentOrigin(in: target, allowed: allowed) == allowed[0]
            else { throw Failure("registration_stale_form") }
            let activity = try BackgroundAX.readPrivate(BackgroundAX.Activity.self, session + ".activity")
            guard activity.expires > Date().timeIntervalSince1970 else { throw Failure("registration_consent_expired") }
            return target
        }
        let initial = try current()
        try RegistrationCapturePrivacy.requireUnblocked(initial)
        let form = try inspect(initial, origin: allowed[0], allowed: allowed)
        let email = try consent(origin: allowed[0], fieldLabel: form.label)
        _ = try RegistrationVault.account(origin: allowed[0], email: email)
        let target = try current()
        try RegistrationCapturePrivacy.requireUnblocked(target)
        try requireSameForm(form, target: target, origin: allowed[0], allowed: allowed)

        // An add-only Keychain save succeeds before any page value is changed.
        // A failure after saving keeps the credential and never retries the fill.
        let stored = try RegistrationVault.generateAndStore(origin: allowed[0], email: email)
        do {
            try RegistrationFillSequence.run(validate: {
                try requireSameForm(form, target: current(), origin: allowed[0], allowed: allowed)
            }, lock: {
                try RegistrationCapturePrivacy.block(current())
            }, email: {
                guard AXUIElementSetAttributeValue(form.email.element, kAXValueAttribute as CFString, email as CFTypeRef) == .success,
                      BackgroundAX.attribute(form.email.element, kAXValueAttribute) as? String == email
                else { throw Failure("registration_input_unconfirmed") }
            }, passwordTarget: {
                try requireElement(form.password, target: current(), area: form.area, secure: true, empty: true,
                                   origin: allowed[0], allowed: allowed)
            }, password: {
                // Direct AX value assignment only: no coordinates, keyboard events,
                // clipboard, generic proposed-text verifier or value logging.
                guard AXUIElementSetAttributeValue(form.password.element, kAXValueAttribute as CFString, stored.secret as CFTypeRef) == .success,
                      BackgroundAX.string(form.password.element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole,
                      (BackgroundAX.attribute(form.password.element, kAXNumberOfCharactersAttribute) as? NSNumber)?.intValue == RegistrationVault.passwordLength
                else { throw Failure("registration_input_unconfirmed") }
            }, finish: {
                // No password value read-back, no screenshot, no submit/terms/OTP.
                _ = try current()
            })
            return try JSONEncoder().encode(Receipt(credentialRef: stored.reference))
        } catch { throw Failure("registration_input_unconfirmed") }
    }

    static func inspect(_ target: Target, origin: String, allowed: [String]) throws -> Form {
        guard try BackgroundAX.documentOrigin(in: target, allowed: allowed) == origin else { throw Failure("registration_stale_form") }
        var candidates: [Candidate] = [], visited = 0
        func visit(_ element: AXUIElement, _ path: [Int], _ form: [Int]?) throws {
            visited += 1
            guard visited <= 2000, path.count <= 30 else { throw Failure("registration_form_unsupported") }
            let role = BackgroundAX.string(element, kAXRoleAttribute)
            let tag = BackgroundAX.string(element, "AXDOMTagName").lowercased()
            let currentForm = role == "AXForm" || tag == "form" ? path : form
            if ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) {
                var settable: DarwinBoolean = false
                let writable = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
                let value = BackgroundAX.attribute(element, kAXValueAttribute) as? String
                var labels = [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute].map { BackgroundAX.string(element, $0) }
                if let raw = BackgroundAX.attribute(element, kAXTitleUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
                    let label = raw as! AXUIElement
                    if BackgroundAX.string(label, kAXRoleAttribute) == kAXStaticTextRole {
                        labels += [BackgroundAX.string(label, kAXValueAttribute), BackgroundAX.string(label, kAXTitleAttribute)]
                    }
                }
                let rect = Helper.elementRect(element)
                let visible = (rect.map { $0.width > 2 && $0.height > 2 && target.bounds.rect.contains($0) } ?? false)
                    && BackgroundAX.attribute(element, "AXHidden") as? Bool != true
                    && exposed(element, in: target)
                if visible { candidates.append(Candidate(element: element, path: path, observation: RegistrationFieldPolicy.Field(
                    role: role, subrole: BackgroundAX.string(element, kAXSubroleAttribute), labels: labels,
                    empty: value.map { $0.isEmpty }, enabled: BackgroundAX.attribute(element, kAXEnabledAttribute) as? Bool == true,
                    settable: writable, visible: visible, form: currentForm))) }
            }
            for (index, child) in BackgroundAX.children(element).enumerated() { try visit(child, path + [index], currentForm) }
        }
        // Only the WebArea is scanned: browser address/search chrome is excluded.
        // Origin inspection above rejects a second, nested or exposed opaque frame.
        let window = try BackgroundAX.window(target)
        var areas: [(AXUIElement, [Int])] = [], areaVisited = 0
        func findArea(_ element: AXUIElement, _ path: [Int]) throws {
            areaVisited += 1
            guard path.count <= 30, areas.count <= 1, areaVisited <= 2000 else { throw Failure("registration_form_unsupported") }
            if BackgroundAX.string(element, kAXRoleAttribute) == "AXWebArea" { areas.append((element, path)); return }
            for (index, child) in BackgroundAX.children(element).enumerated() { try findArea(child, path + [index]) }
        }
        try findArea(window, [])
        guard areas.count == 1 else { throw Failure("registration_form_unsupported") }
        try visit(areas[0].0, areas[0].1, nil)
        guard let pair = RegistrationFieldPolicy.select(candidates.map(\.observation)) else { throw Failure("registration_form_unsupported") }
        let form = Form(email: candidates[pair.email], password: candidates[pair.password], area: areas[0].0, label: pair.emailLabel)
        try requireElement(form.email, target: target, area: form.area, secure: false, empty: true, origin: origin, allowed: allowed)
        try requireElement(form.password, target: target, area: form.area, secure: true, empty: true, origin: origin, allowed: allowed)
        return form
    }

    private static func requireSameForm(_ original: Form, target: Target, origin: String, allowed: [String]) throws {
        let fresh = try inspect(target, origin: origin, allowed: allowed)
        guard original.email.path == fresh.email.path, original.password.path == fresh.password.path,
              CFEqual(original.email.element, fresh.email.element), CFEqual(original.password.element, fresh.password.element),
              CFEqual(original.area, fresh.area), original.label == fresh.label
        else { throw Failure("registration_stale_form") }
    }
    private static func requireElement(_ candidate: Candidate, target: Target, area: AXUIElement,
                                       secure: Bool, empty: Bool, origin: String, allowed: [String]) throws {
        let resolved = try BackgroundAX.resolve(candidate.path, in: target)
        var pid: pid_t = 0, settable: DarwinBoolean = false
        guard CFEqual(resolved, candidate.element), AXUIElementGetPid(resolved, &pid) == .success, pid == target.pid,
              let currentArea = BackgroundAX.topWebArea(containing: resolved), CFEqual(currentArea, area),
              BackgroundAX.string(resolved, kAXRoleAttribute) == kAXTextFieldRole,
              (secure ? BackgroundAX.string(resolved, kAXSubroleAttribute) == kAXSecureTextFieldSubrole
                      : ["", "AXEmailField"].contains(BackgroundAX.string(resolved, kAXSubroleAttribute))),
              BackgroundAX.attribute(resolved, kAXEnabledAttribute) as? Bool == true,
              AXUIElementIsAttributeSettable(resolved, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
              let rect = Helper.elementRect(resolved), rect.width > 2, rect.height > 2, target.bounds.rect.contains(rect),
              exposed(resolved, in: target),
              !empty || (BackgroundAX.attribute(resolved, kAXValueAttribute) as? String) == ""
        else { throw Failure("registration_stale_form") }
        try BackgroundAX.requireDocumentTarget(resolved, in: target, origin: origin, allowed: allowed)
    }

    /// Native hit testing is observation only. Hidden background form fields and
    /// fields covered by a modal are not eligible, even if their old rect remains.
    private static func exposed(_ element: AXUIElement, in target: Target) -> Bool {
        guard let rect = Helper.elementRect(element) else { return false }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(target.pid), Float(rect.midX), Float(rect.midY), &hit) == .success,
              var current = hit else { return false }
        for _ in 0..<30 {
            if CFEqual(current, element) { return true }
            guard let parent = BackgroundAX.attribute(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID()
            else { return false }
            current = parent as! AXUIElement
        }
        return false
    }

    private static func consent(origin: String, fieldLabel: String) throws -> String {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 26))
        field.placeholderString = "登録するメールアドレス"
        field.setAccessibilityLabel("登録するメールアドレス")
        let alert = NSAlert()
        alert.messageText = "登録用のパスワードを作成しますか？"
        alert.informativeText = "対象サイト: \(origin)\n入力欄: \(fieldLabel) とパスワード\n\n入力したメールアドレスと新しいパスワードをこの Mac のキーチェーンに保存して、このサイトの空欄に入力します。パスワードは AI に送りません。\n\n登録ボタン、規約の確認、認証コードはご自身で進めてください。入力後はこのブラウザ全体の画像取得を停止します。AI の操作を再開するには、登録を終えた後にブラウザを終了して、起動し直してください。窓を閉じるだけでは解除されません。"
        alert.accessoryView = field
        let save = alert.addButton(withTitle: "保存して入力")
        let cancel = alert.addButton(withTitle: "キャンセル")
        // Standard NSAlert styling; preserve the product's deliberate ⌘Return
        // boundary. An ordinary Return must not generate/store/fill a credential.
        save.keyEquivalent = "\r"; save.keyEquivalentModifierMask = [.command]
        cancel.keyEquivalent = "\u{1b}"; cancel.keyEquivalentModifierMask = []
        alert.window.defaultButtonCell = cancel.cell as? NSButtonCell
        alert.window.initialFirstResponder = field
        // Use the existing consent-window visibility pattern. Only this helper's
        // alert is raised; the bound browser is never activated here.
        NSApp.activate()
        alert.window.level = .modalPanel
        alert.window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        alert.window.orderFrontRegardless()
        guard alert.runModal() == .alertFirstButtonReturn else { throw Failure("registration_cancelled") }
        return field.stringValue
    }
}
