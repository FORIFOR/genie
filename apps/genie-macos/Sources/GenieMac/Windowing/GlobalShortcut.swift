import AppKit
import Carbon.HIToolbox

/// グローバルの音声ショートカット。どのアプリが前面でも Genie を起こす。正本 §3
/// 「Global voice shortcut / Global shortcut: CGEventTap」。既定は ⌥Space（Option+Space）。
///
/// **CGEventTap を使う**（正本指定の API）。セッションレベルの tap はハードウェアの押下も、
/// `CGEvent.post` された合成イベントも受け取る。これにより「登録」だけでなく
/// **「押下を受信して発火する」経路そのものを headless で実測できる**
/// （`--selftest shortcut` が合成 ⌥Space を注入して発火を確認する）。
/// tap は一致キーだけ consume（return nil）し、他のキーは素通しする。
///
/// CGEventTap は Accessibility(TCC) を要するが、Genie は §3「Accessibility integration」で
/// 既に AX 権限を使うため追加コストは無い。tap 生成に失敗（未許可）したら false を返し、
/// 呼び出し側が権限付与を促せる。
@MainActor
final class GlobalShortcut {
    static let shared = GlobalShortcut()

    /// 既定のキー（⌥Space）。keyCode 49 = Space。modifiers は Carbon ビット（label 表示と共用）。
    struct Combo {
        var keyCode: UInt32 = UInt32(kVK_Space)
        var modifiers: UInt32 = UInt32(optionKey)
    }

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var onFire: (() -> Void)?
    private var combo = Combo()
    /// 会話を始める 2 つ目のキー（既定 ⌥⇧Space）。同じ tap で受ける（許可は 1 つで足りる）。
    private var conversation: (combo: Combo, handler: () -> Void)?

    /// 会話のキー。⌥Space（録音）とは修飾が違うので取り違えない。
    static let conversationCombo = Combo(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey | shiftKey))

    /// 会話のキーを足す。録音のキーの登録（tap）に相乗りするので、`register` の前でも後でもよい。
    func setConversation(_ combo: Combo = GlobalShortcut.conversationCombo, handler: @escaping () -> Void) {
        conversation = (combo, handler)
    }

    /// ⌥Space を受け取れる状態か。tap を作れても、この許可が無ければ
    /// **イベントは 1 つも届かない**（黙って効かないショートカットになる）。
    /// Accessibility とは別の許可なので、`AXIsProcessTrusted()` では分からない。
    static var canListen: Bool { CGPreflightListenEventAccess() }

    /// 実際に登録できたか。**画面はこれを見る。**
    /// 権限の preflight が true でも登録に失敗することがあり、そのとき
    /// 「⌥Space」と案内すると、押しても何も起きない案内になる。
    private(set) var isRegistered = false

    /// 登録する。tap 生成に成功すれば true。押されると `handler` が MainActor で呼ばれる。
    @discardableResult
    func register(_ combo: Combo = Combo(), handler: @escaping () -> Void) -> Bool {
        unregister()
        // 許可が無いまま「登録できた」と言わない。届かないものを登録済みにすると、
        // 効かない理由が誰にも分からなくなる。
        guard Self.canListen else { return false }
        onFire = handler
        self.combo = combo

        let mask = (1 << CGEventType.keyDown.rawValue)
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,                 // active: 一致キーを consume できる
            eventsOfInterest: CGEventMask(mask),
            callback: { _, type, event, userData in
                guard let userData else { return Unmanaged.passUnretained(event) }
                let this = Unmanaged<GlobalShortcut>.fromOpaque(userData).takeUnretainedValue()
                if type == .keyDown {
                    let kc = event.getIntegerValueField(.keyboardEventKeycode)
                    if GlobalShortcut.matches(combo: this.combo, keyCode: kc, flags: event.flags) {
                        DispatchQueue.main.async { this.onFire?() }
                        return nil                // 自分のホットキーは飲み込む（他アプリへ流さない）
                    }
                    if let conversation = this.conversation,
                       GlobalShortcut.matches(combo: conversation.combo, keyCode: kc, flags: event.flags) {
                        DispatchQueue.main.async { conversation.handler() }
                        return nil
                    }
                }
                return Unmanaged.passUnretained(event)  // それ以外は素通し
            },
            userInfo: selfPtr
        ) else {
            return false   // tap 生成失敗（入力監視の許可が要る）
        }

        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        eventTap = tap
        runLoopSource = src
        // 作れても、OS がその場で落とすことがある（許可が古いと preflight は true の
        // まま tap だけ拒まれる。再ビルドで実行体が変わったときに実際に起きた）。
        // 有効になっていないなら「登録できた」と言わない —— 効かないショートカットを
        // 登録済みとして持つと、なぜ効かないのかが誰にも分からなくなる。
        guard CGEvent.tapIsEnabled(tap: tap) else {
            unregister()
            return false
        }
        isRegistered = true; return true
    }

    /// tap が実際に有効か。作れても OS 側で落とされることがある。
    var isTapEnabled: Bool {
        guard let eventTap else { return false }
        return CGEvent.tapIsEnabled(tap: eventTap)
    }

    func unregister() {
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
            self.runLoopSource = nil
        }
        eventTap = nil
        onFire = nil
    }

    /// Combo（Carbon modifier ビット）と実イベントの (keyCode, flags) が一致するか。
    /// 4 修飾（⌘⌥⌃⇧）だけを比較し、CapsLock/Fn 等は無視する。純関数（テスト可能）。
    static func matches(combo: Combo, keyCode: Int64, flags: CGEventFlags) -> Bool {
        guard keyCode == Int64(combo.keyCode) else { return false }
        var need: CGEventFlags = []
        if combo.modifiers & UInt32(cmdKey) != 0 { need.insert(.maskCommand) }
        if combo.modifiers & UInt32(optionKey) != 0 { need.insert(.maskAlternate) }
        if combo.modifiers & UInt32(controlKey) != 0 { need.insert(.maskControl) }
        if combo.modifiers & UInt32(shiftKey) != 0 { need.insert(.maskShift) }
        let compareMask: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]
        return flags.intersection(compareMask) == need
    }

    /// 人が読めるラベル（Settings/HUD 表示用）。
    static func label(_ combo: Combo = Combo()) -> String {
        var parts = ""
        if combo.modifiers & UInt32(cmdKey) != 0 { parts += "⌘" }
        if combo.modifiers & UInt32(optionKey) != 0 { parts += "⌥" }
        if combo.modifiers & UInt32(controlKey) != 0 { parts += "⌃" }
        if combo.modifiers & UInt32(shiftKey) != 0 { parts += "⇧" }
        let key = combo.keyCode == UInt32(kVK_Space) ? "Space" : "key\(combo.keyCode)"
        return parts + key
    }
}
