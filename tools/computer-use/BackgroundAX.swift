import AppKit
import ApplicationServices
import ScreenCaptureKit
import Foundation

// No CGEvent dispatch, app activation, focused-element mutation, or clipboard writes.
// Legacy foreground code is compiled only for shared data/capture utilities; never called as fallback.
@available(macOS 14.4, *) @MainActor
struct BackgroundAX {
    private static var watchers: [String: (NSObjectProtocol, Any)] = [:]
    final class Indicator: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }
    /*
     * 操作中の印。以前は 11pt の文字を windowBackgroundColor の地に置いていたが、
     * その地は輝度 1.000 で白い Web ページと同値——白地の上では原理的に見えない
     * （DS-04 の下限 16/255 未満）。共有の `Marker`（accent の囲み。白との輝度差 163/255）
     * に寄せた。入力を横取りしない点と、人の窓が手前なら出さない点は変えていない。
     */
    static func indicator(at point: CGPoint, window: UInt32) -> Marker.Panel? {
        indicator(around: CGRect(x: point.x - 24, y: point.y - 12, width: 48, height: 24), window: window)
    }
    /// 操作対象の矩形そのものを囲む。点だけより、何を触ったかが分かる。
    /// `from` があれば、そこから滑って移動する。
    static func indicator(around rect: CGRect, window: UInt32, from: CGPoint? = nil,
                          target: String? = nil) -> Marker.Panel? {
        Marker.show(around: rect, window: window, from: from, target: target)
    }

    struct Element: Codable, Equatable {
        let path: [Int]
        let role: String, subrole: String, identifier: String, title: String, valueHash: String
        let x: Double, y: Double, width: Double, height: Double
        /*
         * AX の説明。名前も識別子も持たない絵を見分けるために要る——
         * 実測: 寿司の絵は押すと説明が /susi002.gif から /damy.gif へ変わるだけで、
         * これが無いとモデルは「もう消した絵」を何度も選び直す。
         * 同一性にも含める（valueHash と同じ扱い。変わったら対象が変わったと見る）。
         */
        let detail: String
        /// この撮影の中で一意。モデルにはこれだけを選ばせ、位置はこちらで取り直す。
        var id: String { "e" + path.map(String.init).joined(separator: "-") }
    }
    struct Snapshot: Codable {
        let frame: Frame
        let generation: Double
        let elements: [Element]
    }
    struct Grant: Codable {
        let pid: Int32, window: UInt32
        let bundle: String
        let generation: Double, expires: Double
        /*
         * 同意したときに選択画面で見せた画像の送信先。**送信先が変われば、同じ窓でも同意は使い回さない。**
         * 20 分の間に端末の設定を外部のモデルへ変えると、新しい送信先を一度も見せないまま
         * 画像が外へ出ていた。これが無い（古い形の）許可は、送信先が分からないので使い回さない。
         */
        var recipient: String? = nil
    }
    static func attribute(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
    }
    static func string(_ e: AXUIElement, _ key: String) -> String { attribute(e, key) as? String ?? "" }
    static func children(_ e: AXUIElement) -> [AXUIElement] { attribute(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
    static func generation(_ pid: Int32, bundle: String) throws -> Double {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.bundleIdentifier == bundle else { throw Failure("target_changed") }
        // launchDate is nil for valid directly launched .app executables. Kernel start time
        // still binds PID reuse without guessing from an absent LaunchServices timestamp.
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              info.pbi_start_tvsec > 0 else { throw Failure("target_changed") }
        return Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000
    }
    /*
     * アプリが「いま鍵を受け取る窓」と見なしているもの。
     *
     * **鍵は窓を選べない。**`SLEventPostToPid` はプロセスにしか宛て先が無く、
     * どの窓へ渡すかはアプリが決める。`focusWithoutRaise` はその窓を選ばせるための
     * 呼び出しだが、実測（Chrome 153 / macOS 26.6.2）では **true を返しながら
     * 同じアプリの別の窓へは切り替わらない**（焦点窓は元のまま）。
     * そのため「Typing Test の欄へ打つ」と言いながら、鍵は別の窓に落ちていた。
     * 送ってから気づくのが一番悪いので、送る前にここで確かめる。
     *
     * クリックは窓 id を刻んで送るので切り替わる（実測: 焦点窓が狙った窓に変わる）。
     * だから断りには「先にその欄を押せ」と添える。
     */
    /*
     * 打つ前に入力方式を見ることは**できない。**
     * macOS の入力方式はアプリごとに憶えられ、問い合わせで返るのは前面のアプリのもの。
     * 背景の対象がかな入力でも、こちらからは英数に見える（実測: 同じ機械で、
     * fixture には `kakiku` がそのまま入り、Chrome には「げに絵」が入った）。
     * だから確かめるのは送った後——**頼んだ文字になっているか**で見る。
     */
    static func keyWindowIsTarget(_ t: Target) -> Bool {
        let app = AXUIElementCreateApplication(t.pid)
        AXUIElementSetMessagingTimeout(app, 2)
        guard let value = attribute(app, kAXFocusedWindowAttribute),
              CFGetTypeID(value) == AXUIElementGetTypeID(),
              let rect = Helper.elementRect(value as! AXUIElement) else { return false }
        return rect == t.bounds.rect
    }
    static func window(_ t: Target) throws -> AXUIElement {
        let app = AXUIElementCreateApplication(t.pid)
        AXUIElementSetMessagingTimeout(app, 2)
        let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
        let matches = windows.filter { Helper.elementRect($0) == t.bounds.rect }
        guard matches.count == 1 else {
            stage("window-ambiguous want=\(t.bounds.rect) have=\(windows.map { Helper.elementRect($0).map(String.init(describing:)) ?? "nil" }.joined(separator: " "))")
            throw Failure("background_window_ambiguous")
        }
        return matches[0]
    }
    static func describe(_ e: AXUIElement, path: [Int], bounds: Bounds) -> Element? {
        let role = string(e, kAXRoleAttribute), subrole = string(e, kAXSubroleAttribute)
        /*
         * 候補に載せる役割。**押すための AX アクションが無くても、枠は取れる。**
         * 絵やリンクを載せておけば、モデルは「どれか」を選ぶだけで済み、
         * 28x17 の絵の座標を当てる必要がなくなる（実測: そこで外していた）。
         */
        guard [kAXButtonRole, kAXTextFieldRole, kAXTextAreaRole, kAXImageRole, "AXLink"].contains(role),
              subrole != kAXSecureTextFieldSubrole,
              ![kAXCloseButtonSubrole, kAXMinimizeButtonSubrole, kAXZoomButtonSubrole].contains(subrole),
              let rect = Helper.elementRect(e), !rect.isEmpty,
              bounds.rect.contains(rect) else { return nil }
        /*
         * Native NSTextView reports AXTextArea with no subrole. A text FIELD needs a
         * reported non-secure subrole; unknown/custom field metadata stays unsupported.
         *
         * ただし**ページの中の欄は別**。Chromium は伏せ字の欄をちゃんと名乗る。
         * 実測（Chrome 153 / macOS 26.6.2、`<input>` を並べた 1 枚で確認）:
         *   type=text → AXTextField・subrole なし / type=password → AXSecureTextField
         *   type=search → AXSearchField / textarea → AXTextArea・subrole なし
         * つまり「subrole が無い＝伏せ字かどうか分からない」は、ここでは成り立たない。
         * この規則のせいで**ページの入力欄が 1 つも候補に出ず**、
         * モデルは無い id を当て推量し続けていた（実測: 候補 16 件すべてボタン）。
         * 伏せ字を弾く守りは 3 つとも残る（この上の subrole 判定、操作点の
         * `secureFieldContains`、鍵を打つ前の subrole 判定）。
         */
        if role == kAXTextFieldRole, attribute(e, kAXSubroleAttribute) == nil,
           !insideWebContent(e) { return nil }
        // 値を持つべきなのは文字を入れる欄だけ。絵やリンクに AXValue は要らない。
        if [kAXTextFieldRole, kAXTextAreaRole].contains(role),
           attribute(e, kAXValueAttribute) as? String == nil { return nil }
        return Element(path: path, role: role, subrole: subrole,
                       identifier: string(e, kAXIdentifierAttribute), title: string(e, kAXTitleAttribute),
                       valueHash: digest(Data(string(e, kAXValueAttribute).utf8)),
                       x: rect.minX-bounds.x, y: rect.minY-bounds.y, width: rect.width, height: rect.height,
                       detail: String(string(e, kAXDescriptionAttribute).prefix(60)))
    }
    /*
     * 秘匿欄の拒否を**明示にする**。スナップショットが秘匿欄を落とす設計はそのまま
     * （`describe` の除外）。それだけだと拒否の理由が「候補に無い」としてしか出ず、
     * 意図した保護なのか、たまたま見つからなかったのか、外から区別できない。
     * 対象の窓の中だけを見る。系全体の hit-test は、背面の対象に対して別アプリの
     * 要素を返しうるので使わない。
     */
    static func secureFieldContains(_ p: CGPoint, in t: Target) -> Bool {
        guard let root = try? window(t) else { return false }
        var found = false, visited = 0
        func visit(_ e: AXUIElement, _ depth: Int) {
            if found || depth > 30 || visited > 2000 { return }
            visited += 1
            if string(e, kAXSubroleAttribute) == kAXSecureTextFieldSubrole,
               let rect = Helper.elementRect(e), rect.contains(p) { found = true; return }
            for child in children(e) { visit(child, depth + 1) }
        }
        visit(root, 0)
        return found
    }
    /*
     * その要素が Web の中身かどうか。**送る前に経路を決めるために要る。**
     * 実測（Chrome 153 / macOS 26.6.2）: ネイティブのボタンは AXPress で押せるが、
     * Web ページのボタンは AXPress を持っていても押下が起きない。
     * 送ってから別経路へ切り替えるのは二重実行になるので、ここで見分ける。
     */
    /*
     * AXPress を受け付けないアプリ。**送る前に見分けるために名前で持つ。**
     * 実測（Chrome 153 / macOS 26.6.2）: Web ページのボタンに加えて、
     * **タブの切り替えも AXPress では起きない**（同じ位置を 2 度押して何も変わらなかった）。
     * Chromium 系は AX を読む側の作りが同じなので、一族としてまとめて扱う。
     * 押せないのに押せたことにするより、座標で押す方が確かで、駄目なら断れる。
     */
    static let pressIgnored: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev",
        "com.google.Chrome.canary", "org.chromium.Chromium", "com.microsoft.edgemac",
        "com.brave.Browser", "com.vivaldi.Vivaldi", "company.thebrowser.Browser",
    ]
    static func insideWebContent(_ e: AXUIElement) -> Bool {
        var current = e
        for _ in 0..<25 {
            if string(current, kAXRoleAttribute) == "AXWebArea" { return true }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                  let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
            current = parent as! AXUIElement
        }
        return false
    }
    static func tree(_ t: Target) throws -> [Element] {
        var result: [Element] = [], visited = 0
        func visit(_ e: AXUIElement, _ path: [Int]) throws {
            visited += 1
            guard visited <= 2000, path.count <= 30 else { throw Failure("background_tree_limit") }
            if let entry = describe(e, path: path, bounds: t.bounds) { result.append(entry) }
            for (i, child) in children(e).enumerated() { try visit(child, path + [i]) }
        }
        try visit(window(t), [])
        return result
    }
    static func resolve(_ path: [Int], in t: Target) throws -> AXUIElement {
        var current = try window(t)
        for index in path {
            let list = children(current)
            guard list.indices.contains(index) else { throw Failure("target_changed") }
            current = list[index]
        }
        return current
    }
    static func privateFile(_ data: Data, _ path: String) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Failure("background_file_exists") }
        defer { close(fd) }
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { throw Failure("cache_write_failed") }
            var offset = 0
            while offset < bytes.count {
                let n = write(fd, base.advanced(by: offset), bytes.count-offset)
                guard n > 0 else { throw Failure("cache_write_failed") }; offset += n
            }
        }
        guard fsync(fd) == 0 else { throw Failure("cache_write_failed") }
    }
    static func sessionPath(_ dir: URL, _ session: String) throws -> String {
        guard UUID(uuidString: session) != nil else { throw Failure("invalid_scope") }
        return dir.appendingPathComponent("background-\(session).json").path
    }
    /*
     * 実行世代。**人が割り込むたびに 1 つ進む番号**で、許可そのものとは別に持つ。
     *
     * 何のためにあるか: モデルは 1 回の判断に数秒から数十秒かかる。その間に人が
     * 対象を触れば、返ってきた判断は**もう存在しない画面**についてのものになる。
     * 撮った写真に世代を刻み、送る直前に今の世代と突き合わせれば、
     * 割り込みをまたいだ判断と、まだ配送していない操作がまとめて失効する。
     *
     * 許可（Grant）に混ぜないのは、許可が人の同意そのもので、割り込みでは失効しないから。
     * 人が手を止めれば同じ許可のまま続きができる。変わるのは世代だけ。
     */
    static func epoch(_ path: String) -> Int {
        guard let data = FileManager.default.contents(atPath: path + ".epoch"),
              let value = try? JSONDecoder().decode(Int.self, from: data), value >= 0 else { return 0 }
        return value
    }
    /// 世代を 1 つ進める。書けなければ進めない——読めない世代は 0 に戻るので、
    /// 黙って戻すくらいなら失敗させる（呼ぶ側は止まる）。
    @discardableResult
    static func advanceEpoch(_ path: String) throws -> Int {
        let next = epoch(path) + 1
        unlink(path + ".epoch")
        try privateFile(try JSONEncoder().encode(next), path + ".epoch")
        return next
    }
    /// 人の入力を最後に見た時刻。見張りが触り、再開の判断に使う。中身は持たない。
    static func markHumanInput(_ path: String) {
        let file = path + ".lastinput"
        if !FileManager.default.fileExists(atPath: file) { try? privateFile(Data(), file) }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file)
    }
    /// 再開してよいと見なすまでに、人の手が止まっている必要のある時間。
    static let quietPeriod: TimeInterval = 1.5
    /*
     * 人の手がいま空いているか。**空いていなければ、こちらは待つ。**
     * 走行の途中（`resume`）と、次の依頼を始めるとき（`reusableGrant`）で
     * 同じ物差しを使う。片方だけ厳しいと、同じ割り込みが場面によって
     * 「順番の交代」にも「同意の取り消し」にもなってしまう。
     */
    static func humanIsQuiet(_ path: String, pid: Int32) -> Bool {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return false }
        guard let last = try? FileManager.default.attributesOfItem(atPath: path + ".lastinput")[.modificationDate] as? Date
        else { return true }
        return Date().timeIntervalSince(last) >= quietPeriod
    }
    /// 明示的に取り下げられたか。割り込み（順番の交代）とは意味が違う。
    static func explicitlyStopped(_ path: String) -> Bool {
        guard let reason = try? String(contentsOfFile: path + ".interrupted", encoding: .utf8) else { return false }
        return reason.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("session_stopped")
    }
    static func readPrivate<T: Decodable>(_ type: T.Type, _ path: String) throws -> T {
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw Failure("background_receipt_missing") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
              (info.st_mode & 0o077) == 0, info.st_size <= 2_000_000 else { throw Failure("invalid_cache") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        return try JSONDecoder().decode(type, from: file.readToEnd() ?? Data())
    }
    static func permitted(_ frame: Frame, dir: URL) throws -> Target {
        try Helper.checkPermissions()
        guard frame.deliveryMode == "background", let session = frame.backgroundSession else { throw Failure("invalid_scope") }
        let path = try sessionPath(dir, session)
        /*
         * 控えが無い＝生きた同意が無い、ということ。期限切れと割り込みのときに消える。
         * 以前はここが「受領書が見当たらない」という言い方になっていて、
         * 走行中に期限が切れた場合に**こちらの不具合のように見えていた。**
         */
        guard FileManager.default.fileExists(atPath: path) else { throw Failure("consent_expired") }
        let grant = try readPrivate(Grant.self, path)
        // 「別の窓を指している」と「期限が切れた」は別の話。呼び出し側の打ち手が変わる。
        guard grant.pid == frame.pid, grant.window == frame.windowId, grant.bundle == frame.bundleId,
              try generation(frame.pid, bundle: frame.bundleId) == grant.generation
        else { throw Failure("consent_target_mismatch") }
        guard grant.expires > Date().timeIntervalSince1970 else { throw Failure("consent_expired") }
        let monitorPID = try readPrivate(Int32.self, path + ".watching")
        let heartbeat = try FileManager.default.attributesOfItem(atPath: path + ".watching")[.modificationDate] as? Date
        guard kill(monitorPID, 0) == 0, let heartbeat,
              Date().timeIntervalSince(heartbeat) < 2 else { throw Failure("background_monitor_unavailable") }
        /*
         * 止まった理由を残す。明示的な停止と、人が対象を触ったことは別に扱う——
         * 前者は依頼の取り下げ、後者は対象の奪い合いで、次にできることが違う。
         */
        if let reason = try? String(contentsOfFile: path + ".interrupted", encoding: .utf8) {
            let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            stage("takeover-marker \(trimmed)")
            throw Failure(trimmed.hasPrefix("session_stopped") ? "session_stopped" : "human_takeover")
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier != frame.pid
        else {
            // 停止の理由を残す。見張りが書いた印か、対象が前面に出たかで打ち手が違う。
            stage("takeover-frontmost")
            throw Failure("human_takeover")
        }
        return try Helper.rescope(frame) // Does not reveal, unhide, raise or activate.
    }
    static func capture(_ t: Target) async throws -> (CGImage, Data) {
        // Window-only capture does not read the human's foreground or focused field.
        try Helper.checkPermissions()
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let w = content.windows.first(where: { $0.windowID == t.windowId && $0.owningApplication?.processID == t.pid }) else { throw Failure("background_unavailable") }
        let config = SCStreamConfiguration()
        let scale = min(1.0, 1440 / max(t.bounds.width, t.bounds.height))
        config.width = max(1, Int((t.bounds.width*scale).rounded()))
        config.height = max(1, Int((t.bounds.height*scale).rounded()))
        config.showsCursor = false; config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: w), configuration: config)
        guard try Helper.windowBounds(pid:t.pid, windowId:t.windowId) == t.bounds,
              let png = NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:]) else { throw Failure("stale_frame") }
        return (image,png)
    }
    /*
     * まだ生きている許可を探す。**同じ窓に対する許可を、毎回聞き直さない。**
     * 使えるのは、期限内・同じアプリが動いたまま（generation 一致）・その窓が画面にある・
     * 見張りが生きている・停止されていない、の全部が揃うときだけ。
     * 1 つでも欠けたら、無かったことにして改めて聞く。
     */
    /// 期限切れかどうか。読めない許可は期限切れ扱いにして片付ける。
    static func readGrantExpired(_ path: String) -> Bool {
        guard let grant = try? readPrivate(Grant.self, path) else { return true }
        return grant.expires <= Date().timeIntervalSince1970
    }
    /// 1 回の依頼に認める長さ。同意の文面で言っている「5 分」と同じ。
    static let runLimit: TimeInterval = 300
    static func reusableGrant(_ dir: URL, recipient: String?) -> (Target, String)? {
        guard let recipient, !recipient.isEmpty else { return nil }
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return nil }
        for name in names {
            // 実体は background-<uuid>.json。名前の形が合うものだけを見る。
            guard name.hasPrefix("background-"), name.hasSuffix(".json") else { continue }
            let session = String(name.dropFirst("background-".count).dropLast(".json".count))
            guard UUID(uuidString: session) != nil, let path = try? sessionPath(dir, session) else { continue }
            /*
             * 残りが少ない許可は使い回さない。**途中で切れる方が、もう一度訊くより悪い。**
             * 実測: 残り 95 秒の許可を引き継ぎ、最初のモデル呼び出しに 119 秒かかって、
             * 送る直前に許可が消えた（記録も残らないまま止まった）。
             * 1 回の依頼に認める長さ（5 分）が残っていないなら、訊き直す。
             */
            guard let grant = try? readPrivate(Grant.self, path),
                  grant.recipient == recipient,
                  grant.expires > Date().timeIntervalSince1970 + runLimit,
                  !explicitlyStopped(path),
                  let generationNow = try? generation(grant.pid, bundle: grant.bundle),
                  generationNow == grant.generation,
                  let monitor = try? readPrivate(Int32.self, path + ".watching"), kill(monitor, 0) == 0,
                  let beat = try? FileManager.default.attributesOfItem(atPath: path + ".watching")[.modificationDate] as? Date,
                  Date().timeIntervalSince(beat) < 2,
                  let bounds = try? Helper.windowBounds(pid: grant.pid, windowId: grant.window)
            else { continue }
            /*
             * 前の走行が人の割り込みで止まっていた場合。**それは同意の取り消しではない。**
             *
             * 走行の途中なら手が空くのを待って続ける（`resume`）のに、次の依頼になると
             * 同じ割り込みを理由に許可ごと捨てて選び直しを求めていた。同じ 20 分の同意の
             * 中で、同じ出来事の扱いが食い違っていたことになる。
             * 人の手が空いているときだけ、印を外して実行世代を 1 つ進めてから引き継ぐ。
             * **進めるので、割り込みの前に撮った写真はここでも失効する。**
             * まだ触っているなら引き継がない——選び直しを求める方が、横から入るよりよい。
             */
            if FileManager.default.fileExists(atPath: path + ".interrupted") {
                guard humanIsQuiet(path, pid: grant.pid) else { continue }
                unlink(path + ".interrupted")
                guard (try? advanceEpoch(path)) != nil,
                      !FileManager.default.fileExists(atPath: path + ".interrupted") else { continue }
                stage("grant-resumed-after-takeover")
            }
            return (Target(bundleId: grant.bundle, windowId: grant.window, pid: grant.pid, bounds: bounds), session)
        }
        return nil
    }
    /*
     * 人に見せてよい窓。伏せ字を扱うものは初めから並べない。
     * 同意ダイアログと、試験専用の無人経路が**同じ一覧を使う**ようにしてある。
     */
    static let genieBundles: Set<String> = ["com.astra.mac", "com.astra.desktop"]
    static func selectableWindows(_ content: SCShareableContent) -> [SCWindow] {
        content.windows.filter { w in
            guard let owner = w.owningApplication else { return false }
            let id=owner.bundleIdentifier
            // Genie 自身（開発版 com.astra.mac / 配布版 com.astra.desktop）の窓は対象にしない。
            // 自分の確認カードや Dock を撮って外へ送り、そこを操作することになる。
            return w.windowLayer == 0 && w.frame.width > 0 && w.frame.height > 0 && owner.processID != getpid()
                && !genieBundles.contains(id) && owner.applicationName != "Genie"
                && NSRunningApplication(processIdentifier:owner.processID)?.activationPolicy == .regular
                && !["com.apple.loginwindow","com.apple.SecurityAgent","com.apple.keychainaccess"].contains(id)
                && !id.hasPrefix("com.1password") && !id.hasPrefix("com.agilebits.onepassword")
        }
    }
    /*
     * 選ばれた窓を許可として書き留め、見張りを立てる。
     * **同意の後に起きることは、ここ 1 か所だけ。**試験専用の経路も必ずここを通るので、
     * 期限・見張り・世代の扱いが本番と食い違うことがない。
     */
    static func establish(_ w: SCWindow, dir: URL, recipient: String?) async throws -> (Target,String) {
        guard let owner = w.owningApplication else { throw Failure("target_changed") }
        let t=Target(bundleId:owner.bundleIdentifier,windowId:w.windowID,pid:owner.processID,
                     bounds:try Helper.windowBounds(pid:owner.processID,windowId:w.windowID))
        let session=UUID().uuidString.lowercased(), path=try sessionPath(dir,session)
        let grant=Grant(pid:t.pid,window:t.windowId,bundle:t.bundleId,generation:try generation(t.pid,bundle:t.bundleId),expires:Date().timeIntervalSince1970+1200,recipient:recipient)
        try privateFile(JSONEncoder().encode(grant),path)
        let watcher=Process();watcher.executableURL=URL(fileURLWithPath:CommandLine.arguments[0])
        watcher.arguments=["--watch",path];watcher.standardOutput=FileHandle.nullDevice;watcher.standardError=FileHandle.nullDevice
        try watcher.run()
        // Readiness handshake: no observation/mutation before conflict monitoring is live.
        for _ in 0..<30 {
            if FileManager.default.fileExists(atPath:path+".watching") { return (t,session) }
            try await Task.sleep(nanoseconds:50_000_000)
        }
        throw Failure("background_monitor_unavailable")
    }
