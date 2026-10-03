import AppKit
import GenieCore
import CoreServices
import Foundation
import ImageIO

/// スクショを撮った瞬間に、それを**直近の会話コンテキスト**として自動で持つ。
///
/// 体験は「⌘⇧4 で撮る → 『これ何？』」だけ。保存先を開く・ドラッグ・貼り付け・添付はゼロ。
/// 撮っただけでは何も送らない（`AVAILABLE_AS_CONTEXT` まで）。利用者が参照表現で尋ねた瞬間だけ
/// 推論対象になる（`ATTACHED_TO_TURN`）。検知後に**新しいチャットは作らない**——現在の会話に紐付ける。
///
/// **画像の行き先（egress の真実）** — `VisualEgressPolicy`:
///   - 撮っただけ: 送信 0
///   - 質問した: gateway へ行くのは id / kind / label だけ（画素 0）。端末の worker が受け渡し場所から読む
///   - その worker が cloud のモデル（Claude Code = 利用者の Claude）で見るなら、**その瞬間にその画像だけ**が
///     そのプロバイダへ送られる。端末内モデルなら送信 0。「画像は端末から出ない」とは言わない。
///
/// 関連: [[astra-device-boundary]]。

// MARK: - 種類と状態機械

enum VisualKind: String, Equatable {
    case screenshot          // スクショ保存先に書かれた画像
    case clipboardImage      // ⌃⌘⇧4 等でクリップボードへ来た画像（確実にスクショとは限らない）
}

/// 質問した画像がどこまで行くか。**見せる文言はここから**（Facts に登録済み）。
/// 端末内で画像を見るモデルはまだ無いので、既定は cloud（安全側: 「出ない」とは決して言わない）。
enum VisualEgressPolicy: Equatable {
    case localVision
    case cloudVision(provider: String)
    case unavailable

    static var current: VisualEgressPolicy {
        configured(environment: ProcessInfo.processInfo.environment)
    }

    static func configured(environment: [String: String]) -> VisualEgressPolicy {
        if environment["ASTRA_RUNTIME_CONFIGURATION_ERROR"] == "1" { return .unavailable }
        if environment["ASTRA_LOCAL_VISION"] == "1" { return .localVision }
        switch environment["ASTRA_LLM_CLI"] {
        case "codex": return .cloudVision(provider: "OpenAI")
        case "claude_code": return .cloudVision(provider: "Claude")
        case "gemini_api": return .cloudVision(provider: "Google")
        default: return .cloudVision(provider: "接続したモデルの提供元")
        }
    }

    /// 質問したときに画像が端末の外へ出るか。
    var sendsPixelsOffDevice: Bool { if case .cloudVision = self { return true } else { return false } }

    var disclosure: String {
        switch self {
        case .unavailable: return DesktopConnectionBootstrap.issueMessage
        case .localVision: return Facts.screenshotEgressLocal
        case .cloudVision(let provider): return Facts.screenshotEgressCloud.replacingOccurrences(of: "{provider}", with: provider)
        }
    }

    /// 質問で添えたあとの chip の出所。初回は「質問したときだけ {provider} に送信」、以降は「{provider} に送信」。
    /// 端末内モデルなら出さない（送っていないものを送ったと言わない）。
    func provenance(firstTime: Bool) -> String? {
        switch self {
        case .unavailable: return nil
        case .localVision: return nil
        case .cloudVision(let provider):
            // Keep the send condition visible in the compact chip when the
            // provider is not configured. The tooltip retains the full disclosure.
            let label = provider == "接続したモデルの提供元" ? "クラウド" : provider
            return (firstTime ? Facts.screenshotSentFirst : Facts.screenshotSentCompact).replacingOccurrences(of: "{provider}", with: label)
        }
    }
}

/// 受け渡し場所（キャッシュ）の掃除。**決定的**: 期限切れ → 件数の上限 → 総量の上限 の順に古いものから消す。
enum HandoverCache {
    static let ttl: TimeInterval = 30 * 60
    static let maxCount = 20
    static let maxBytes: Int = 200 * 1024 * 1024

