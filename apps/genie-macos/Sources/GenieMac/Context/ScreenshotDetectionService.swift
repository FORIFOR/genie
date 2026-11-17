import AppKit
import Foundation

/// スクショ保存先とクリップボードを軽く監視し、撮った瞬間を `VisualContextStore` に流す。
///
///   ScreenshotDetectionService
///    ├─ ScreenshotFolderWatcher   （DispatchSource で即時。FSEvents の数秒遅延を避ける）
///    ├─ ClipboardImageWatcher     （changeCount を軽量に polling）
///    ├─ ScreenshotClassifier      （ファイル名だけで決めない）
///    └─ VisualContextStore        （現在の会話へ紐付け・外部へは出さない）

// MARK: - フォルダ監視

final class ScreenshotFolderWatcher {
    // All filesystem work and watcher state belong to this queue. A protected or
    // disconnected directory may block in open/readdir without freezing AppKit.
    private let queue = DispatchQueue(label: "astra.screenshot.watch", qos: .utility)
    private var source: DispatchSourceFileSystemObject?
    private var known: Set<String>?
    private var privacy: RegistrationPrivacyGuard.Observation?
    private let readNames: (URL) -> Set<String>?
    private let onChange: ([URL]) -> Void

    init(readNames: @escaping (URL) -> Set<String>? = ScreenshotFolderWatcher.imageNames,
         onChange: @escaping ([URL]) -> Void) {
        self.readNames = readNames
        self.onChange = onChange
    }

    func start(directory: URL) {
        queue.async { [self] in
            source?.cancel(); source = nil
            privacy = try? RegistrationPrivacyGuard.observe()
            known = readNames(directory)
            let fd = open(directory.path, O_EVTONLY)
            guard fd >= 0 else { return }
            let src = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd, eventMask: [.write, .extend, .rename], queue: queue)
            src.setEventHandler { [weak self] in
                guard let self, let now = self.readNames(directory) else { return }
                let currentPrivacy = try? RegistrationPrivacyGuard.observe()
                defer { self.known = now; self.privacy = currentPrivacy }
                // A failed initial read must not turn old files into new captures.
                // Keep the checkpoint across delayed OS notifications as well.
                guard let before = self.known, let privacy = self.privacy,
                      (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return }
                self.onChange(now.subtracting(before).map { directory.appendingPathComponent($0) })
            }
            src.setCancelHandler { close(fd) }
            src.resume()
            source = src
        }
    }

    func stop() {
        queue.async { [self] in source?.cancel(); source = nil; known = nil; privacy = nil }
    }

    private static func imageNames(in dir: URL) -> Set<String>? {
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return nil }
        return Set(items.filter { !$0.hasPrefix(".") && ScreenshotClassifier.imageExts.contains(($0 as NSString).pathExtension.lowercased()) })
    }
}

// MARK: - クリップボード監視

final class ClipboardImageWatcher {
    private var lastChangeCount = NSPasteboard.general.changeCount
    private var lastPrivacy = try? RegistrationPrivacyGuard.observe()
    private var timer: Timer?
    private let onImage: (NSImage) -> Void

    init(onImage: @escaping (NSImage) -> Void) { self.onImage = onImage }

    func start() {
        lastChangeCount = NSPasteboard.general.changeCount
        lastPrivacy = try? RegistrationPrivacyGuard.observe()
        // 0.4s 間隔。クリップボードは軽く見るだけ（CPU をほぼ使わない）。
        let t = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }
    func stop() { timer?.invalidate(); timer = nil }

    func poll() {
        let board = NSPasteboard.general
        guard board.changeCount != lastChangeCount else { return }
        lastChangeCount = board.changeCount
        defer { lastPrivacy = try? RegistrationPrivacyGuard.observe() }
        guard let previous = lastPrivacy, (try? RegistrationPrivacyGuard.validate(previous)) != nil else { return }
        guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked else { return }
        guard board.canReadObject(forClasses: [NSImage.self], options: nil),
              let img = board.readObjects(forClasses: [NSImage.self], options: nil)?.first as? NSImage
        else { return }
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return }
        onImage(img)
    }
}

// MARK: - オーケストレータ

@MainActor
final class ScreenshotDetectionService {
    static let shared = ScreenshotDetectionService()

    private var folderWatcher: ScreenshotFolderWatcher?
    private let clipboard = ClipboardImageWatcherHolder()
    private var generation = UUID()
    private var running = false