final class ConsentAccessoryView: NSView {
    let popup = NSPopUpButton(frame: NSRect(x: 0, y: 34, width: 365, height: 26), pullsDown: false)
    let refreshBtn = NSButton(frame: NSRect(x: 373, y: 34, width: 87, height: 26))
    let launchBtn = NSButton(frame: NSRect(x: 0, y: 4, width: 210, height: 24))
    let hintLabel = NSTextField(labelWithString: "")

    private(set) var currentWindows: [SCWindow] = []
    private var timer: Timer?
    private let goal: String
    private weak var alert: NSAlert?

    init(goal: String, initialWindows: [SCWindow], alert: NSAlert) {
        self.goal = goal
        self.currentWindows = initialWindows
        self.alert = alert
        super.init(frame: NSRect(x: 0, y: 0, width: 460, height: 66))

        refreshBtn.title = "一覧を更新"
        refreshBtn.bezelStyle = .rounded
        refreshBtn.target = self
        refreshBtn.action = #selector(onRefresh)

        launchBtn.bezelStyle = .rounded
        launchBtn.target = self
        launchBtn.action = #selector(onLaunch)
        launchBtn.isHidden = true

        hintLabel.frame = NSRect(x: 218, y: 6, width: 242, height: 20)
        hintLabel.font = NSFont.systemFont(ofSize: 11)
        hintLabel.textColor = NSColor.secondaryLabelColor
        hintLabel.cell?.lineBreakMode = .byTruncatingTail
        hintLabel.isHidden = true

        popup.target = self
        popup.action = #selector(onSelectionChange)

        addSubview(popup)
        addSubview(refreshBtn)
        addSubview(launchBtn)
        addSubview(hintLabel)

        updateWindows(initialWindows)
        startTimer()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func cleanUp() {
        timer?.invalidate()
        timer = nil
    }

    private func startTimer() {
        let t = Timer(timeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.poll()
            }
        }
        RunLoop.main.add(t, forMode: .common)
        self.timer = t
    }

