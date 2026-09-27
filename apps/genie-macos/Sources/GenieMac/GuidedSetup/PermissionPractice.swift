import AppKit
import ApplicationServices
import SwiftUI
import Vision

/// The first demonstration stays on this Mac: no model, upload, mail, or task submission.
@MainActor
final class PermissionPractice: NSObject, ObservableObject, NSWindowDelegate {
    static let shared = PermissionPractice()
    @Published private(set) var permission: GuidePermission = .screenCapture
    @Published private(set) var image: NSImage?
    @Published private(set) var text = ""
    @Published private(set) var status = ""
    @Published private(set) var isReadingScreen = false
    @Published private(set) var readingScreenID: UInt32?
    private var window: NSWindow?
    private var captureTask: Task<Void, Never>?
    private var generation = UUID()
    let input = NSTextField(string: "")

    static func use(_ permission: GuidePermission) {
        if permission == .microphone { VoiceHUDState.shared.beginConversation(); return }
        if PermissionManager.shared.state(of: permission) == .granted { shared.open(permission) }
        else { PermissionGuideCoordinator.shared.explain(permission) { shared.open(permission) } }
    }

    func open(_ permission: GuidePermission) {
        guard PermissionManager.shared.state(of: permission) == .granted else {
            PermissionGuideCoordinator.shared.explain(permission) { [weak self] in self?.open(permission) }
            return
        }
        clear()
        self.permission = permission
        input.stringValue = ""
        input.placeholderString = "Genieがこの欄だけに文字を入力します"
        input.setAccessibilityIdentifier("permissionControlField")
        input.setAccessibilityLabel("操作を試す練習用の入力欄")
        status = permission == .screenCapture ? "画面はまだ読み取っていません。" : "ほかのアプリには入力しません。"
        if window == nil {
            let win = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
            win.isReleasedWhenClosed = false
            win.delegate = self
            let host = NSHostingView(rootView: PermissionPracticeView(model: self))
            win.contentView = host
            win.setContentSize(host.fittingSize)
            win.center()
            window = win
        }
        window?.title = permission.capabilityTitle
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        resizeToContent()
        // Home's screen action or Ready's Try button is the explicit one-shot request.
        if permission == .screenCapture { readScreen() }
    }

    func readScreen() {
        guard !isReadingScreen, permission == .screenCapture else { return }
        guard Permissions.screenRecording == .granted else {
            status = "画面の許可が必要です。設定を案内します。"
            PermissionGuideCoordinator.shared.explain(.screenCapture) { [weak self] in self?.open(.screenCapture) }
            return
        }
        isReadingScreen = true
        readingScreenID = CGMainDisplayID()
        status = "画面を1枚読み取っています…"
        image = nil; text = ""
        let run = generation
        captureTask = Task { [weak self] in
            do {
                let frame = try await ScreenContextCapture.captureFrame(excludingBundleID: Bundle.main.bundleIdentifier)
                try Task.checkCancellation()
                let words = try await Task.detached(priority: .userInitiated) {
                    let request = VNRecognizeTextRequest()
                    request.recognitionLevel = .accurate
                    request.recognitionLanguages = ["ja-JP", "en-US"]
                    try VNImageRequestHandler(cgImage: frame).perform([request])
                    return request.results?.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n") ?? ""
                }.value
                try Task.checkCancellation()
                guard let self, self.generation == run else { return }
                self.image = NSImage(cgImage: frame, size: .zero)
                self.text = words
                self.resizeToContent()
                self.status = words.isEmpty ? "画面を確認しました。読み取れる文字は見つかりませんでした。" : "画面の文字を読み取りました。このMac内だけで処理しています。"
            } catch {
                guard let self, self.generation == run, !Task.isCancelled else { return }
                self.status = "画面を読み取れませんでした。許可を確認して、もう一度試せます。"
            }
            guard let self, self.generation == run else { return }
            self.isReadingScreen = false; self.readingScreenID = nil; self.captureTask = nil
        }
    }