    struct Entry: Equatable {
        let url: URL
        let bytes: Int
        let modified: Date
    }

    /// 消すべきもの（古い順）。
    static func plan(_ entries: [Entry], now: Date = Date(), ttl: TimeInterval = ttl,
                     maxCount: Int = maxCount, maxBytes: Int = maxBytes) -> [URL] {
        var doomed: [URL] = []
        var kept = entries.sorted { $0.modified > $1.modified }   // 新しい順
        let expired = kept.filter { now.timeIntervalSince($0.modified) > ttl }
        doomed += expired.map(\.url)
        kept.removeAll { now.timeIntervalSince($0.modified) > ttl }
        while kept.count > maxCount, let last = kept.popLast() { doomed.append(last.url) }
        var total = kept.reduce(0) { $0 + $1.bytes }
        while total > maxBytes, let last = kept.popLast() { doomed.append(last.url); total -= last.bytes }
        return doomed
    }

    static func entries(in directory: URL) -> [Entry] {
        let fm = FileManager.default
        let items = (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
                                                 options: [.skipsHiddenFiles])) ?? []
        return items.filter { $0.pathExtension.lowercased() == "png" }.compactMap { url in
            let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey, .isSymbolicLinkKey])
            // 普通のファイルだけを数える。symlink や特殊ファイルは受け渡し場所のものではない（消しもしない: 触らない）。
            guard v?.isSymbolicLink != true, v?.isRegularFile == true else { return nil }
            return Entry(url: url, bytes: v?.fileSize ?? 0, modified: v?.contentModificationDate ?? .distantPast)
        }
    }

    /// 受け渡し場所は利用者だけが読める（0700）。作ったときと、写すたびに確かめる。
    static func ensureDirectory(_ directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    /// 起動時と添付のたびに呼ぶ。消した数を返す。
    @discardableResult
    static func cleanup(directory: URL, now: Date = Date()) -> Int {
        let doomed = plan(entries(in: directory), now: now)
        for url in doomed { try? FileManager.default.removeItem(at: url) }
        return doomed.count
    }
}

/// IDLE → CANDIDATE → VALIDATED → AVAILABLE_AS_CONTEXT → ATTACHED_TO_TURN → RECENT_CONTEXT → EXPIRED
enum VisualContextState: String, Equatable {
    case candidate           // ファイルができた（まだ書き込み中かもしれない）
    case validated           // サイズが安定し、画像として読める
    case available           // 会話に紐付いた。まだ外部へ出していない
    case attached            // 利用者の質問に添付された（このときだけ推論対象）
    case recent              // 応答が終わった。しばらくは「さっきの」で呼べる
    case expired             // TTL 切れ
}

/// スクショ 1 枚。**出所を持つ**（どのアプリ・どのウィンドウか、取れれば）。
struct VisualContextArtifact: Identifiable, Equatable {
    let id: UUID
    var conversationID: String?
    let imageURL: URL
    let capturedAt: Date
    var sourceApp: String?
    var sourceWindow: String?
    let pixelSize: CGSize
    let confidence: Double
    var kind: VisualKind
    var state: VisualContextState

    /// API へ渡す種類（contracts の TurnAttachment.kind と同じ語）。
    var apiKind: String { kind == .clipboardImage ? "clipboard_image" : "screenshot" }

    /// 「たった今」「1 分前」。UI の chip に出す。
    func ageLabel(_ now: Date = Date()) -> String {
        let s = Int(now.timeIntervalSince(capturedAt))
        if s < 3 { return "たった今" }
        if s < 60 { return "\(s) 秒前" }
        return "\(s / 60) 分前"
    }
}

// MARK: - 分類（ファイル名だけで決めない）