    @objc private func onRefresh() {
        Task { @MainActor in await poll() }
    }

    @objc private func onSelectionChange() {
        updateAlertButton()
    }

    @objc private func onLaunch() {
        let lower = goal.lowercased()
        if lower.contains("safari") {
            let script = NSAppleScript(source: "tell application \"Safari\" to make new document")
            var err: NSDictionary?
            script?.executeAndReturnError(&err)
        } else if lower.contains("chrome") {
            let script = NSAppleScript(source: "tell application \"Google Chrome\" to make new window")
            var err: NSDictionary?
            script?.executeAndReturnError(&err)
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 800_000_000)
            await poll(forceSelectTarget: true)
        }
    }

    private func poll(forceSelectTarget: Bool = false) async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let windows = BackgroundAX.selectableWindows(content)
            updateWindows(windows, forceSelectTarget: forceSelectTarget)
        } catch {
            // ignore temporary capture polling error
        }
    }

    func updateWindows(_ windows: [SCWindow], forceSelectTarget: Bool = false) {
        let prevSelected = popup.indexOfSelectedItem > 0 && popup.indexOfSelectedItem - 1 < currentWindows.count
            ? currentWindows[popup.indexOfSelectedItem - 1].windowID : nil
        self.currentWindows = windows

        popup.removeAllItems()
        popup.addItem(withTitle: "操作するウィンドウを選んでください")

        var selectedIdx = 0
        for (i, w) in windows.enumerated() {
            let appName = w.owningApplication?.applicationName ?? "App"
            let title = w.title ?? "Window"
            popup.addItem(withTitle: "\(appName) — \(title)")
            if let prevSelected, w.windowID == prevSelected {
                selectedIdx = i + 1
            }
        }

        let lower = goal.lowercased()
        let mentionsSafari = lower.contains("safari")
        let mentionsChrome = lower.contains("chrome")
        let hasSafari = windows.contains { $0.owningApplication?.bundleIdentifier == "com.apple.Safari" }
        let hasChrome = windows.contains { $0.owningApplication?.bundleIdentifier == "com.google.Chrome" }

        if mentionsSafari && !hasSafari {
            launchBtn.title = "Safari のウィンドウを開く"
            launchBtn.isHidden = false
            hintLabel.stringValue = "現在の画面にありません"
            hintLabel.isHidden = false
        } else if mentionsChrome && !hasChrome {
            launchBtn.title = "Chrome のウィンドウを開く"
            launchBtn.isHidden = false
            hintLabel.stringValue = "現在の画面にありません"
            hintLabel.isHidden = false
        } else {
            launchBtn.isHidden = true
            hintLabel.isHidden = true
            if forceSelectTarget || selectedIdx == 0 {
                if mentionsSafari, let idx = windows.firstIndex(where: { $0.owningApplication?.bundleIdentifier == "com.apple.Safari" }) {
                    selectedIdx = idx + 1
                } else if mentionsChrome, let idx = windows.firstIndex(where: { $0.owningApplication?.bundleIdentifier == "com.google.Chrome" }) {
                    selectedIdx = idx + 1
                }
            }
        }

        popup.selectItem(at: selectedIdx)
        updateAlertButton()
    }

    func updateAlertButton() {
        alert?.buttons.first?.isEnabled = popup.indexOfSelectedItem > 0
    }
}

    static func select(_ request: Request, dir: URL) async throws -> (Target,String) {

        if let live = reusableGrant(dir, recipient: request.recipient) { return live }
        let content = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
        /*
         * 出荷ビルドでは、生きた許可が無ければ**必ず下の選択ダイアログを通る。**
         * 以前はここで目的の語から窓を自動で選び、ダイアログを出さずに
         * 始めていた。選べる窓が 1 つでもあれば必ず何かを返すので、対象も画像の送信先も一度も
         * 人に見せないまま、メールや銀行の窓の画像が外へ出得た。しかも対象を決める前に AppleScript で
         * 開いているタブを書き換え、別のアプリを起動・前面化していた（承認カードの「範囲」と食い違う）。
         * 自動選択は下の試験専用の経路にだけ残す。
         */
        let windows = selectableWindows(content)
        #if GENIE_UNATTENDED_TEST
        /*
         * 反復試験のためだけの経路。**出荷する実行ファイルには入らない**
         * （`scripts/build-computer-helper.sh` はこの旗を定義しない。静的検査で縛ってある）。
         *
         * なぜ要るか: 同意は 1 回の依頼ごとではなく 20 分ごとなので、人が 1 回押せば
         * 10 本ほどは無人で走る。それでも 50 本には数回の立ち会いが要り、
         * 反復して数を取る試験には向かない。ここは**その 1 回の操作を省くためだけ**にある。
         *
         * 省くのは対象を選ぶ操作だけで、ほかの守りは 1 つも外れない——
         * 窓の同一性、実行世代、期限、見張り、伏せ字の拒否、承認の検査はそのまま通る。
         * この経路で取った結果は「同意 UI を通っていない」ものとして記録すること。
         */
        /*
         * 対象の名前は**ファイルで受け取る**。環境変数では届かない——
         * host は helper を `HOME` / `PATH` / `LANG` だけに削いだ環境で起動する
         * （意図した守りなので、そちらは変えない）。
         * 置き場所は写真の受け渡しに使う所と同じで、所有者だけが読める形を要求する。
         */
        let targetFile = dir.appendingPathComponent("unattended-test-target").path
        if let wanted = try? String(contentsOfFile: targetFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !wanted.isEmpty {
            let hits = windows.filter { ($0.title ?? "").contains(wanted) }
            guard hits.count == 1 else { throw Failure("test_target_not_unique_\(hits.count)") }
            stage("unattended-test-target")
            return try await establish(hits[0], dir: dir, recipient: request.recipient)
        }
        // 対象の名前が無い試験では、目的の語から窓を選ぶ（出荷ビルドには入らない。上の注意）。
        if let autoTarget = await autoResolveTargetWindow(goal: request.goal ?? "", content: content) {
            stage("auto-selected-target-\(autoTarget.owningApplication?.applicationName ?? "app")")
            return try await establish(autoTarget, dir: dir, recipient: request.recipient)
        }
        #endif
        let alert=NSAlert()
        alert.messageText="バックグラウンドで操作する対象"
        // 送信先は内部の種別名ではなく、画像が届く提供元の名前で見せる（前面の選択ダイアログと同じ対応表）。
        alert.informativeText="目的: \(request.goal ?? "")\n画像の送信先: \(imageDestinationLabel(request.recipient))\n選んだ窓だけ。1 回の依頼につき最大12操作・5分で、この許可は20分間そのまま使えます（その間の追加の依頼では、画像の送信先が同じならこの画面は出ません）。個別確認はしません。共有マウス・キー・クリップボードは使いません。対象を前面で使うと停止します。未対応の操作は前面操作へ切り替えません。"
        let accessory = ConsentAccessoryView(goal: request.goal ?? "", initialWindows: windows, alert: alert)
        alert.accessoryView = accessory
        alert.addButton(withTitle:"バックグラウンド操作を許可")
        alert.addButton(withTitle:"中止")
        accessory.updateAlertButton()
        // 同意 UI が焦点を奪う前に、どこにいたかを覚えておく。閉じたらそこへ返す。
        let previous = NSWorkspace.shared.frontmostApplication
        /*
         * 同意の窓を**必ず見える所に出す。**
         *
         * `activate(ignoringOtherApps:)` は macOS 14 で非推奨になり、
         * **実際に何も起きない。**そのため accessory として動くこの helper が出した
         * 同意ダイアログは、前面のアプリの後ろに隠れて出ていた。
         * 実測 2026-09-22: ダイアログは (618,194) 492x363 に出ていたのに端末の窓の
         * 後ろにあり、誰も気づかないまま 1 回の依頼の持ち時間（5 分）を使い切って
         * `timeout` で終わった。**人に訊いているのに、訊いたことが見えていなかった。**
         *
         * 前面を奪えることに頼らず、窓そのものを前へ出す。`orderFrontRegardless` は
         * アプリが非アクティブでも窓を表示し、`.modalPanel` は通常の窓より上に置く。
         * 別の Space にいるときでも出るよう、収容の振る舞いも指定する。
         * 対象アプリには何もしない（前面化しない）点は変わらない。
         */
        NSApp.activate() // Only this one-time consent UI, never target app.
        alert.window.level = .modalPanel
        alert.window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        alert.window.orderFrontRegardless()
        let ret = alert.runModal()
        stage("alert-returned-\(ret.rawValue)-popup-\(accessory.popup.indexOfSelectedItem)")
        accessory.cleanUp()
        guard ret == .alertFirstButtonReturn, accessory.popup.indexOfSelectedItem > 0 else { throw Failure("user_cancelled") }
        let w=accessory.currentWindows[accessory.popup.indexOfSelectedItem-1], owner=w.owningApplication!
        NSApp.hide(nil)
        /*
         * 同意 UI を隠すと、macOS は次のアプリへ焦点を渡す。それが対象アプリだと、
         * 人が何もしていないのに「人が引き継いだ」と判定されて即座に止まる（実測）。
         * **対象を前面に出すのではなく、元いたアプリへ返す。**
         * 元いたのが対象そのものだった場合は、競合しているのが事実なので何もしない。
         */
        if let previous, previous.processIdentifier != owner.processID {
            for _ in 0..<10 {
                try await Task.sleep(nanoseconds: 60_000_000)
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == owner.processID else { break }
                previous.activate()
            }
        }
        return try await establish(w, dir: dir, recipient: request.recipient)
    }
    #if GENIE_UNATTENDED_TEST
    /*
     * 試験用ビルドだけの自動選択（`select` の試験専用の経路から呼ぶ）。**出荷する実行ファイルには入らない。**
     * 目的の語から窓を選び、無ければ AppleScript でアプリや窓を開く。人に対象も送信先も見せないので、
     * 本番の経路には置かない。
     */
    static func autoResolveTargetWindow(goal: String, content: SCShareableContent) async -> SCWindow? {
        let windows = selectableWindows(content)
        let lower = goal.lowercased()
        let previous = NSWorkspace.shared.frontmostApplication

        func keepBackground(_ targetPid: Int32) async {
            if let previous, previous.processIdentifier != targetPid {
                for _ in 0..<5 {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid {
                        previous.activate()
                    }
                }
            }
        }

        // 1. If mentions "x" (or twitter / x.com / ツイッター / ポスト / タイムライン)
        let mentionsX = lower.contains("xを") || lower.contains("xで") || lower.contains("xから")
            || lower.contains("xの") || lower.contains("xに") || lower.contains("xは")
            || lower.contains("xが") || lower.contains("xも") || lower.contains("x ")
            || lower.hasPrefix("x") || lower.contains(" x ")
            || lower.contains("twitter") || lower.contains("x.com") || lower.contains("ツイッター")
            || lower.contains("ポスト") || lower.contains("ツイート") || lower.contains("タイムライン")
        if mentionsX {
            if let xWin = windows.first(where: {
                let t = $0.title ?? ""
                return t.contains(" / X") || t.contains("Twitter") || t.contains("x.com")
            }) {
                return xWin
            }
            if let safariWin = windows.first(where: { $0.owningApplication?.bundleIdentifier == "com.apple.Safari" }) {
                let script = NSAppleScript(source: "tell application \"Safari\" to set URL of current tab of front window to \"https://x.com\"")
                script?.executeAndReturnError(nil)
                await keepBackground(safariWin.owningApplication!.processID)
                return safariWin
            } else {
                let script = NSAppleScript(source: "tell application \"Safari\"\n make new document with properties {URL:\"https://x.com\"}\n end tell")
                script?.executeAndReturnError(nil)
                try? await Task.sleep(nanoseconds: 800_000_000)
                if let newContent = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) {
                    let newWins = selectableWindows(newContent)
                    if let newSafari = newWins.first(where: { $0.owningApplication?.bundleIdentifier == "com.apple.Safari" }) {
                        await keepBackground(newSafari.owningApplication!.processID)
                        return newSafari
                    }
                }
            }
        }

        // 2. If mentions "safari" or general search/web browsing
        let mentionsSearch = lower.contains("safari") || lower.contains("検索") || lower.contains("探して")
            || lower.contains("調べて") || lower.contains("ブラウザ") || lower.contains("web")
            || lower.contains("サイト") || lower.contains("見せて") || lower.contains("流行")
        if mentionsSearch {
            if let safariWin = windows.first(where: { $0.owningApplication?.bundleIdentifier == "com.apple.Safari" }) {
                return safariWin
            }
            let script = NSAppleScript(source: "tell application \"Safari\" to make new document")
            script?.executeAndReturnError(nil)
            try? await Task.sleep(nanoseconds: 800_000_000)
            if let newContent = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) {
                let newWins = selectableWindows(newContent)
                if let newSafari = newWins.first(where: { $0.owningApplication?.bundleIdentifier == "com.apple.Safari" }) {
                    await keepBackground(newSafari.owningApplication!.processID)
                    return newSafari
                }
            }
        }

        // 3. If mentions "chrome"
        if lower.contains("chrome") {
            if let chromeWin = windows.first(where: { $0.owningApplication?.bundleIdentifier == "com.google.Chrome" }) {
                return chromeWin
            }
            let script = NSAppleScript(source: "tell application \"Google Chrome\" to make new window")
            script?.executeAndReturnError(nil)
            try? await Task.sleep(nanoseconds: 800_000_000)
            if let newContent = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) {
                let newWins = selectableWindows(newContent)
                if let newChrome = newWins.first(where: { $0.owningApplication?.bundleIdentifier == "com.google.Chrome" }) {
                    await keepBackground(newChrome.owningApplication!.processID)
                    return newChrome
                }
            }
        }

        // 4. If single candidate non-Genie window exists (excluding terminal)
        let excludedBundles: Set<String> = [
            "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty",
            "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "com.apple.dt.Xcode"
        ]
        let nonTerminalWindows = windows.filter { !excludedBundles.contains($0.owningApplication?.bundleIdentifier ?? "") }

        // 3.5. Match any specific desktop / productivity app mentioned in the goal
        let appKeywordMap: [(keywords: [String], bundles: [String], appNames: [String], launchApp: String?)] = [
            (["カレンダー", "calendar", "予定", "スケジュール"], ["com.apple.ical"], ["calendar", "カレンダー"], "Calendar"),
            (["メモ", "notes", "ノート"], ["com.apple.notes"], ["notes", "メモ"], "Notes"),
            (["リマインダー", "reminders", "todo", "タスク"], ["com.apple.reminders"], ["reminders", "リマインダー"], "Reminders"),
            (["メール", "mail", "メーラー"], ["com.apple.mail"], ["mail", "メール"], "Mail"),
            (["finder", "ファインダー", "フォルダ", "ファイル"], ["com.apple.finder"], ["finder"], "Finder"),
            (["設定", "システム設定", "settings", "preferences"], ["com.apple.systempreferences", "com.apple.systemsettings"], ["system settings", "system preferences", "設定", "システム設定"], "System Settings"),
            (["マップ", "maps", "地図"], ["com.apple.maps"], ["maps", "マップ"], "Maps"),
            (["電卓", "計算機", "calculator"], ["com.apple.calculator"], ["calculator", "計算機", "電卓"], "Calculator"),
            (["ミュージック", "music", "音楽"], ["com.apple.music"], ["music", "ミュージック"], "Music"),
            (["プレビュー", "preview", "pdf"], ["com.apple.preview"], ["preview", "プレビュー"], "Preview"),
            (["slack", "スラック"], ["com.tinyspeck.slackmacgap"], ["slack"], "Slack"),
            (["discord", "ディスコード"], ["com.hnc.discord"], ["discord"], "Discord"),
            (["notion", "ノーション"], ["notion.id"], ["notion"], "Notion"),
        ]

        for entry in appKeywordMap {
            if entry.keywords.contains(where: { lower.contains($0) }) {
                // 既に開いている該当アプリのウィンドウを探す
                if let appWin = nonTerminalWindows.first(where: { w in
                    guard let app = w.owningApplication else { return false }
                    let b = app.bundleIdentifier.lowercased()
                    let n = app.applicationName.lowercased()
                    return entry.bundles.contains(where: { b.contains($0) }) ||
                           entry.appNames.contains(where: { n.contains($0) })
                }) {
                    return appWin
                }
                // 開いていない場合は起動してバックグラウンドウィンドウを取得
                if let launchName = entry.launchApp {
                    let script = NSAppleScript(source: "tell application \"\(launchName)\" to activate")
                    script?.executeAndReturnError(nil)
                    try? await Task.sleep(nanoseconds: 800_000_000)
                    if let newContent = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) {
                        let newWins = selectableWindows(newContent)
                        if let launchedWin = newWins.first(where: { w in
                            guard let app = w.owningApplication else { return false }
                            let b = app.bundleIdentifier.lowercased()
                            let n = app.applicationName.lowercased()
                            return entry.bundles.contains(where: { b.contains($0) }) ||
                                   entry.appNames.contains(where: { n.contains($0) })
                        }) {
                            await keepBackground(launchedWin.owningApplication!.processID)
                            return launchedWin
                        }
                    }
                }
            }
        }

        if nonTerminalWindows.count == 1 {
            return nonTerminalWindows[0]
        }

        // 5. If Safari or Chrome window exists among candidates, prefer browser for web/read tasks
        if let browserWin = windows.first(where: { ["com.apple.Safari", "com.google.Chrome"].contains($0.owningApplication?.bundleIdentifier ?? "") }) {
            return browserWin
        }

        // 6. Topmost window that is not the currently frontmost active human app and not terminal
        if let safeNonFrontmost = nonTerminalWindows.first(where: { $0.owningApplication?.processID != previous?.processIdentifier }) {
            return safeNonFrontmost
        }

        if let anySafe = nonTerminalWindows.first {
            return anySafe
        }

        return windows.first
    }
    #endif
    static func respond(_ request: Request) async throws -> Data {
        /*
         * 依頼の終了と、同意の失効は別。**1 回の依頼が終わるたびに許可を捨てない。**
         * 捨てていたため、続けて頼むたびに選択画面が出ていた。
         * 許可は自分の期限で切れ、見張りがその時に後始末する。
         * 人が対象を触った・明示的に止めた場合は `.interrupted` が付き、
         * `reusableGrant` がそれを見て使い回さないので、ここで消す必要はない。
         */
        if request.op == "end", let f=request.scope, let s=f.backgroundSession, let reference=request.referencePath {
            let path=try sessionPath(URL(fileURLWithPath:reference).deletingLastPathComponent(),s)
            if FileManager.default.fileExists(atPath:path+".interrupted") || readGrantExpired(path) {
                try? FileManager.default.removeItem(atPath:path)
            }
            return Data("{}".utf8)
        }
        try Helper.checkPermissions()
        /*
         * 人が手を止めたか訊く。**答えるだけで、人を止める操作は何もしない。**
         *
         * 割り込みは依頼の終わりではなく順番の交代なので、人の手が止まったら
         * 続きができる。ただし再開は必ず世代を 1 つ進めてから返す——割り込みの前に
         * 撮った写真とその上で決まった操作は、ここで全部失効する。
         * まだ人が触っているなら `human_active` を返して待たせる。急かさない。
         */
        if request.op == "resume" {
            guard let f=request.scope, let s=f.backgroundSession, let reference=request.referencePath
            else { throw Failure("invalid_scope") }
            let path=try sessionPath(URL(fileURLWithPath:reference).deletingLastPathComponent(),s)
            guard FileManager.default.fileExists(atPath:path) else { throw Failure("consent_expired") }
            let grant=try readPrivate(Grant.self,path)
            guard grant.pid == f.pid, grant.window == f.windowId, grant.bundle == f.bundleId,
                  try generation(f.pid,bundle:f.bundleId) == grant.generation
            else { throw Failure("consent_target_mismatch") }
            guard grant.expires > Date().timeIntervalSince1970 else { throw Failure("consent_expired") }
            // 明示的に取り下げられた依頼は再開しない。割り込みとは意味が違う。
            if explicitlyStopped(path) { throw Failure("session_stopped") }
            // 対象が前面にある、または人の手がまだ動いている＝人の番。待つ。
            guard humanIsQuiet(path, pid: f.pid) else { throw Failure("human_active") }
            // 先に印を消して世代を進め、**進めた後にもう一度見る**。その間に人が
            // 触り直していたら、まだ人の番なので待たせる（開けたままにしない）。
            unlink(path+".interrupted")
            try advanceEpoch(path)
            guard !FileManager.default.fileExists(atPath:path+".interrupted") else { throw Failure("human_active") }
            return Data("{\"status\":\"resumed\",\"epoch\":\(epoch(path))}".utf8)
        }
        if request.op == "begin" || request.op == "capture" {
            guard let output=request.outputPath, let id=request.id else { throw Failure("invalid_request") }
            let dir=URL(fileURLWithPath:output).deletingLastPathComponent()
            let t:Target, session:String
            if request.op == "begin" { (t,session)=try await select(request,dir:dir) }
            else { guard let f=request.scope,let s=f.backgroundSession else { throw Failure("invalid_scope") };t=try permitted(f,dir:dir);session=s }
            /*
             * 木を 2 度読んで、撮った写真と一致していることを確かめる。
             * **一度違っただけで諦めない。**読み直す。
             *
             * 目的は「この写真の上で決めた操作が、いまの木に対して有効である」ことで、
             * それは読み直しても成り立つ。開いた直後の Web ページは木が落ち着くまで
             * 揺れていて（実測 2026-09-22: 読み込み 2.5 秒後の Chrome で一致せず）、
             * `begin` は再試行の輪の外にあるため、**その揺れ 1 回で走行全体が終わっていた**
             * （`target_changed`・操作 0・10 秒）。
             * 揺れが収まらないなら、やはり断る——落ち着かない画面では操作を決められない。
             */
            var elements=try tree(t)
            var image: CGImage!, png: Data!
            var settled=false
            for attempt in 0..<3 {
                (image,png)=try await capture(t)
                let again=try tree(t)
                if again == elements { settled=true; break }
                stage("tree-unsettled attempt=\(attempt)")
                elements=again
                try await Task.sleep(nanoseconds: 400_000_000)
            }
            guard settled else { throw Failure("target_changed") }
            var frame=Frame(id:id,bundleId:t.bundleId,windowId:t.windowId,pid:t.pid,capturedAt:Date().timeIntervalSince1970*1000,
                            width:image.width,height:image.height,bounds:t.bounds,sha256:digest(png))
            frame.deliveryMode="background";frame.backgroundSession=session
            // この写真がどの世代のものかを刻む。送るときに今の世代と突き合わせる。
            frame.backgroundEpoch=epoch(try sessionPath(dir,session))
            _ = try permitted(frame,dir:dir)
            let snapshot=Snapshot(frame:frame,generation:try generation(t.pid,bundle:t.bundleId),elements:elements)
            try Helper.privateWrite(png,id:id,path:output)
            try privateFile(JSONEncoder().encode(snapshot),output+".snapshot.json")
            /*
             * 候補の一覧も返す。**位置は返さない。**
             * モデルに渡すのは「何があるか」だけで、どこにあるかは選ばれた後に
             * こちらが取り直す。座標を当てさせないための形。
             * 画面から読んだ文字（title）は信用できない入力なので、そのまま渡すが
             * 長さを切る。値そのもの（入力欄の中身）は載せない。
             */
            var payload=try JSONSerialization.jsonObject(with:JSONEncoder().encode(frame)) as? [String:Any] ?? [:]
            payload["elements"]=elements.prefix(60).map { e in
                ["id":e.id,"role":e.role,
                 "name":String(([e.identifier,e.title,e.detail].first { !$0.isEmpty } ?? "").prefix(60))]
            }
            return try JSONSerialization.data(withJSONObject:payload,options:[.sortedKeys])
        }
        guard request.op == "apply",let f=request.scope,let a=request.action,let reference=request.referencePath,
              URL(fileURLWithPath:reference).lastPathComponent == "\(f.id).png",
              let expires=request.authorizationExpiresAt,expires>Date().timeIntervalSince1970*1000,
              Date().timeIntervalSince1970*1000-f.capturedAt <= 60_000 else { throw Failure("invalid_request") }
        let dir=URL(fileURLWithPath:reference).deletingLastPathComponent()
        /*
         * 承認・対象・停止に加えて、**実行世代**を見る。
         * 人が一度でも割り込んでいれば世代は進んでいて、この写真の上で決まった操作は
         * もう古い画面に向けたものになる。送る前・送る直前・1 打ごとに同じ物差しで見る。
         */
        let sessionFile=try sessionPath(dir, f.backgroundSession ?? "")
        func current() throws -> Target {
            let scope=try permitted(f,dir:dir)
            guard (f.backgroundEpoch ?? 0) == epoch(sessionFile) else { throw Failure("stale_generation") }
            return scope
        }
        let t=try current()
        let snapshot=try readPrivate(Snapshot.self,reference+".snapshot.json")
        guard snapshot.frame.id == f.id, snapshot.frame.sha256 == f.sha256,
              snapshot.frame.bundleId == f.bundleId, snapshot.frame.bounds == f.bounds,
              snapshot.frame.width == f.width, snapshot.frame.height == f.height,
              snapshot.frame.capturedAt == f.capturedAt,
              snapshot.frame.backgroundSession == f.backgroundSession,
              snapshot.frame.pid == f.pid, snapshot.frame.windowId == f.windowId,
              try generation(t.pid,bundle:t.bundleId) == snapshot.generation else { throw Failure("stale_frame") }
        /*
         * 対象の決め方は 2 通り。**要素で指せるならそちらを使う。**
         * 撮影時に枠を取ってあるので、モデルは「どれか」だけ選べばよく、
         * 位置はここで取り直す。座標指定は、AX に現れない対象のために残す。
         */
        var chosen: Element?
        if let wanted=a.elementId {
            guard let found=snapshot.elements.first(where:{ $0.id == wanted })
            else { throw Failure("background_target_unresolved") }
            chosen = found
        }
        let chosenRect = chosen.map { CGRect(x:$0.x,y:$0.y,width:$0.width,height:$0.height) }
        let p: CGPoint
        if let rect=chosenRect { p = point(rect, t.bounds) } else { p = try point(a,f,t.bounds) }
        let local=CGPoint(x:p.x-t.bounds.x, y:p.y-t.bounds.y)

        // 経路によらず禁じているもの。能力の不足ではないので、別経路でも回避させない。
        if secureFieldContains(p, in: t) { throw Failure("policy_secure_field") }

        /*
         * **配送経路は送る前に 1 つ決める。**送ってみて駄目だったから別経路、はしない。
         * 効果が分からないまま撒き直すと二重実行になる（表示が遅れただけかもしれない）。
         *  - 同じ意味を AX で表せるなら AX を優先する（ボタン＝AXPress、欄の値＝AXValue）。
         *  - キーの押下／解放は AXValue で代用しない。練習サイトは物理キーで判定する。
         *  - AX に操作の無い絵を押すときだけ、対象を指定した背景マウスを使う。
         */
        enum Route: String { case axPress = "ax_press", axValue = "ax_value",
                             nativeMouse = "native_mouse", nativeKey = "native_key" }
        var route: Route
        var element: AXUIElement?
        var codes: [CGKeyCode] = []

        switch a.action {
        case "key":
            guard let name=a.key, let code=NativeInput.keyCode(forName:name)
            else { throw Failure("policy_action_not_allowed") }
            guard PrivateSPI.available else { throw Failure("background_key_route_unavailable") }
            guard keyWindowIsTarget(t) else { throw Failure("background_key_window_not_focused") }
            route = .nativeKey; codes = [code]
        case "type_keys":
            guard let text=a.text, text.utf16.count<=400, NativeInput.typable(text)
            else { throw Failure("policy_text_rejected") }
            guard PrivateSPI.available else { throw Failure("background_key_route_unavailable") }
            // 狙った窓が鍵を受け取る窓でなければ、送らない。別の窓へ落ちるだけなので。
            guard keyWindowIsTarget(t) else { throw Failure("background_key_window_not_focused") }
            /*
             * 鍵は**窓の中で焦点のある所**へ届く。どこに焦点があるかは呼ぶ側に分からないので、
             * 欄を指してきたならその欄へ先に焦点を移す。移すのは AX の属性で、
             * 合成した入力ではない（窓の外へは何も出ない）。
             * 指してこなければ従来どおり、いま焦点のある所へ打つ。
             */
            // 要素で指されていればそれ。座標で指されたなら、その点にある文字の欄。
            let aimed: Element? = chosen ?? snapshot.elements.first { e in
                CGRect(x:t.bounds.x+e.x,y:t.bounds.y+e.y,width:e.width,height:e.height).contains(p)
                && [kAXTextFieldRole,kAXTextAreaRole].contains(e.role)
            }
            if let want=aimed {
                let resolved=try resolve(want.path,in:t)
                guard describe(resolved,path:want.path,bounds:t.bounds) == want else { throw Failure("target_changed") }
                guard [kAXTextFieldRole,kAXTextAreaRole].contains(want.role) else { throw Failure("policy_action_not_allowed") }
                // 伏せ字の欄へは打たない。経路の問題ではないので、ここでも同じく断る。
                guard string(resolved,kAXSubroleAttribute) != kAXSecureTextFieldSubrole
                else { throw Failure("policy_secure_field") }
                guard attribute(resolved,kAXEnabledAttribute) as? Bool != false else { throw Failure("background_disabled") }
                var settable:DarwinBoolean=false
                if AXUIElementIsAttributeSettable(resolved,kAXFocusedAttribute as CFString,&settable) == .success,
                   settable.boolValue {
                    AXUIElementSetAttributeValue(resolved,kAXFocusedAttribute as CFString,kCFBooleanTrue)
                }
                element = resolved
            }
            route = .nativeKey; codes = text.lowercased().compactMap { NativeInput.keyCodes[$0] }
        case "click", "type":
            // 要素で指されていれば、その 1 つが候補。座標指定のときだけ点から絞る。
            let candidates: [Element] = chosen.map { [$0] } ?? snapshot.elements.filter { e in
                CGRect(x:t.bounds.x+e.x,y:t.bounds.y+e.y,width:e.width,height:e.height).contains(p)
                && (a.action == "click" ? e.role == kAXButtonRole : [kAXTextFieldRole,kAXTextAreaRole].contains(e.role))
            }
            // 文字を入れる先は、文字を入れられる役割であること。絵やリンクには書かない。
            if a.action == "type", let only=candidates.first,
               ![kAXTextFieldRole,kAXTextAreaRole].contains(only.role) { throw Failure("policy_action_not_allowed") }
            guard candidates.count <= 1 else { throw Failure("background_element_ambiguous") }
            if let old=candidates.first {
                let resolved=try resolve(old.path,in:t)
                guard describe(resolved,path:old.path,bounds:t.bounds) == old else { throw Failure("target_changed") }
                if attribute(resolved,kAXEnabledAttribute) as? Bool == false { throw Failure("background_disabled") }
                element = resolved
            }
            if a.action == "type" {
                // 値を設定する経路は、対象が AX で特定できたときだけ。座標では書かない。
                guard let resolved=element else { throw Failure("background_target_unresolved") }
                guard let text=a.text,!text.isEmpty,text.utf16.count<=2000,
                      text.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 })
                else { throw Failure("policy_text_rejected") }
                guard string(resolved,kAXValueAttribute).isEmpty else { throw Failure("background_field_not_empty") }
                var settable:DarwinBoolean=false
                guard AXUIElementIsAttributeSettable(resolved,kAXValueAttribute as CFString,&settable) == .success,
                      settable.boolValue else { throw Failure("background_no_text_delivery") }
                route = .axValue
            } else if let resolved=element {
                guard attribute(resolved,kAXEnabledAttribute) as? Bool == true else { throw Failure("background_disabled") }
                // AXPress が空振りするアプリ／Web の中身。枠は取れているので、そのまま押す。
                if pressIgnored.contains(t.bundleId) || insideWebContent(resolved) {
                    guard PrivateSPI.available else { throw Failure("background_spi_unavailable") }
                    route = .nativeMouse; break
                }
                var actions:CFArray?
                guard AXUIElementCopyActionNames(resolved,&actions) == .success,
                      (actions as? [String])?.contains(kAXPressAction) == true
                else {
                    // AXPress を持たないボタン。座標で押す経路があるならそちらへ。
                    guard PrivateSPI.available else { throw Failure("background_no_press_action") }
                    route = .nativeMouse; break
                }
                route = .axPress
            } else {
                // AX に現れない対象（onclick だけの画像など）。許された窓の中の座標として押す。
                guard PrivateSPI.available else { throw Failure("background_spi_unavailable") }
                guard t.bounds.rect.contains(p) else { throw Failure("background_target_unresolved") }
                route = .nativeMouse
            }
        default:
            throw Failure("policy_action_not_allowed")
        }

        // 送る直前にもう一度、承認・対象・停止・世代を見る。ここから先は取り消せない。
        _ = try current()
        guard expires>Date().timeIntervalSince1970*1000 else { throw Failure("approval_expired") }
        try privateFile(Data("attempted".utf8),reference+".used") // 効果が不明でも再送しない印。
        /*
         * 自分の入力を「人が触った」と数えないための印。
         * Chromium に受け付けさせるには焦点を対象へ移す必要があり（focusWithoutRaise）、
         * それが見張りにはアクティブ化として見える。**自分が出した分だけ**を除くため、
         * 操作の直前に置き、終わったら消す。人が本当に触った場合は、この窓の外か、
         * 直後の permitted() の前面検査で捕まる。
         */
        let actingPath = sessionFile
        unlink(actingPath+".acting")
        try? privateFile(Data("acting".utf8), actingPath+".acting")
        defer { unlink(actingPath+".acting") }
        let front=NSWorkspace.shared.frontmostApplication?.processIdentifier
        let clipboard=NSPasteboard.general.changeCount
        let markerRect = chosenRect.map { CGRect(x:t.bounds.x+$0.minX,y:t.bounds.y+$0.minY,width:$0.width,height:$0.height) }
                         ?? screenRect(a,f,t.bounds)
        /*
         * 前回どこを触ったかを、この許可の中だけで覚えておく。
         * 印がそこから滑ってくるので、「どこからどこへ動いたか」が見える。
         * 座標だけで、画面の中身や入力した文字は残さない。
         */
        let pointerPath = actingPath + ".pointer"
        let previous: CGPoint? = {
            guard let data = FileManager.default.contents(atPath: pointerPath),
                  let saved = try? JSONDecoder().decode([Double].self, from: data), saved.count == 2,
                  saved.allSatisfy({ $0.isFinite }) else { return nil }
            return CGPoint(x: saved[0], y: saved[1])
        }()
        unlink(pointerPath)
        try? privateFile(try JSONEncoder().encode([p.x, p.y]), pointerPath)
        // 操作しているアプリの名前を札に出す。手前の別アプリと取り違えられないように。
        let targetName = NSRunningApplication(processIdentifier: t.pid)?.localizedName
        let marker=indicator(around:markerRect,window:t.windowId,from:previous,target:targetName)
        defer { marker?.orderOut(nil) }

        // どの経路でどこを押したか。座標と経路だけで、画面の中身や打った文字は残さない。
        stage("route \(route.rawValue) by \(chosen == nil ? "coords" : "element") point \(Int(p.x)),\(Int(p.y)) local \(Int(local.x)),\(Int(local.y))")
        var effect = "unconfirmed"
        switch route {
        case .axPress:
            guard AXUIElementPerformAction(element!,kAXPressAction as CFString) == .success
            else { throw Failure("input_effect_unconfirmed") }
        case .axValue:
            guard AXUIElementSetAttributeValue(element!,kAXValueAttribute as CFString,a.text! as CFString) == .success
            else { throw Failure("input_effect_unconfirmed") }
        case .nativeMouse:
            if case .notSent(let code) = await NativeInput.click(pid:t.pid,window:t.windowId,screen:p,local:local) {
                throw Failure(code)   // 未送信。呼び出し側は別の手を選んでよい。
            }
        case .nativeKey:
            // 1 打ごとに停止を見る。止まったら、押した鍵だけを同じ対象へ解放して終える。
            let outcome = await NativeInput.keys(codes,pid:t.pid,window:t.windowId,
                                                 stillAllowed:{ (try? current()) != nil })
            if case .notSent(let code) = outcome { throw Failure(code) }
        }
        try await Task.sleep(nanoseconds:100_000_000)
        /*
         * 送った後に人の側が動いていないこと。止める判断は変えないが、
         * **何が動いたのかは残す。**符号が一つだと、前面が変わったのか写しが変わったのか、
         * 前面なら対象自身が出てきたのか別のアプリなのかが分からず、直しようがなかった。
         * 残すのは種類だけで、アプリの名前も写しの中身も書かない。
         */
        let nowFront = NSWorkspace.shared.frontmostApplication?.processIdentifier
        if nowFront != front || NSPasteboard.general.changeCount != clipboard {
            stage("interference " + (nowFront == front ? "clipboard"
                : nowFront == t.pid ? "target-activated" : "other-activated"))
            throw Failure("background_interference")
        }
        _ = try current()
        // 効果を確かめられるのは値の設定だけ。他は「送った」までしか言わない。
        if route == .axValue {
            guard string(element!,kAXValueAttribute) == a.text else { throw Failure("input_effect_unconfirmed") }
            effect = "confirmed"
        } else if route == .nativeKey, a.action == "type_keys", let resolved = element,
                  let text = a.text, let after = attribute(resolved, kAXValueAttribute) as? String {
            /*
             * 鍵で打ったときは、**変わったかどうかでは足りない。頼んだ文字になったか**を見る。
             * 実測（Launchloom IME が有効な macOS 26.6.2）: `genie` と打つと欄には
             * 「げに絵」が入った。鍵は物理の打鍵なので、入力方式がかな変換をすれば
             * 別の文字になる。それでも「変わった」ので、以前は確認済みと名乗っていた——
             * **届いていない文字を届いたことにしていた。**
             */
            guard after.contains(text) else {
                stage("keys-not-literal")
                throw Failure("background_keys_not_literal")
            }
            effect = "confirmed"
        } else if let picked = chosen, let resolved = element,
                  let now = describe(resolved, path: picked.path, bounds: t.bounds) {
            /*
             * 要素で指したときは、その要素を読み直せば効果を見られる。
             * 変わっていれば確認済み。**変わらなければ未確認のままにする**——
             * 表示が遅れているだけかもしれないので、ここで成功とは言わない。
             */
            if now != picked { effect = "confirmed" }
        }
        // 操作が済んだあとも印を残す。100ms では目で追えない。
        if marker != nil { try await Task.sleep(nanoseconds: Marker.hold) }
        return Data("{\"status\":\"applied\",\"deliveryMode\":\"background\",\"route\":\"\(route.rawValue)\",\"effect\":\"\(effect)\"}".utf8)
    }
    static func watch(_ path:String) throws {
        let grant=try readPrivate(Grant.self,path)
        /*
         * 何を見て止めたのかを残す。人が触ったのか、こちらが出した入力を拾ったのかで、
         * 直すべき場所が違う。値は理由の名前だけで、画面の中身は書かない。
         */
        /*
         * こちらが出した分だけを除く印。**除いてよいのは `target-activated` だけ。**
         *
         * 以前はこの印が立っている 2 秒の間、**理由を問わず**割り込みを落としていた。
         * つまり、こちらが操作している最中に人が対象を押しても、その 1 回は無かったことに
         * なっていた——人の操作を奪わないための見張りが、いちばん奪いやすい瞬間だけ
         * 目を閉じていたことになる。
         *
         * 除く必要があるのは 1 つだけ。Chromium に鍵を受け取らせるには焦点を対象へ
         * 移す（focusWithoutRaise）必要があり、それが見張りにはアクティブ化として見える。
         * 人の手が出す事象（ポインタ・打鍵）は合成入力とは別の経路で届くので、
         * 印の有無に関わらず数える。
         */
        func selfInflicted(_ reason: String) -> Bool {
            guard reason == "target-activated" else { return false }
            guard let acted = try? FileManager.default.attributesOfItem(atPath:path+".acting")[.modificationDate] as? Date
            else { return false }
            return Date().timeIntervalSince(acted) < 2
        }
        func interrupted(_ reason: String = "unknown") {
            if selfInflicted(reason) { return }
            // 人の手が動いた時刻は、止まっているかどうかに関わらず残す。再開の判断に要る。
            markHumanInput(path)
            if FileManager.default.fileExists(atPath:path+".interrupted") { return }
            /*
             * 印と世代は**この順で**置く。先に世代を進めるのは、割り込みの印を見た側が
             * 止まる前に、古い世代の操作が 1 つ通り抜けるのを防ぐため。
             * 進められなければ印も置かずに死ぬ（生きた鼓動のまま証拠を失わない）。
             */
            do {
                try advanceEpoch(path)
                try privateFile(Data("human_takeover:\(reason)".utf8),path+".interrupted")
            }
            catch { exit(2) } // A dead watcher is rejected; never keep a healthy heartbeat after losing takeover evidence.
        }
        let observer=NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main) { notification in
            MainActor.assumeIsolated {
                if (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier == grant.pid { interrupted("target-activated") }
            }
        }
        let monitor=NSEvent.addGlobalMonitorForEvents(matching:[.leftMouseDown,.rightMouseDown,.otherMouseDown,.scrollWheel,.keyDown]) { event in
            MainActor.assumeIsolated {
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == grant.pid { interrupted("target-frontmost-input"); return }
                if event.type != .keyDown {
                    guard let p=event.cgEvent?.location else { interrupted("event-without-location"); return }
                    if Helper.topmost(at:p,is:grant.window) { interrupted("pointer-over-target") }
                }
            }
        }
        guard monitor != nil else { throw Failure("background_monitor_unavailable") }
        watchers[path] = (observer, monitor!)
        try privateFile(JSONEncoder().encode(getpid()),path+".watching")
        Timer.scheduledTimer(withTimeInterval:0.2,repeats:true) { _ in
            MainActor.assumeIsolated {
                do { try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: path+".watching") }
                catch { exit(2) }
                if Date().timeIntervalSince1970 >= grant.expires || !FileManager.default.fileExists(atPath:path) {
                    if let tokens = watchers.removeValue(forKey: path) {
                        NSWorkspace.shared.notificationCenter.removeObserver(tokens.0)
                        NSEvent.removeMonitor(tokens.1)
                    }
                    for suffix in ["", ".watching", ".interrupted", ".acting", ".pointer", ".epoch", ".lastinput"] { try? FileManager.default.removeItem(atPath:path+suffix) }
                    exit(0)
                }
            }
        }
    }
}

