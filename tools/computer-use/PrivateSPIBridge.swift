//  非公開 SPI への依存を、このファイルだけに閉じ込める。
//
//  ここが唯一の非公開 API 接点。他のファイルは `PrivateSPI.available` と
//  ここが公開する 3 つの操作しか知らない。Mac App Store 向けビルドは
//  `GENIE_PRIVATE_SPI` を定義せずにこのファイルを外す（審査条件 2.5.1 は
//  公開 API のみを求めるため、このビルドは直接配布専用）。
//
//  経路の出所: trycua/cua @83f142c4290a0f7d9ed545ae8532858c6e4f8145
//  libs/cua-driver/rust/crates/platform-macos/src/input/{skylight,mouse,keyboard}.rs（MIT）
//  実測（macOS 26.6.2 / SIP 有効）で必要と分かった刻印だけを持ち込み、
//  認証メッセージ経路は **今回不要だったので持ち込まない**。
import AppKit
import CoreGraphics

enum PrivateSPI {
#if GENIE_PRIVATE_SPI
    private typealias PostToPidFn   = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Void
    private typealias SetIntFieldFn = @convention(c) (UnsafeMutableRawPointer?, UInt32, Int64) -> Void
    private typealias SetWinLocFn   = @convention(c) (UnsafeMutableRawPointer?, Double, Double) -> Void
    private typealias PostRecordFn  = @convention(c) (UnsafeRawPointer?, UnsafePointer<UInt8>?) -> Int32
    private typealias GetFrontFn    = @convention(c) (UnsafeMutableRawPointer?) -> Int32
    private typealias ConnIDFn      = @convention(c) () -> UInt32
    private typealias WinOwnerFn    = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>?) -> Int32
    private typealias ConnPSNFn     = @convention(c) (UInt32, UnsafeMutableRawPointer?) -> Int32

    private struct Symbols {
        let post: PostToPidFn, setField: SetIntFieldFn, setLoc: SetWinLocFn
        let postRecord: PostRecordFn, front: GetFrontFn
        let connId: ConnIDFn, owner: WinOwnerFn, connPSN: ConnPSNFn
    }
    private static let symbols: Symbols? = {
        _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        func find<T>(_ name: String, _ type: T.Type) -> T? {
            dlsym(UnsafeMutableRawPointer(bitPattern: -2), name).map { unsafeBitCast($0, to: T.self) }
        }
        guard let post = find("SLEventPostToPid", PostToPidFn.self),
              let setField = find("SLEventSetIntegerValueField", SetIntFieldFn.self),
              let setLoc = find("CGEventSetWindowLocation", SetWinLocFn.self),
              let postRecord = find("SLPSPostEventRecordTo", PostRecordFn.self),
              let front = find("_SLPSGetFrontProcess", GetFrontFn.self),
              let connId = find("CGSMainConnectionID", ConnIDFn.self),
              let owner = find("SLSGetWindowOwner", WinOwnerFn.self),
              let connPSN = find("SLSGetConnectionPSN", ConnPSNFn.self)
        else { return nil }
        return Symbols(post: post, setField: setField, setLoc: setLoc, postRecord: postRecord,
                       front: front, connId: connId, owner: owner, connPSN: connPSN)
    }()

    /// 1 つでも解決できなければ経路ごと使わない。部分的に動かさない。
    static var available: Bool { symbols != nil }

    /*
     * 前面へ上げずに、WindowServer 上の入力焦点だけを対象へ移す。
     * これをしないと Chromium は合成イベントを「生きた入力」として受けない。
     * 上げないので、人が見ている前面アプリは変わらない（実測で確認）。
     */
    static func focusWithoutRaise(pid: pid_t, window: UInt32) -> Bool {
        guard let s = symbols else { return false }
        var previous = [UInt8](repeating: 0, count: 8), target = [UInt8](repeating: 0, count: 8)
        guard previous.withUnsafeMutableBytes({ s.front($0.baseAddress) }) == 0 else { return false }
        var ownerConnection: UInt32 = 0
        guard s.owner(s.connId(), window, &ownerConnection) == 0, ownerConnection != 0,
              target.withUnsafeMutableBytes({ s.connPSN(ownerConnection, $0.baseAddress) }) == 0
        else { return false }
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        record[0x3C] = UInt8(window & 0xFF)
        record[0x3D] = UInt8((window >> 8) & 0xFF)
        record[0x3E] = UInt8((window >> 16) & 0xFF)
        record[0x3F] = UInt8((window >> 24) & 0xFF)
        record[0x8A] = 0x02
        let defocused = previous.withUnsafeBytes { p in record.withUnsafeBufferPointer { s.postRecord(p.baseAddress, $0.baseAddress) } }
        record[0x8A] = 0x01
        let focused = target.withUnsafeBytes { p in record.withUnsafeBufferPointer { s.postRecord(p.baseAddress, $0.baseAddress) } }
        return defocused == 0 && focused == 0
    }

    /*
     * 対象のウィンドウへ宛てたマウスイベント。共有カーソルは動かさない。
     * f51 が NSEvent.windowNumber に橋渡しされる——これが無いと windowNumber 0 の
     * まま届き、AppKit はどの窓にも配らない（実測でそこで止まっていた）。
     */
    static func postMouse(_ event: CGEvent, pid: pid_t, window: UInt32,
                          local: CGPoint, clickState: Int64, button: Int64, clickGroup: Int64) {
        guard let s = symbols else { return }
        let raw = Unmanaged.passUnretained(event).toOpaque()
        s.setLoc(raw, local.x, local.y)
        s.setField(raw, 1, clickState)
        s.setField(raw, 3, button)
        s.setField(raw, 7, 3)                     // subtype = touch
        s.setField(raw, 51, Int64(window))        // windowNumber
        s.setField(raw, 58, clickGroup)
        s.setField(raw, 91, Int64(window))
        s.setField(raw, 92, Int64(window))
        s.setField(raw, 40, Int64(pid))           // Chromium の合成イベント判定
        s.post(pid, raw)
    }

    /*
     * 対象プロセスへ宛てたキーイベント。**公開経路へは送らない。**
     * 両方へ送ると AppKit 側で二重に届く（実測: "kakiku" が "kkaakkiikkuu" になった）。
     */
    static func postKey(_ event: CGEvent, pid: pid_t) {
        guard let s = symbols else { return }
        let raw = Unmanaged.passUnretained(event).toOpaque()
        s.setField(raw, 40, Int64(pid))
        s.post(pid, raw)
    }
#else
    static var available: Bool { false }
    static func focusWithoutRaise(pid: pid_t, window: UInt32) -> Bool { false }
    static func postMouse(_ event: CGEvent, pid: pid_t, window: UInt32,
                          local: CGPoint, clickState: Int64, button: Int64, clickGroup: Int64) {}
    static func postKey(_ event: CGEvent, pid: pid_t) {}
#endif
}