/// スクショらしさを複数条件でスコア化する。ファイル名は**弱い証拠**にしか使わない
/// （OS 言語や設定で名前が変わっても壊れないように）。誤検知しても外部へは出さないので安全側に広く拾う。
enum ScreenshotClassifier {
    /// 設定されたスクショ保存先（`com.apple.screencapture` の location）。無ければデスクトップ。
    static func screenshotDirectory() -> URL {
        if let path = UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "location"),
           !path.isEmpty {
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        }
        return FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0]
    }

    static let imageExts: Set<String> = ["png", "jpg", "jpeg", "heic"]

    /// P(screenshot | file)。0..1。
    /// **前提（ハードゲート）**: 読める画像で寸法が妥当（>= 64px）であること。
    /// 0 バイト・壊れたファイル・アイコンは、ファイル名が何であっても拾わない
    /// （名前は弱い証拠であって、それだけで拾わせない）。
    static func confidence(url: URL, inScreenshotDir: Bool, now: Date = Date()) -> (Double, CGSize, Date) {
        let ext = url.pathExtension.lowercased()
        guard imageExts.contains(ext) else { return (0, .zero, now) }
        // 前提: 実際に読める画像で、寸法が妥当。満たさなければ確度 0。
        // **ヘッダが読めるだけでは足りない。**書き込み途中の PNG も IHDR は先頭にあるので寸法は取れる。
        // 末尾（PNG の IEND / JPEG の FFD9）まで来ていて、ImageIO が complete と言うものだけを画像と見なす。
        guard isCompleteImageFile(url),
              let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              CGImageSourceGetStatusAtIndex(src, 0) == .statusComplete,
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? CGFloat,
              let h = props[kCGImagePropertyPixelHeight] as? CGFloat,
              w >= 64, h >= 64 else { return (0, .zero, now) }
        let size = CGSize(width: w, height: h)

        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let created = (attrs?[.creationDate] as? Date) ?? (attrs?[.modificationDate] as? Date) ?? now
        var score = 0.4   // 読める妥当な画像（前提を満たした）
        if now.timeIntervalSince(created) <= 2.0 { score += 0.25 }   // 直近 2 秒
        if inScreenshotDir { score += 0.25 }                          // 保存先に作られた
        if isSpotlightScreenCapture(url) { score += 0.25 }           // OS が「画面収録」と印している
        // ファイル名の慣例は**弱い証拠**だけ（単独では 0.8 に届かせない）。
        let name = url.lastPathComponent.lowercased()
        if name.contains("screenshot") || name.hasPrefix("スクリーンショット") || name.hasPrefix("cleanshot") {
            score += 0.10
        }
        return (min(1.0, score), size, created)
    }

    /// ファイルの末尾が来ているか。PNG は IEND チャンク（末尾 8 バイト固定）、JPEG は EOI（FFD9）。
    /// HEIC は末尾の印が無いので ImageIO の status に任せる。
    static func isCompleteImageFile(_ url: URL) -> Bool {
        guard let fh = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? fh.close() }
        let end = fh.seekToEndOfFile()
        guard end >= 8 else { return false }
        fh.seek(toFileOffset: end - 8)
        let tail = [UInt8](fh.readData(ofLength: 8))
        switch url.pathExtension.lowercased() {
        case "png":  return tail == [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]   // "IEND" + CRC
        case "jpg", "jpeg": return tail.suffix(2) == [0xFF, 0xD9]
        default: return true
        }
    }

    /// Spotlight の `kMDItemIsScreenCapture`。macOS の ⌘⇧3/4/5 はこれを付ける。
    /// 付いていれば強い証拠。付いていない（索引前・他ツール）ことは反証にしない。
    static func isSpotlightScreenCapture(_ url: URL) -> Bool {
        guard let item = MDItemCreateWithURL(kCFAllocatorDefault, url as CFURL),
              let value = MDItemCopyAttribute(item, "kMDItemIsScreenCapture" as CFString) else { return false }
        return (value as? Bool) ?? false
    }
}

// MARK: - ストア（現在の会話に紐付く）

/// 撮ったスクショの直近リスト。**新しいチャットは作らない**——`bind(conversationID:)` で今の会話に付ける。
@MainActor
final class VisualContextStore: ObservableObject {
    static let shared = VisualContextStore()

