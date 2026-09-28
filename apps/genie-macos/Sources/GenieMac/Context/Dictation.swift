import AppKit
import ApplicationServices

/// UI/UX テスト仕様 v1.0 HUD-004「TextField-aware dictation」/ P0-2「全アプリ音声入力」。
///
/// 前面アプリのフォーカス中テキスト欄に、認識した文字を**そのまま入れる**。
/// ここが Genie の中核で、「Agent 会話を勝手に始めない」ことが PASS 条件。
///
/// 入力欄が無い（デスクトップ等）ときは `insert` が false を返す。呼び出し側はその時だけ
/// Ask Genie へ回す（Context-aware Voice Routing）。**推測で会話を始めない。**
enum Dictation {
    /// フォーカス中の要素が「テキストを受け取れる」か。
    /// AX の role と、値の設定可否（`AXUIElementIsAttributeSettable`）で判定する。
    ///
    /// `appPID`: 音声入力を始めたときに前面にあったアプリ。渡されたら**そのアプリの**フォーカス中の欄を見る。
    /// system-wide で聞くと、Dock（Genie の窓）がキーになっている間は Genie 自身の欄が返り、
    /// 「欄が見つからない」になっていた（2026-09-28 実機。前面のアプリの欄は開いていた）。
    static func focusedTextTarget(excludingOwnProcess: Bool = false, appPID: pid_t? = nil) -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }
        let owner = appPID.map { AXUIElementCreateApplication($0) } ?? AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(owner, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let element = focused
        else { return nil }
        let axElement = element as! AXUIElement

        if excludingOwnProcess {
            var pid: pid_t = 0
            if AXUIElementGetPid(axElement, &pid) == .success, pid == getpid() {
                return nil
            }
        }

        // 値を書き換えられない要素（ボタン等）は対象外。
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(axElement, kAXValueAttribute as CFString, &settable) == .success,
              settable.boolValue
        else { return nil }

        // テキストを持つ role だけに限る。role が取れないものは触らない。
        var roleRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axElement, kAXRoleAttribute as CFString, &roleRef) == .success,
              let role = roleRef as? String
        else { return nil }
        let textRoles: Set<String> = [
            kAXTextFieldRole as String, kAXTextAreaRole as String, kAXComboBoxRole as String,
        ]
        return textRoles.contains(role) ? axElement : nil
    }

    /// 認識文字をフォーカス中の入力欄へ入れる。入れられたら true。
    ///
    /// 選択範囲があればそこを置換、無ければキャレット位置へ挿入する（既存の文章を壊さない）。
    /// 検査専用: 設定すると、前面のアプリの欄へは**打ち込まず**、入れようとした文を知らせるだけにする。
    /// 自動検査が本人のターミナルやエディタへ文字を打ち込まないため。本番では nil。
    /// 戻り値は「入れる先があったか」（false で入力欄が無い場合を検査できる）。
    @MainActor static var dryRun: ((String) -> Bool)?

    @discardableResult
    static func insert(_ text: String, excludingOwnProcess: Bool = false, appPID: pid_t? = nil) -> Bool {
        if let dryRun = MainActor.assumeIsolated({ Self.dryRun }) {
            guard !text.isEmpty else { return false }
            return MainActor.assumeIsolated { dryRun(text) }
        }
        guard !text.isEmpty else { return false }
        if let target = focusedTextTarget(excludingOwnProcess: excludingOwnProcess, appPID: appPID)
            ?? (appPID != nil ? focusedTextTarget(excludingOwnProcess: excludingOwnProcess) : nil),
           insertVerified(text, into: target) {
            MainActor.assumeIsolated { lastInsertMethod = .accessibility }
            return true
        }
        // 値を書き換えられない欄（ターミナル・ブラウザ・Electron のエディタ等）は、キー入力として打つ。
        // 以前はここで諦め、文字起こしはできているのに見えている画面へ入らなかった（2026-09-28 実機、ターミナル）。
        guard let pid = appPID ?? MainActor.assumeIsolated({ frontmostOtherAppPID() }),
              acceptsTyping(appPID: pid), type(text, to: pid) else { return false }
        MainActor.assumeIsolated { lastInsertMethod = .typed(pid) }
        return true
    }

    /// 値を書き換えて入れ、**入ったことを読み戻して確かめる**。書き換えを「成功」と返して何もしない欄がある
    /// （検査用の欄で実際にそうなった）。読み戻せない欄は、書き換えの結果を信じる。
    static func insertVerified(_ text: String, into target: AXUIElement) -> Bool {
        func value() -> String? {
            var ref: CFTypeRef?
            guard AXUIElementCopyAttributeValue(target, kAXValueAttribute as CFString, &ref) == .success else { return nil }
            return ref as? String
        }
        let before = value()
        guard insert(text, into: target) else { return false }
        guard let before, let after = value() else { return true }
        return after != before && after.contains(text)
    }

    enum InsertMethod: Equatable { case accessibility, typed(pid_t) }
    /// 直前に入れた方法（「元の文に戻す」が、値の差し替えか打ち直しかを選ぶ）。
    @MainActor static var lastInsertMethod: InsertMethod?

    /// フォーカス中の要素が、値は書き換えられないが文字を受け取る欄か（ターミナルの本文・Web の入力欄など）。
    static func acceptsTyping(appPID: pid_t) -> Bool {
        guard AXIsProcessTrusted() else { return false }
        let app = AXUIElementCreateApplication(appPID)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let element = focused else { return false }
        let e = element as! AXUIElement
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &roleRef)
        let role = roleRef as? String ?? ""
        let textRoles: Set<String> = [kAXTextFieldRole as String, kAXTextAreaRole as String, kAXComboBoxRole as String]
        if textRoles.contains(role) { return true }
        // role が汎用（AXGroup 等）でも、選択範囲（キャレット）を持つなら文字を受け取る欄（contenteditable など）。
        var range: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, kAXSelectedTextRangeAttribute as CFString, &range) == .success && range != nil
    }

    /// 文字をキー入力として打つ（Unicode をそのまま渡すので、日本語入力の変換を通らない）。
    static func type(_ text: String, to pid: pid_t) -> Bool {
        guard AXIsProcessTrusted(), let source = CGEventSource(stateID: .hidSystemState) else { return false }
        let units = Array(text.utf16)
        var i = 0
        while i < units.count {
            // 1 回に渡せる長さには上限がある（20 前後）。サロゲートの途中で切らない。
            var end = min(i + 16, units.count)
            if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
            let chunk = Array(units[i..<end])
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return false }
            chunk.withUnsafeBufferPointer { p in
                down.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress)
                up.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress)
            }
            down.postToPid(pid)
            up.postToPid(pid)
            usleep(8_000)
            i = end
        }
        return true
    }

    /// 打った文を消す（「元の文に戻す」: 入れた直後だけ）。文字数ぶん後退する。
    static func deleteTyped(_ text: String, from pid: pid_t) -> Bool {
        guard AXIsProcessTrusted(), let source = CGEventSource(stateID: .hidSystemState) else { return false }
        for _ in 0..<text.count {
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: false) else { return false }
            down.postToPid(pid); up.postToPid(pid)
            usleep(6_000)
        }
        return true
    }

    /// 入れた文を、元の文へ戻す（「元の文に戻す」）。その欄の値の中で、最後に入れた文を探して差し替える。
    /// 戻せなければ false（入れた先で ⌘Z を押してもらう）。
    static func replaceInserted(_ inserted: String, with original: String, appPID: pid_t?) -> Bool {
        // 打って入れた欄は値を書き換えられない。打った文字数ぶん消して、元の文を打ち直す。
        if case .typed(let pid)? = MainActor.assumeIsolated({ lastInsertMethod }) {
            return deleteTyped(inserted, from: pid) && type(original, to: pid)
        }
        guard AXIsProcessTrusted(), !inserted.isEmpty,
              let target = focusedTextTarget(excludingOwnProcess: true, appPID: appPID) else { return false }
        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(target, kAXValueAttribute as CFString, &valueRef) == .success,
              let current = valueRef as? String,
              let range = current.range(of: inserted, options: .backwards) else { return false }
        let next = current.replacingCharacters(in: range, with: original)
        guard AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, next as CFTypeRef) == .success else { return false }
        var checkRef: CFTypeRef?
        AXUIElementCopyAttributeValue(target, kAXValueAttribute as CFString, &checkRef)
        return (checkRef as? String) == next
    }

    /// 音声入力を始めたときの前面のアプリ（Genie 自身は除く）。入れる先はここで決める。
    @MainActor static func frontmostOtherAppPID() -> pid_t? {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid() else { return nil }
        return app.processIdentifier
    }

    /// Use an explicitly verified target when a local practice field owns the operation.
    static func insert(_ text: String, into target: AXUIElement) -> Bool {
        guard AXIsProcessTrusted(), !text.isEmpty else { return false }
        // 選択範囲があるなら、そこへ差し替えるのが最も素直（AXSelectedText）。
        var selectedRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(target, kAXSelectedTextAttribute as CFString, &selectedRef) == .success,
           selectedRef as? String != nil {
            if AXUIElementSetAttributeValue(target, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success {
                return true
            }
        }

        // 選択が使えない実装向け: 全体値の読み書きでキャレット位置へ挿入する。
        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(target, kAXValueAttribute as CFString, &valueRef) == .success,
              let current = valueRef as? String
        else { return false }

        // AX の位置は UTF-16 単位。String.count（書記素数）では絵文字以降がずれる。
        var selection = CFRange(location: current.utf16.count, length: 0)
        var rangeRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(target, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
           let axValue = rangeRef, CFGetTypeID(axValue) == AXValueGetTypeID() {
            var range = CFRange(location: 0, length: 0)
            if AXValueGetValue(axValue as! AXValue, .cfRange, &range) {
                selection = range
            }
        }
        guard let merged = replacingSelection(in: current, range: selection, with: text),
              AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, merged as CFTypeRef) == .success
        else { return false }
        var nextCaret = CFRange(location: selection.location + text.utf16.count, length: 0)
        if let value = AXValueCreate(.cfRange, &nextCaret) {
            _ = AXUIElementSetAttributeValue(target, kAXSelectedTextRangeAttribute as CFString, value)
        }
        return true
    }

    /// AXSelectedText が書けない入力欄でも、選択部分を残さず正しい位置に置換する。
    static func replacingSelection(in current: String, range: CFRange, with text: String) -> String? {
        let count = current.utf16.count
        guard range.location >= 0, range.length >= 0, range.location <= count,
              range.length <= count - range.location
        else { return nil }
        let units = current.utf16
        let start = units.index(units.startIndex, offsetBy: range.location)
        let end = units.index(start, offsetBy: range.length)
        guard start.samePosition(in: current.unicodeScalars) != nil,
              end.samePosition(in: current.unicodeScalars) != nil,
              let indices = Range(NSRange(location: range.location, length: range.length), in: current)
        else { return nil }
        return current.replacingCharacters(in: indices, with: text)
    }
}