    func practiceTyping() {
        guard permission == .accessibility, Permissions.accessibility == .granted else {
            status = "Macの操作の許可を確認できません。設定から再確認してください。"
            return
        }
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(input)
        // Own-process AX children are not consistently available. Resolve focus, then
        // require both our PID and this exact practice-field identifier before writing.
        guard let target = Dictation.focusedTextTarget(), Self.isPracticeTarget(target) else {
            status = "練習欄を確認できませんでした。入力せずに止めました。"
            return
        }
        let sample = "Genieと、このMacで作業できます。"
        let inserted = Dictation.insert(sample, into: target)
        var value: CFTypeRef?
        let read = AXUIElementCopyAttributeValue(target, kAXValueAttribute as CFString, &value)
        status = inserted && read == .success && (value as? String)?.contains(sample) == true
            ? "練習欄への入力を確認できました。" : "入力を確認できませんでした。自動では繰り返しません。"
    }

    static func isPracticeTarget(_ element: AXUIElement) -> Bool {
        var pid: pid_t = 0
        var identifier: CFTypeRef?
        return AXUIElementGetPid(element, &pid) == .success && pid == getpid()
            && AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &identifier) == .success
            && identifier as? String == "permissionControlField"
    }

    func suspendForPermissionGuide() -> () -> Void {
        guard let window, window.isVisible else { return {} }
        window.orderOut(nil)
        return { [weak window] in window?.orderFrontRegardless() }
    }

    private func resizeToContent() {
        DispatchQueue.main.async { [weak self] in
            guard let window = self?.window, let content = window.contentView else { return }
            content.layoutSubtreeIfNeeded()
            window.setContentSize(content.fittingSize)
        }
    }

    func finish() { window?.close() }
    func windowWillClose(_ notification: Notification) { clear() }

    private func clear() {
        generation = UUID()
        captureTask?.cancel(); captureTask = nil
        image = nil; text = ""; status = ""; input.stringValue = ""
        isReadingScreen = false; readingScreenID = nil
    }

    /// Deterministic own-window evidence. It cannot grant access or perform a capture.
    func configureForShot(_ permission: GuidePermission, image: NSImage? = nil, reading: Bool = false) {
        precondition(CommandLine.arguments.contains("--selftest"))
        clear()
        self.permission = permission
        self.image = image
        self.isReadingScreen = reading
        if permission == .screenCapture {
            text = image == nil ? "" : "チーム定例\n10:00 デザインの確認\n14:00 リリース準備"
            status = reading ? "画面を1枚読み取っています…" : "画面の文字を読み取りました。このMac内だけで処理しています。"
        } else {
            input.placeholderString = "Genieがこの欄だけに文字を入力します"
            status = "ほかのアプリには入力しません。"
        }
    }
}

private struct PracticeInput: NSViewRepresentable {
    let field: NSTextField
    func makeNSView(context: Context) -> NSTextField { field }
    func updateNSView(_ nsView: NSTextField, context: Context) {}
}

struct PermissionPracticeView: View {
    @ObservedObject var model: PermissionPractice
    var body: some View {
        VStack(alignment: .leading, spacing: Space.base) {
            Label(model.permission.capabilityTitle, systemImage: model.permission.symbol)
                .font(.system(size: S.type(TypeScale.cardTitleSize), weight: .semibold))
            Text(model.permission == .screenCapture ? "画面の文字を、このMacで読み取ってみましょう。" : "まずは、練習用の入力欄で試してみましょう。")
                .font(.system(size: S.type(TypeScale.secondarySize)))
            if model.permission == .screenCapture {
                if let image = model.image {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 160)
                        .accessibilityLabel("読み取った画面。外部送信なし")
                }
                ScrollView { Text(model.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .font(.system(size: S.type(TypeScale.secondarySize))).frame(height: 120)
                Text(model.status).font(.system(size: S.type(TypeScale.captionSize)))
                    .accessibilityIdentifier("screenReadingStatus")
                Button(model.isReadingScreen ? "読み取り中…" : "画面を1枚読み取る") { model.readScreen() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isReadingScreen)
                    .accessibilityIdentifier("permissionReadScreen")
            } else {
                PracticeInput(field: model.input).frame(height: 32)
                Text(model.status).font(.system(size: S.type(TypeScale.captionSize)))
                Button("練習欄に入力してみる") { model.practiceTyping() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("permissionPracticeControl")
            }
            Text("お試しの内容は保存・外部送信されません。閉じると破棄されます。")
                .font(.system(size: S.type(TypeScale.captionSize))).foregroundStyle(.secondary)
            Button("完了") { model.finish() }.keyboardShortcut(.cancelAction)
        }
        .padding(Space.largePadding)
        .frame(width: 460)
    }
}
