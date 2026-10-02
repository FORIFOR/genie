//  対象を指定した背景マウス／キー入力。
//
//  ここは**配送手段**だけを持つ。誰に送ってよいかの判断（承認・対象・停止）は
//  呼び出し側（BackgroundAX.permitted）が済ませている前提で、この層は持たない。
//  共有カーソルを動かさない・前面を上げない・クリップボードを使わない・
//  グローバル HID へ逃げない。できなければ送らずに理由を返す。
import AppKit
import CoreGraphics

enum NativeInput {
    /// 1 操作の配送結果。**送っていない**と**送ったが効果は未確認**を混ぜない。
    enum Outcome {
        case notSent(String)   // 理由コード。別経路を選び直してよいのはここだけ。
        case attempted         // 送信した。効果の確認は呼び出し側の再観測で行う。
        case interrupted       // 一部を送った後で停止した。結果は未確認で、再送してはいけない。
    }

    /*
     * US 配列のキーコード。ローマ字入力の練習サイトは物理キーで判定するため、
     * 文字を「値の設定」で置き換えず、押下／解放をそのまま送る。
     * Enter・Tab 以外の制御、修飾キー、ファンクションキーは**持たない**。
     * 持たないことが許可リストであり、増やすときは明示的に足す。
     */
    static let keyCodes: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
        "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
        "`": 50, " ": 49,
    ]
    /// 名前で指定できるキー。`SPACE` はここで初めて許す。Enter は依然として持たない。
    static let namedKeys: [String: CGKeyCode] = [
        "TAB": 48, "ESC": 53, "LEFT": 123, "RIGHT": 124, "UP": 126, "DOWN": 125, "SPACE": 49,
    ]

    static func keyCode(forName name: String) -> CGKeyCode? { namedKeys[name] }
    /// その文字列を、この経路の物理キーだけで打てるか。打てない文字が 1 つでもあれば打たない。
    static func typable(_ text: String) -> Bool {
        !text.isEmpty && text.lowercased().allSatisfy { keyCodes[$0] != nil }
    }

    /*
     * 背面のウィンドウへのクリック。
     * 先行 mouseMoved は飾りではない——背面の窓は cursor tracking が古いままで、
     * これが無いと合成 mouseDown が控えの外に落ち、NSButton が発火しない。
     */
    @MainActor
    static func click(pid: pid_t, window: UInt32, screen: CGPoint, local: CGPoint,
                      stillAllowed: () -> Bool) async -> Outcome {
        guard !Task.isCancelled, stillAllowed() else { return .notSent("session_stopped") }
        guard PrivateSPI.available else { return .notSent("background_spi_unavailable") }
        guard PrivateSPI.focusWithoutRaise(pid: pid, window: window) else { return .notSent("background_spi_unavailable") }
        let source = CGEventSource(stateID: .hidSystemState)
        let group = Int64(Date().timeIntervalSince1970 * 1000) & 0x7fff_ffff
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: screen, mouseButton: .left),
              let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: screen, mouseButton: .left),
              let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: screen, mouseButton: .left)
        else { return .notSent("background_event_unavailable") }
        // 人が押している修飾キーを引き継がない。対象へ送る状態はこちらで決める。
        for event in [move, down, up] { event.flags = [] }
        guard !Task.isCancelled, stillAllowed() else { return .notSent("session_stopped") }
        PrivateSPI.postMouse(move, pid: pid, window: window, local: local, clickState: 0, button: 0, clickGroup: group)
        try? await Task.sleep(nanoseconds: 40_000_000)
        // hover を届けて待つ間にも停止は来る。押下の直前に再確認する。
        guard !Task.isCancelled, stillAllowed() else { return .notSent("session_stopped") }
        PrivateSPI.postMouse(down, pid: pid, window: window, local: local, clickState: 1, button: 0, clickGroup: group)
        try? await Task.sleep(nanoseconds: 50_000_000)
        // 押したボタンの解放だけは、停止していても同じ対象へ届ける。
        PrivateSPI.postMouse(up, pid: pid, window: window, local: local, clickState: 1, button: 0, clickGroup: group)
        guard !Task.isCancelled, stillAllowed() else { return .interrupted }
        return .attempted
    }

    /*
     * キーの押下／解放。`stillAllowed` は 1 打ごとに呼ばれ、停止・対象変更を見る。
     * 途中で止めるときは、**押した鍵だけ**を同じ対象へ解放する。
     * 全体へ修飾キー解除を撒くと人の入力に干渉するので、やらない。
     */
    @MainActor
    static func keys(_ codes: [CGKeyCode], pid: pid_t, window: UInt32,
                     stillAllowed: () -> Bool) async -> Outcome {
        guard !Task.isCancelled, stillAllowed() else { return .notSent("session_stopped") }
        guard PrivateSPI.available else { return .notSent("background_key_route_unavailable") }
        guard !codes.isEmpty else { return .notSent("policy_text_rejected") }
        guard PrivateSPI.focusWithoutRaise(pid: pid, window: window) else { return .notSent("background_spi_unavailable") }
        let source = CGEventSource(stateID: .hidSystemState)
        var sentAny = false
        for code in codes {
            guard !Task.isCancelled, stillAllowed() else { return sentAny ? .interrupted : .notSent("session_stopped") }
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
            else { return sentAny ? .interrupted : .notSent("background_event_unavailable") }
            down.flags = []; up.flags = []
            PrivateSPI.postKey(down, pid: pid)
            sentAny = true
            try? await Task.sleep(nanoseconds: 30_000_000)
            // 解放は必ず出す。停止が挟まっても押しっぱなしにしない。
            PrivateSPI.postKey(up, pid: pid)
            try? await Task.sleep(nanoseconds: 40_000_000)
            guard !Task.isCancelled, stillAllowed() else { return .interrupted }
        }
        return .attempted
    }
}