    /// 起動時に呼ぶ。保存先を監視し、クリップボード画像も拾う。
    /// `directory` は検査用（実運用は設定された保存先）。
    func start(directory: URL? = nil) {
        guard !running else { return }
        running = true
        // 起動時の掃除: 前回の受け渡し写し（30 分 / 20 件 / 200MB を超えたもの）を消す。
        HandoverCache.cleanup(directory: VisualContextStore.handoverDirectory)
        let dir = directory ?? ScreenshotClassifier.screenshotDirectory()
        let current = UUID()
        generation = current
        let watcher = ScreenshotFolderWatcher { [weak self] urls in
            guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked else { return }
            Task { @MainActor in
                guard let self, self.running, self.generation == current,
                      (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return }
                for url in urls { self.waitStableThenIngest(url: url, dir: dir, generation: current, privacy: privacy) }
            }
        }
        watcher.start(directory: dir)
        folderWatcher = watcher
        clipboard.watcher = ClipboardImageWatcher { [weak self] img in
            guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked else { return }
            Task { @MainActor in
                guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return }
                self?.ingestClipboard(img)
            }
        }
        clipboard.watcher?.start()
    }

    func stop() {
        folderWatcher?.stop(); folderWatcher = nil
        clipboard.watcher?.stop(); clipboard.watcher = nil
        running = false
        generation = UUID()
    }

    /// size(t0) と 50ms 後の size(t1) が同じになったら「安定」とみなして読む。
    /// 安定していても**画像として読めなければ**まだ途中（PNG の末尾が来ていない）。
    /// フォルダの監視は中身の追記では鳴らないので、ここで読めるまで待ち直す（最大 ~2s）。
    private func waitStableThenIngest(url: URL, dir: URL, generation: UUID,
                                     privacy: RegistrationPrivacyGuard.Observation, attempt: Int = 0) {
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return }
        let s0 = fileSize(url)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self, self.running, self.generation == generation,
                  (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return }
            let s1 = self.fileSize(url)
            if s0 == s1 && s1 > 0 && self.ingestFile(url: url, dir: dir) { return }
            if attempt < 40 { self.waitStableThenIngest(url: url, dir: dir, generation: generation, privacy: privacy, attempt: attempt + 1) }
        }
    }

    private func fileSize(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? -1
    }

    /// ファイルを分類して、確度が高ければ会話コンテキストに登録する。**ここでは外部へ出さない。**
    /// 戻り値は「画像として読めたか」（登録したか、または既に登録済みで二重を弾いたか）。
    /// 読めなければ false で、呼び出し側が待ち直す。
    @discardableResult
    func ingestFile(url: URL, dir: URL, now: Date = Date()) -> Bool {
        // A protected capture is dropped, not retried after the browser closes.
        guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked else { return true }
        let inDir = url.deletingLastPathComponent().standardizedFileURL == dir.standardizedFileURL
        let (conf, size, created) = ScreenshotClassifier.confidence(url: url, inScreenshotDir: inDir, now: now)
        guard size.width > 0 else { return false }     // まだ読めない（途中・壊れている・小さすぎる）
        guard conf >= 0.8 else { return true }         // 読めたがスクショらしくない: 待ち直さない
        let front = NSWorkspace.shared.frontmostApplication?.localizedName
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return true }
        VisualContextStore.shared.ingest(
            url: url, kind: .screenshot, confidence: conf, pixelSize: size,
            capturedAt: created, app: front, window: nil, now: now)
        return true
    }

    /// クリップボードの画像。確実にスクショとは限らないので kind を分ける（体験は同じ）。
    func ingestClipboard(_ img: NSImage, now: Date = Date()) {
        guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked else { return }
        guard let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("astra-clipboard", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("clip-\(Int(now.timeIntervalSince1970 * 1000)).png")
        guard (try? png.write(to: url)) != nil else { return }
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { try? FileManager.default.removeItem(at: url); return }
        let size = CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
        guard size.width >= 64, size.height >= 64 else { return }   // アイコン等は拾わない
        let front = NSWorkspace.shared.frontmostApplication?.localizedName
        VisualContextStore.shared.ingest(
            url: url, kind: .clipboardImage, confidence: 0.8, pixelSize: size,
            capturedAt: now, app: front, window: nil, now: now)
    }
}

/// Sendable でない watcher を @MainActor の外に置くための薄い箱。
final class ClipboardImageWatcherHolder { var watcher: ClipboardImageWatcher? }