    /// 新しい順。UI と resolver が読む。
    @Published private(set) var recent: [VisualContextArtifact] = []
    /// Dock の一瞬のトースト用（撮った直後だけ true、数秒で下げる）。
    @Published var justCaptured: VisualContextArtifact?
    @Published private(set) var offeredCaptureID: UUID?
    var offeredCapture: VisualContextArtifact? {
        recent.first { $0.id == offeredCaptureID }
    }

    func dismissOffer() {
        offeredCaptureID = nil
        justCaptured = nil
        toastTimer?.invalidate()
        WindowCoordinator.shared.endScreenshotOffer()
        WindowCoordinator.shared.syncDockPanels()
    }

    /// 会話に紐付ける前の待ち（会話がまだ無いときも捨てない）。
    private var conversationID: String?
    /// 二重取り込みを防ぐ（path#size を鍵に）。
    private var ingestedKeys: Set<String> = []
    /// 連続撮影を 1 group にまとめる窓（0〜15 秒）。
    static let groupWindow: TimeInterval = 15
    /// RECENT のまま「さっき」で呼べる寿命（受け渡しの TTL と同じ 30 分）。
    static let ttl: TimeInterval = HandoverCache.ttl
    private var toastTimer: Timer?
    /// 検査用: 質問で画像が動いた回数（撮っただけでは 0 のまま）。
    private(set) var attachCount = 0
    /// 検知の一瞬のトースト（〜1 秒）。窓は増やさない。
    static let toastSeconds: TimeInterval = 1.0
    /// 「質問したときだけ {provider} に送信」を明示するのは初回だけ。以降は compact。
    static let disclosedKey = "astra.screenshot.egressDisclosed"
    /// 検査用の上書き（nil なら UserDefaults）。
    static var disclosedOverride: Bool?
    static var egressDisclosed: Bool {
        get { disclosedOverride ?? UserDefaults.standard.bool(forKey: disclosedKey) }
        set { if disclosedOverride != nil { disclosedOverride = newValue } else { UserDefaults.standard.set(newValue, forKey: disclosedKey) } }
    }
    /// 直近の質問で添えた枚数と、そのときの出所文（chip が読む）。
    @Published private(set) var lastProvenance: String?

    /// 端末内の受け渡し場所（**キャッシュ**。質問用の一時コンテキストで、永続領域ではない）。
    /// 質問に添えた瞬間だけ `<id>.png` を写し、端末の worker がここから読む。cloud へは id とラベルしか行かない。
    /// 置き場所は worker（`visual-context.ts`）と同じ規約:
    ///   `ASTRA_VISUAL_CONTEXT_DIR` → `ASTRA_DATA_ROOT/VisualContext` → `~/Library/Caches/Astra/VisualContext（agent hostとの互換パス）`
    static var handoverDirectoryOverride: URL?
    static var handoverDirectory: URL {
        if let o = handoverDirectoryOverride { return o }
        let env = ProcessInfo.processInfo.environment
        if let dir = env["ASTRA_VISUAL_CONTEXT_DIR"], !dir.isEmpty { return URL(fileURLWithPath: dir, isDirectory: true) }
        if let root = env["ASTRA_DATA_ROOT"], !root.isEmpty {
            return URL(fileURLWithPath: root, isDirectory: true).appendingPathComponent("VisualContext", isDirectory: true)
        }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        return caches.appendingPathComponent("Astra", isDirectory: true).appendingPathComponent("VisualContext", isDirectory: true)
    }

    /// id → 受け渡し場所の中の正規パス。**store が知っている id だけ**をここに通す（任意の文字列を path にしない）。
    /// 標準化した結果が受け渡し場所の外を指すなら nil。
    nonisolated static func canonicalHandoverURL(id: String, directory: URL) -> URL? {
        guard id.range(of: "^[a-f0-9-]{1,64}$", options: .regularExpression) != nil else { return nil }
        let dir = directory.standardizedFileURL.resolvingSymlinksInPath()
        let url = dir.appendingPathComponent("\(id).png").standardizedFileURL.resolvingSymlinksInPath()
        guard url.deletingLastPathComponent().path == dir.path else { return nil }
        return url
    }
    func handoverURL(_ id: UUID) -> URL {
        Self.canonicalHandoverURL(id: id.uuidString.lowercased(), directory: Self.handoverDirectory)
            ?? Self.handoverDirectory.appendingPathComponent("\(id.uuidString.lowercased()).png")
    }