/// 申告する能力は、実際に選べる経路と一致させる。SPI が無ければ後ろ 3 つは出さない。
@MainActor func capabilities() -> [String] {
    var list = ["ax_press", "empty_text_field"]
    if PrivateSPI.available { list += ["native_click", "native_keys", "space_key"] }
    return list
}

#if GENIE_BACKGROUND
@main struct BackgroundMain {
    static func main() {
        let app=NSApplication.shared;app.setActivationPolicy(.accessory)
        if CommandLine.arguments.contains("--status") {
            let supported:Bool;if #available(macOS 14.4,*) { supported=true } else { supported=false }
            let ax=AXIsProcessTrusted(), screen=CGPreflightScreenCaptureAccess()
            /*
             * 試験専用の経路が入っているかを、**実行ファイル自身に言わせる。**
             * 入っているものを本番と取り違えないための印で、出荷ビルドでは false。
             */
            var unattended=false
            #if GENIE_UNATTENDED_TEST
            unattended=true
            #endif
            let data=try! JSONSerialization.data(withJSONObject:["ready":supported && ax && screen,"supported":supported,"accessibility":ax,"screenRecording":screen,"deliveryMode":"background","capabilities":capabilities(),"unattendedTest":unattended],options:[.sortedKeys])
            FileHandle.standardOutput.write(data);print("");return
        }
        Task { @MainActor in
            do {
                guard #available(macOS 14.4,*) else { throw Failure("macos_14_4_required") }
                if CommandLine.arguments.count == 3,CommandLine.arguments[1] == "--watch" { try BackgroundAX.watch(CommandLine.arguments[2]);return }
                let input=FileHandle.standardInput.readDataToEndOfFile()
                guard input.count<=128*1024 else { throw Failure("invalid_request") }
                let result=try await BackgroundAX.respond(JSONDecoder().decode(Request.self,from:input))
                FileHandle.standardOutput.write(result);exit(0)
            } catch {
                let code=(error as? Failure)?.code ?? "background_failed"
                FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject:["error":code]));exit(1)
            }
        }
        app.run()
    }
}
#endif
