import AppKit
import SwiftUI

/// 画面操作が「いま見ている画面」（DESIGN.md §8.1）。
///
/// 写真は画面操作（端末の agent host）が読み取りのために撮ったもの。どれが最新かを
/// `VisualContext/live.json` が示す（`workers/agent-host/src/live-screen.ts`）。ここは読むだけで、
/// 新しく撮らない・外へ送らない。注文などを、対象の窓を前に出さずに本人が追えるようにする。
struct LiveScreenFrame: Equatable {
    let imageURL: URL
    let capturedAt: Date
    /// 操作しているページの出所（`www.mcdonalds.co.jp`）。取れないときは nil。
    let host: String?

    /// これより古い写真は出さない（止まった画面を「いま」と見せない）。
    static let staleAfter: TimeInterval = 10

    /// `live.json` を読む。形が違う・古い・置き場所の外を指すものは nil（任意の文字列をパスにしない）。
    static func parse(_ data: Data, directory: URL, now: Date) -> LiveScreenFrame? {
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              raw["schema"] as? Int == 1,
              let image = raw["image"] as? String,
              image.range(of: "^cv-[a-f0-9-]{1,64}\\.png$", options: .regularExpression) != nil,
              let at = raw["at"] as? Double else { return nil }
        let captured = Date(timeIntervalSince1970: at / 1000)
        guard now.timeIntervalSince(captured) <= staleAfter, captured.timeIntervalSince(now) < 5 else { return nil }
        let dir = directory.standardizedFileURL.resolvingSymlinksInPath()
        let url = dir.appendingPathComponent(image).standardizedFileURL.resolvingSymlinksInPath()
        guard url.deletingLastPathComponent().path == dir.path else { return nil }
        var host: String?
        if let origin = raw["origin"] as? String, let parsed = URL(string: origin), parsed.scheme == "https" {
            host = parsed.host
        }
        return LiveScreenFrame(imageURL: url, capturedAt: captured, host: host)
    }
}

/// Agent Dock が出ている間だけ、1 秒ごとに `live.json` を読む。
@MainActor
final class LiveScreenFeed: ObservableObject {
    static let shared = LiveScreenFeed()

    @Published private(set) var frame: LiveScreenFrame?
    @Published private(set) var image: NSImage?
    @Published private(set) var now = Date()

    /// 検査: 実際の画面操作が無くても、出た姿を撮る。
    var fixture: (frame: LiveScreenFrame, image: NSImage)? {
        didSet { refresh() }
    }

    private var timer: Timer?
    private var watchers = 0

    func start() {
        watchers += 1
        guard timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in LiveScreenFeed.shared.refresh() }
        }
    }

    func stop() {
        watchers = max(0, watchers - 1)
        guard watchers == 0 else { return }
        timer?.invalidate(); timer = nil
    }

    private func refresh() {
        now = Date()
        if let fixture {
            frame = fixture.frame; image = fixture.image
            return
        }
        let dir = VisualContextStore.handoverDirectory
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("live.json")),
              let next = LiveScreenFrame.parse(data, directory: dir, now: now) else {
            frame = nil; image = nil
            return
        }
        if next.imageURL != frame?.imageURL { image = NSImage(contentsOf: next.imageURL) }
        frame = image == nil ? nil : next
    }
}

/// Agent Dock の段の下に出す、操作中の画面。押せない（操作は Genie と本人の手で行う）。
struct LiveScreenView: View {
    let frame: LiveScreenFrame
    let image: NSImage
    let now: Date
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.medium)
                .aspectRatio(contentMode: .fit)
                // 縁は写真そのものに付ける（枠を幅いっぱいにすると、空の枠の中に小さな写真が浮いて見えた）。
                .clipShape(RoundedRectangle(cornerRadius: Space.radiusSmall))
                .overlay(RoundedRectangle(cornerRadius: Space.radiusSmall)
                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
                .frame(maxWidth: .infinity, maxHeight: Metrics.dockAgentLiveHeight - 24, alignment: .leading)
            Text(Facts.liveScreenCaption(host: frame.host, seconds: max(0, Int(now.timeIntervalSince(frame.capturedAt)))))
                .font(.system(size: S.type(Metrics.dockMetaSize)))
                .foregroundStyle(Palette.muted(dark))
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: Metrics.dockAgentLiveHeight, alignment: .topLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier("liveScreen")
        .accessibilityLabel(Facts.liveScreenCaption(host: frame.host, seconds: max(0, Int(now.timeIntervalSince(frame.capturedAt)))))
    }
}