    func bind(conversationID: String?, preserving imageIDs: Set<UUID> = []) {
        // 会話が変わった = 前の会話は閉じた。その会話の受け渡し写しは消す（他の会話から再利用させない）。
        if let previous = self.conversationID, let new = conversationID, previous != new {
            // A submitted Home question opens a new conversation. Its selected images
            // must survive cleanup of the previous conversation, including clipboard files.
            for i in recent.indices where imageIDs.contains(recent[i].id) {
                recent[i].conversationID = new
            }
            closeConversation(previous)
        }
        self.conversationID = conversationID
        for i in recent.indices where recent[i].conversationID == nil {
            recent[i].conversationID = conversationID
        }
    }

    /// 会話を閉じる: その会話に紐付いた画像を文脈から外し、受け渡し写しを消す。
    func closeConversation(_ id: String) {
        let gone = recent.filter { $0.conversationID == id }
        gone.forEach(cleanup)
        recent.removeAll { $0.conversationID == id }
    }

    /// 検知が拾った 1 枚を登録する。二重・期限切れを弾き、現在の会話へ付ける。**ここでは外部へ出さない。**
    @discardableResult
    func ingest(url: URL, kind: VisualKind, confidence: Double, pixelSize: CGSize,
                capturedAt: Date, app: String?, window: String?, now: Date = Date()) -> VisualContextArtifact? {
        let key = "\(url.standardizedFileURL.path)#\(Int(pixelSize.width))x\(Int(pixelSize.height))"
        guard !ingestedKeys.contains(key) else { return nil }   // 同じ画像を 2 回拾わない
        ingestedKeys.insert(key)
        var art = VisualContextArtifact(
            id: UUID(), conversationID: conversationID, imageURL: url, capturedAt: capturedAt,
            sourceApp: app, sourceWindow: window, pixelSize: pixelSize, confidence: confidence,
            kind: kind, state: .available)
        purgeExpired(now: now)
        recent.insert(art, at: 0)
        offeredCaptureID = art.id
        if recent.count > 20 { recent.removeLast(recent.count - 20) }
        // 一瞬のトースト。窓は作らない・focus は奪わない（UI 側で chip として描くだけ）。
        justCaptured = art
        WindowCoordinator.shared.syncDockPanels()   // idle Dock を横広トーストへ
        WindowCoordinator.shared.offerScreenshot()
        toastTimer?.invalidate()
        toastTimer = Timer.scheduledTimer(withTimeInterval: Self.toastSeconds, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.justCaptured = nil; WindowCoordinator.shared.syncDockPanels() }
        }
        art.state = .available
        return art
    }

    /// TTL 切れを落とす（受け渡しファイル・クリップボードの一時ファイルも消す）。
    func purgeExpired(now: Date = Date()) {
        let expired = recent.filter { now.timeIntervalSince($0.capturedAt) > Self.ttl }
        expired.forEach(cleanup)
        recent.removeAll { now.timeIntervalSince($0.capturedAt) > Self.ttl }
    }

    /// 端末に残した写しを消す。元のスクショ（利用者のファイル）には触らない。
    private func cleanup(_ art: VisualContextArtifact) {
        try? FileManager.default.removeItem(at: handoverURL(art.id))
        if art.kind == .clipboardImage { try? FileManager.default.removeItem(at: art.imageURL) }
    }

    /// 直近の連続撮影グループ（0〜15 秒以内に固まって撮ったもの、新しい順）。
    func latestGroup(now: Date = Date()) -> [VisualContextArtifact] {
        var group: [VisualContextArtifact] = []
        var prev: Date?
        for a in recent {
            if let p = prev, p.timeIntervalSince(a.capturedAt) > Self.groupWindow { break }
            group.append(a); prev = a.capturedAt
        }
        return group
    }

    /// 質問に添付する（このときだけ推論対象）。添付したものは attached に印す。
    func markAttached(_ arts: [VisualContextArtifact]) {
        let ids = Set(arts.map(\.id))
        for i in recent.indices where ids.contains(recent[i].id) { recent[i].state = .attached }
    }

    /// 質問に添える。**ここが端末内で画像が動く唯一の瞬間**: `visual-context/<id>.png` へ写し、
    /// API へ渡す id とラベルを返す。撮っただけでは呼ばれない。写せなかった枚は添えない（見たふりをさせない）。
    func attach(_ arts: [VisualContextArtifact], now: Date = Date()) -> [TurnAttachment] {
        purgeExpired(now: now)
        // **store が知っていて、この会話のものだけ。** 外から持ち込まれた artifact や、別の会話の画像は添えない。
        let trusted = arts.filter { art in
            recent.contains { $0.id == art.id } && (art.conversationID == nil || art.conversationID == conversationID)
        }
        guard !trusted.isEmpty else { return [] }
        HandoverCache.ensureDirectory(Self.handoverDirectory)
        let newestFirst = trusted.sorted { $0.capturedAt > $1.capturedAt }
        var out: [TurnAttachment] = []
        for (i, art) in newestFirst.enumerated() {
            guard let dst = Self.canonicalHandoverURL(id: art.id.uuidString.lowercased(), directory: Self.handoverDirectory),
                  Self.writePNG(from: art.imageURL, to: dst) else { continue }
            out.append(TurnAttachment(id: art.id.uuidString.lowercased(), kind: art.apiKind,
                                      label: Self.attachmentLabel(art, position: i)))
        }
        if !out.isEmpty {
            attachCount += 1
            // 出所を chip に。初回だけ明示、以降は compact（毎回 privacy 説明が主役にならない）。
            lastProvenance = VisualEgressPolicy.current.provenance(firstTime: !Self.egressDisclosed)
            Self.egressDisclosed = true
            WindowCoordinator.shared.syncDockPanels()
        }
        let writtenIDs = Set(out.map(\.id))
        markAttached(newestFirst.filter { writtenIDs.contains($0.id.uuidString.lowercased()) })
        HandoverCache.cleanup(directory: Self.handoverDirectory, now: now)
        return out
    }

    /// 「スクリーンショット（たった今）」「スクリーンショット（1 つ前）」。gateway の指示語解決と、
    /// 端末のモデル呼び出しへの提示に使う。
    static func attachmentLabel(_ art: VisualContextArtifact, position: Int) -> String {
        let noun = art.kind == .clipboardImage ? "クリップボードの画像" : "スクリーンショット"
        let when = position == 0 ? "たった今" : "\(position) つ前"
        return "\(noun)（\(when)）"
    }

    /// 画像を PNG として写す（元が JPEG/HEIC でも worker は .png を読む）。
    /// 写す先に何かあれば（symlink を含めて）先に消す —— **リンクを辿って外へ書かない**。写しは 0600。
    static func writePNG(from src: URL, to dst: URL) -> Bool {
        if let attrs = try? FileManager.default.attributesOfItem(atPath: dst.path) {
            _ = attrs
            try? FileManager.default.removeItem(at: dst)   // removeItem はリンクそのものを消す（先は触らない）
        }
        let ok: Bool
        if src.pathExtension.lowercased() == "png" {
            ok = (try? FileManager.default.copyItem(at: src, to: dst)) != nil
        } else {
            guard let source = CGImageSourceCreateWithURL(src as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                  let dest = CGImageDestinationCreateWithURL(dst as CFURL, "public.png" as CFString, 1, nil) else { return false }
            CGImageDestinationAddImage(dest, image, nil)
            ok = CGImageDestinationFinalize(dest)
        }
        guard ok else { return false }
        // 普通のファイルとして書けたことを確かめる（symlink や特殊ファイルに化けていない）。
        let v = try? dst.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard v?.isRegularFile == true, v?.isSymbolicLink != true else { try? FileManager.default.removeItem(at: dst); return false }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dst.path)
        return true
    }

    /// 応答が終わった。attached → recent（しばらくは「さっきの」で呼べる）。
    func markRecent(_ arts: [VisualContextArtifact]) {
        let ids = Set(arts.map(\.id))
        for i in recent.indices where ids.contains(recent[i].id) && recent[i].state == .attached {
            recent[i].state = .recent
        }
    }

    /// コンテキストから外す（≤1 操作）。端末に残した写しも消す。
    func remove(_ id: UUID) {
        if offeredCaptureID == id { dismissOffer() }
        recent.filter { $0.id == id }.forEach(cleanup)
        recent.removeAll { $0.id == id }
    }

    /// 検査・リセット用。
    func reset() {
        recent.forEach(cleanup)
        recent = []; ingestedKeys = []; justCaptured = nil; conversationID = nil; attachCount = 0; lastProvenance = nil
        offeredCaptureID = nil
        toastTimer?.invalidate()
    }
}

// MARK: - 参照表現の解決

/// 「これ」「さっき」「この 2 枚」などを、直近スクショの具体的な集合に変える。
enum VisualReferenceResolver {
    /// 単数の参照表現（→ 最新 1 枚）。
    static let singular = ["これ", "ここ", "この画面", "このエラー", "この写真", "この画像",
                           "今の", "いまの", "スクショ", "スクリーンショット", "画像を", "画面を"]
    /// 1 つ前を指す表現（→ 2 枚あれば前の 1 枚、1 枚しか無ければそれ）。
    static let previous = ["さっき", "先ほど", "前の", "ひとつ前", "一つ前"]
    /// 参照表現かどうか（画像の有無に依らず、文だけで判定）。
    static func isReferential(_ text: String) -> Bool {
        mentionsAny(text, singular) || mentionsAny(text, previous)
            || wantsTwo(text) || wantsThree(text) || wantsPrevAndNow(text)
    }

    private static func mentionsAny(_ text: String, _ words: [String]) -> Bool {
        words.contains { text.contains($0) }
    }
    private static func wantsTwo(_ t: String) -> Bool { t.contains("2枚") || t.contains("２枚") || t.contains("二枚") || t.contains("両方") }
    private static func wantsThree(_ t: String) -> Bool { t.contains("3枚") || t.contains("３枚") || t.contains("三枚") }
    private static func wantsPrevAndNow(_ t: String) -> Bool {
        (t.contains("さっきの") && t.contains("今の")) || (t.contains("前の") && t.contains("今")) || t.contains("さっきのと今")
    }

    struct Resolution { let images: [VisualContextArtifact]; let referential: [VisualContextArtifact] }

    /// 参照表現に対応する画像集合。新しい順。参照でなければ空。
    static func resolve(text: String, recent: [VisualContextArtifact]) -> Resolution {
        guard !recent.isEmpty else { return Resolution(images: [], referential: []) }
        let sorted = recent.sorted { $0.capturedAt > $1.capturedAt }
        if wantsPrevAndNow(text), sorted.count >= 2 {
            return Resolution(images: [sorted[1], sorted[0]], referential: [sorted[1], sorted[0]])
        }
        if wantsThree(text) { let g = Array(sorted.prefix(3)); return Resolution(images: g, referential: g) }
        if wantsTwo(text) { let g = Array(sorted.prefix(2)); return Resolution(images: g, referential: g) }
        // 「さっきの」だけなら 1 つ前。1 枚しか無ければそれを指す（「さっき撮ったやつ」）。
        if mentionsAny(text, previous), !mentionsAny(text, ["今の", "いまの", "これ"]) {
            let p = sorted.count >= 2 ? sorted[1] : sorted[0]
            return Resolution(images: [p], referential: [p])
        }
        if mentionsAny(text, singular) || mentionsAny(text, previous) {
            return Resolution(images: [sorted[0]], referential: [sorted[0]])
        }
        return Resolution(images: [], referential: [])
    }
}
