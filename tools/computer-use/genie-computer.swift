import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import ScreenCaptureKit
import Foundation

// A narrow JSON-over-stdin helper. No shell, URL, credential or arbitrary file-read commands.
// Screen/window bounds and CGEvent coordinates are both Quartz points (top-left origin).
struct Failure: Error { let code: String; init(_ code: String) { self.code = code } }
struct Bounds: Codable, Equatable {
    let x: Double; let y: Double; let width: Double; let height: Double
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}
struct Frame: Codable {
    let id: String; let bundleId: String; let windowId: UInt32; let pid: Int32
    let capturedAt: Double; let width: Int; let height: Int; let bounds: Bounds; let sha256: String
    var deliveryMode: String? = nil
    var backgroundSession: String? = nil
    /*
     * この写真を撮った時点の**実行世代**。人が割り込むたびに 1 つ進む。
     * 進んだあとに古い世代の写真で操作を送ろうとしても通らない——
     * モデルが考えている間に人が画面を変えていれば、その判断はもう当てにならない。
     * 無い場合は 0 として扱う（前面経路の写真には世代が無い）。
     */
    var backgroundEpoch: Int? = nil
}
struct Action: Decodable {
    let action: String; let frameId: String; let expectation: String
    let confidence: Double; let risk: String; let text: String?; let key: String?
    var textMode: String? = nil
    var direction: String? = nil
    /*
     * 操作対象の指定は 2 通り。**要素で指せるなら、そちらを使う。**
     * 座標はモデルに当てさせる値で、実測では 224x68 のボタンを 95px 外した。
     * 要素の位置は撮影時にこちらが取っているので、推測させる理由が無い。
     */
    let elementId: String?
    let target: [Double]?
}
/// A caller may narrow consent to an owned process; this never grants consent.
struct ExpectedTarget: Decodable {
    let pid: Int32
    let bundleId: String
    enum CodingKeys: String, CodingKey { case pid, bundleId }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        pid = try values.decode(Int32.self, forKey: .pid)
        bundleId = try values.decode(String.self, forKey: .bundleId)
        guard pid > 0, !bundleId.isEmpty, bundleId.count <= 255 else { throw Failure("invalid_expected_target") }
    }
    func matches(pid: Int32, bundleId: String) -> Bool { self.pid == pid && self.bundleId == bundleId }
}
struct Request: Decodable {
    let op: String; let id: String?; let outputPath: String?; let referencePath: String?
    let goal: String?; let recipient: String?; let scope: Frame?; let action: Action?; let authorizationExpiresAt: Double?
    let expectedTarget: ExpectedTarget?
    /// 撮影中に出す状態。いまは "signin"（本人のサインインを待っている）だけ。
    var phase: String? = nil
}
struct Target {
    let bundleId: String; let windowId: UInt32; let pid: Int32; let bounds: Bounds
}
let navigationKeys: [String: CGKeyCode] = ["TAB": 48, "ESC": 53, "LEFT": 123, "RIGHT": 124, "UP": 126, "DOWN": 125]
/** 失敗した段階だけを stderr に残す。画面の中身・入力文字・座標は書かない。 */
func stage(_ name: String) { FileHandle.standardError.write(Data("STAGE \(name)\n".utf8)) }
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func point(_ a: Action, _ f: Frame) throws -> CGPoint { try point(a, f, f.bounds) }
/// 要素の枠（ウィンドウ内座標）から操作点を出す。座標推測を挟まない経路。
func point(_ rect: CGRect, _ b: Bounds) -> CGPoint {
    CGPoint(x: b.x + rect.midX, y: b.y + rect.midY)
}
/// 操作対象の矩形（画面座標）。印を出す位置に使う。判定には使わない。
func screenRect(_ a: Action, _ f: Frame, _ b: Bounds) -> CGRect {
    guard let box = a.target, box.count == 4, f.width > 0, f.height > 0 else { return .zero }
    let sx = b.width / Double(f.width), sy = b.height / Double(f.height)
    return CGRect(x: b.x + box[0] * sx, y: b.y + box[1] * sy,
                  width: (box[2] - box[0]) * sx, height: (box[3] - box[1]) * sy)
}
/// 窓が動いただけなら、同じ画像のまま座標を作り直して続ける。大きさは呼ぶ側が固定する。
func point(_ a: Action, _ f: Frame, _ bounds: Bounds) throws -> CGPoint {
    guard let box = a.target else { throw Failure("invalid_target") }
    guard a.frameId == f.id, box.count == 4, box.allSatisfy({ $0.isFinite }),
          f.width > 0, f.height > 0, f.bounds.width > 0, f.bounds.height > 0,
          f.bounds.x.isFinite, f.bounds.y.isFinite,
          box[0] >= 0, box[1] >= 0,
          box[2] <= Double(f.width), box[3] <= Double(f.height),
          box[2] - box[0] >= 2, box[3] - box[1] >= 2,
          a.confidence >= 0.9, a.confidence <= 1,
          ["navigation", "draft"].contains(a.risk),
          bounds.width == f.bounds.width, bounds.height == f.bounds.height,
          bounds.x.isFinite, bounds.y.isFinite else { throw Failure("invalid_target") }
    return CGPoint(x: bounds.x + (box[0] + box[2]) / 2 / Double(f.width) * bounds.width,
                   y: bounds.y + (box[1] + box[3]) / 2 / Double(f.height) * bounds.height)
}

/*
 * AI 専用のポインター。人のマウスは動かさず、どのアプリをどこで操作しているか示す。
 * 色・寸法の正本は tokens.json。設計と測定は computer-pointer/ROUND.md に記録。
 * show は待たない。呼ぶ側が操作直前に対象・停止・世代を再検証する。
 */
@available(macOS 14.4, *)
@MainActor
enum Marker {
    static let hold = PointerMetrics.holdNanoseconds
    static var accent: NSColor { PointerMetrics.accent }
    private static var current: Panel?
    private static var movement: Timer?
    private static var destination: NSRect?
    private static var destinationTip: NSPoint?
    private static var signature: String?

    final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    /// Geometry is pure so negative-origin, stacked and edge displays can be verified without hardware.
    struct Layout {
        let frame: NSRect
        let focus: NSRect
        let badge: NSRect
        let tip: NSPoint
        let directionX: CGFloat
        let directionY: CGFloat
        let screen: NSRect
    }

    static func layout(rect: CGRect, primaryMaxY: CGFloat, screens: [NSRect], badgeSize: NSSize,
                       compact: Bool) -> Layout? {
        guard rect.width > 2, rect.height > 2,
              [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }) else { return nil }
        let tip = NSPoint(x: rect.midX, y: primaryMaxY - rect.midY)
        guard let screen = screens.first(where: { $0.contains(tip) }) else { return nil }
        let pad = PointerMetrics.focusPadding
        let target = NSRect(x: rect.minX - pad, y: primaryMaxY - rect.maxY - pad,
                            width: rect.width + 2 * pad, height: rect.height + 2 * pad).intersection(screen)
        let edge = PointerMetrics.outerStroke / 2
        let dx: CGFloat = tip.x + PointerMetrics.pointerWidth + edge > screen.maxX ? -1 : 1
        let dy: CGFloat = tip.y - PointerMetrics.pointerHeight - edge < screen.minY ? -1 : 1
        let pointer = Ring.pointerBodyBox(tip, directionX: dx, directionY: dy)
        let glow = Ring.glowBox(tip, directionX: dx, directionY: dy)
        let margin = PointerMetrics.screenMargin
        let width = min(badgeSize.width, max(1, screen.width - 2 * margin))
        var badge = NSRect(x: pointer.maxX + PointerMetrics.badgeGap,
                           y: tip.y - badgeSize.height, width: width, height: badgeSize.height)
        if badge.maxX > screen.maxX - margin { badge.origin.x = pointer.minX - PointerMetrics.badgeGap - width }
        badge.origin.x = min(max(badge.minX, screen.minX + margin), screen.maxX - margin - badge.width)
        badge.origin.y = min(max(badge.minY, screen.minY + margin), screen.maxY - margin - badge.height)
        // AppKit rounds panel origins to screen points. Align the outer frame now,
        // then express the exact action tip inside it, so the glow's fractional
        // center cannot introduce a visible action-point offset at native display.
        let frame = (compact ? pointer : pointer.union(target.insetBy(dx: -edge, dy: -edge))).union(glow).union(badge).integral
        return Layout(frame: frame,
                      focus: target.offsetBy(dx: -frame.minX, dy: -frame.minY),
                      badge: badge.offsetBy(dx: -frame.minX, dy: -frame.minY),
                      tip: NSPoint(x: tip.x - frame.minX, y: tip.y - frame.minY),
                      directionX: dx, directionY: dy, screen: screen)
    }

    final class Ring: NSView {
        var compact = false
        var label = "Genie"
        var status = "操作中"
        var focus = NSRect.zero
        var badge = NSRect.zero
        var tip = NSPoint.zero
        var directionX: CGFloat = 1
        var directionY: CGFloat = 1
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        static var badgeAttributes: [NSAttributedString.Key: Any] {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byTruncatingTail
            return [.font: NSFont.systemFont(ofSize: PointerMetrics.titleSize, weight: .semibold),
                    .foregroundColor: PointerMetrics.text, .paragraphStyle: paragraph]
        }
        static var statusAttributes: [NSAttributedString.Key: Any] {
            var attrs = badgeAttributes
            attrs[.font] = NSFont.systemFont(ofSize: PointerMetrics.statusSize, weight: .regular)
            return attrs
        }
        static func badgeSize(_ label: String, status: String = "操作中") -> NSSize {
            let title = (label as NSString).size(withAttributes: badgeAttributes)
            let state = (status as NSString).size(withAttributes: statusAttributes)
            return NSSize(width: min(PointerMetrics.badgeMaxWidth,
                                     max(PointerMetrics.badgeMinWidth, ceil(max(title.width, state.width)) + 2 * PointerMetrics.badgePaddingH)),
                          height: ceil(title.height) + ceil(state.height) + 2 * PointerMetrics.badgePaddingV)
        }
        static func pointerBodyBox(_ point: NSPoint, directionX: CGFloat = 1, directionY: CGFloat = 1) -> NSRect {
            let width = PointerMetrics.pointerWidth, height = PointerMetrics.pointerHeight
            return NSRect(x: point.x + (directionX < 0 ? -width : 0),
                          y: point.y + (directionY > 0 ? -height : 0), width: width, height: height)
                .insetBy(dx: -PointerMetrics.outerStroke / 2, dy: -PointerMetrics.outerStroke / 2)
        }
        static func glowBox(_ point: NSPoint, directionX: CGFloat = 1, directionY: CGFloat = 1) -> NSRect {
            let center = NSPoint(x: point.x + PointerMetrics.pointerWidth * 0.44 * directionX,
                                 y: point.y - PointerMetrics.pointerHeight * 0.45 * directionY)
            let radius = PointerMetrics.glowRadius
            return NSRect(x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius)
        }
        func pointerPath() -> NSBezierPath {
            let path = NSBezierPath()
            let w = PointerMetrics.pointerWidth, h = PointerMetrics.pointerHeight
            // First vertex is the actual action point; direction only mirrors the remaining body at display edges.
            // A compact stemless dart: the source screenshot's recognizable silhouette,
            // drawn in Genie blue rather than altering the person's system cursor.
            let vertices: [(CGFloat, CGFloat)] = [(0, 0), (1, -0.18), (0.62, -0.52), (0.47, -1)]
            for (index, vertex) in vertices.enumerated() {
                let point = NSPoint(x: tip.x + vertex.0 * w * directionX,
                                    y: tip.y + vertex.1 * h * directionY)
                if index == 0 { path.move(to: point) } else { path.line(to: point) }
            }
            path.close()
            path.lineJoinStyle = .round
            return path
        }
        override func draw(_ dirty: NSRect) {
            if !compact, focus.width > 2, focus.height > 2 {
                let ring = NSBezierPath(roundedRect: focus.insetBy(dx: 2, dy: 2),
                                        xRadius: PointerMetrics.badgeRadius, yRadius: PointerMetrics.badgeRadius)
                PointerMetrics.outline.setStroke()
                ring.lineWidth = PointerMetrics.focusStroke + PointerMetrics.innerStroke
                ring.stroke()
                Marker.accent.setStroke()
                ring.lineWidth = PointerMetrics.focusStroke
                ring.stroke()
                Marker.accent.withAlphaComponent(PointerMetrics.focusFillAlpha).setFill()
                ring.fill()
            }
            // Transparent at its measured boundary, so the halo is never clipped by
            // the panel and can be removed atomically with the same passive view.
            let glow = Ring.glowBox(tip, directionX: directionX, directionY: directionY)
            let colors = [1.0, 0.56, 0.13, 0.0].map {
                Marker.accent.withAlphaComponent(PointerMetrics.glowAlpha * $0).cgColor
            } as CFArray
            if let context = NSGraphicsContext.current?.cgContext,
               let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors,
                                         locations: [0, 0.35, 0.70, 1]) {
                let center = CGPoint(x: glow.midX, y: glow.midY)
                context.drawRadialGradient(gradient, startCenter: center, startRadius: 0,
                                           endCenter: center, endRadius: PointerMetrics.glowRadius, options: [])
            }
            let arrow = pointerPath()
            PointerMetrics.darkOutline.setStroke()
            arrow.lineWidth = PointerMetrics.outerStroke
            arrow.stroke()
            PointerMetrics.outline.setStroke()
            arrow.lineWidth = PointerMetrics.innerStroke
            arrow.stroke()
            Marker.accent.setFill()
            arrow.fill()
            drawBadge()
        }
        private func drawBadge() {
            guard badge.width > 1, badge.height > 1 else { return }
            let plate = NSBezierPath(roundedRect: badge.insetBy(dx: 1, dy: 1),
                                     xRadius: PointerMetrics.badgeRadius, yRadius: PointerMetrics.badgeRadius)
            PointerMetrics.outline.setStroke()
            plate.lineWidth = 2
            plate.stroke()
            PointerMetrics.surface.setFill()
            plate.fill()
            let left = badge.minX + PointerMetrics.badgePaddingH
            let bottom = badge.minY + PointerMetrics.badgePaddingV
            let width = badge.width - 2 * PointerMetrics.badgePaddingH
            let statusHeight = ceil((status as NSString).size(withAttributes: Ring.statusAttributes).height)
            (status as NSString).draw(in: NSRect(x: left, y: bottom, width: width, height: statusHeight),
                                      withAttributes: Ring.statusAttributes)
            (label as NSString).draw(in: NSRect(x: left, y: bottom + statusHeight, width: width,
                                               height: badge.height - 2 * PointerMetrics.badgePaddingV - statusHeight),
                                     withAttributes: Ring.badgeAttributes)
        }
    }

    static func hide() {
        movement?.invalidate()
        movement = nil
        current?.orderOut(nil)
        destination = nil
        destinationTip = nil
        signature = nil
    }

    /// Reuses one passive panel. Motion never pumps a nested run loop, sleeps or moves the person's pointer.
    static func show(around rect: CGRect, window: UInt32, from: CGPoint? = nil,
                     target: String? = nil, status: String = "操作中", animate: Bool = true) -> Panel? {
        guard let primary = NSScreen.screens.first else { hide(); return nil }
        let covered = !Helper.topmost(at: CGPoint(x: rect.midX, y: rect.midY), is: window)
        let label = target?.isEmpty == false ? "Genie · \(target!)" : "Genie"
        let state = covered && !status.contains("背面") ? "背面 · \(status)" : status
        guard let plan = layout(rect: rect, primaryMaxY: primary.frame.maxY,
                                screens: NSScreen.screens.map(\.frame),
                                badgeSize: Ring.badgeSize(label, status: state), compact: covered) else { hide(); return nil }
        let nextSignature = "\(label)|\(state)|\(covered)|\(plan.tip)|\(plan.focus)|\(plan.badge)"
        let panel: Panel
        if let existing = current { panel = existing }
        else {
            panel = Panel(contentRect: plan.frame, styleMask: [.borderless, .nonactivatingPanel],
                          backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.ignoresMouseEvents = true
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.hasShadow = false
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            panel.animationBehavior = .none
            current = panel
        }
        if destination == plan.frame, signature == nextSignature, panel.isVisible { return panel }
        let previousTip: NSPoint?
        if panel.isVisible, let previousRing = panel.contentView as? Ring {
            previousTip = NSPoint(x: panel.frame.minX + previousRing.tip.x, y: panel.frame.minY + previousRing.tip.y)
        } else { previousTip = nil }
        movement?.invalidate()
        movement = nil
        let ring = (panel.contentView as? Ring) ?? Ring(frame: NSRect(origin: .zero, size: plan.frame.size))
        ring.setFrameSize(plan.frame.size)
        ring.compact = covered
        ring.label = label
        ring.status = state
        ring.focus = plan.focus
        ring.badge = plan.badge
        ring.tip = plan.tip
        ring.directionX = plan.directionX
        ring.directionY = plan.directionY
        ring.setAccessibilityLabel("\(label)、\(state)")
        panel.contentView = ring
        let absoluteTip = NSPoint(x: plan.frame.minX + plan.tip.x, y: plan.frame.minY + plan.tip.y)
        let moved = destinationTip != absoluteTip
        destination = plan.frame
        destinationTip = absoluteTip
        signature = nextSignature
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let start: NSRect?
        if animate, !reduceMotion, moved {
            if let from {
                start = NSRect(x: from.x - plan.tip.x, y: primary.frame.maxY - from.y - plan.tip.y,
                               width: plan.frame.width, height: plan.frame.height)
            } else if let previousTip {
                start = NSRect(x: previousTip.x - plan.tip.x, y: previousTip.y - plan.tip.y,
                               width: plan.frame.width, height: plan.frame.height)
            }
            else { start = nil }
        } else { start = nil }
        panel.setFrame(start ?? plan.frame, display: true)
        panel.orderFrontRegardless()
        ring.needsDisplay = true
        if let start, start.origin != plan.frame.origin {
            let began = ProcessInfo.processInfo.systemUptime
            let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { timer in
                MainActor.assumeIsolated {
                    let t = min(1, (ProcessInfo.processInfo.systemUptime - began) / PointerMetrics.moveSeconds)
                    let eased = t * t * (3 - 2 * t)
                    panel.setFrame(NSRect(x: start.minX + (plan.frame.minX - start.minX) * eased,
                                          y: start.minY + (plan.frame.minY - start.minY) * eased,
                                          width: plan.frame.width, height: plan.frame.height), display: true)
                    if t >= 1 { timer.invalidate(); movement = nil }
                }
            }
            movement = timer
            RunLoop.main.add(timer, forMode: .common)
        }
        return panel
    }
}

/*
 * 画像の送信先を、人に見せる名前にする。前面の選択ダイアログと背景の同意ダイアログ
 * （BackgroundAX）が**同じ対応表**を使う。内部の種別名（`openai_api` など）は見せず、
 * 画像が届く提供元の名前にする。
 */
func imageDestinationLabel(_ recipient: String?) -> String {
    let providers = ["openai_api": "OpenAI", "codex": "OpenAI（Codex）", "anthropic_api": "Anthropic", "gemini_api": "Google（Gemini）"]
    guard let recipient, !recipient.isEmpty else { return "不明" }
    return recipient == "local" ? "このMacのモデル" : "外部のモデル（\(providers[recipient] ?? recipient)）"
}

@available(macOS 14.4, *)
@MainActor
struct Helper {
    static func selectTarget(goal: String, recipient: String, dir: URL) async throws -> Target {
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && $0.processIdentifier != getpid() &&
            $0.localizedName != "Genie" && $0.bundleIdentifier != nil
        }.sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
        guard !apps.isEmpty else { throw Failure("no_target_window") }
        let choice = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 30))
        for app in apps { choice.addItem(withTitle: "\(app.localizedName ?? "App") (\(app.bundleIdentifier ?? ""))") }
        if let front = NSWorkspace.shared.frontmostApplication,
           let index = apps.firstIndex(where: { $0.processIdentifier == front.processIdentifier }) { choice.selectItem(at: index) }
        /*
         * 送信先は、ここに来て初めて決まっている（host が実行の直前に選ぶ）。
         * サーバの承認カードは「端末で設定したモデル」としか言えないので、**ここで名指しする。**
         * 内部の種別名（`openai_api` など）は見せず、画像が届く提供元の名前にする。
         */
        let destination = imageDestinationLabel(recipient)
        let alert = NSAlert()
        alert.messageText = "操作するアプリを選んでください"
        /*
         * **人の関門はここではない。**この走行を許すかどうかは、ここへ来る前に
         * Genie の確認カード（サーバの承認）で本人が決めている。このダイアログは
         * 対象のアプリを選ぶ画面で、ここで初めて分かる画像の送信先を見せる。
         * 以前は 1 操作ごとに確認を出していたが、実用にならないという持ち主の判断で
         * 選択のこの 1 回にまとめた（実行中の許可 `grantRunConsent`）。
         * 代わりに効かせ続けるもの: 対象は選んだ 1 枚の窓に固定、操作点に
         * その窓が見えていること、対象要素の同一性、12 操作・5 分の上限、
         * タスク承認の有効期限、Enter・Space・修飾キー・shell を持たないこと。
         * NSAlert は Markdown を解さない。強調の記号を文面に入れない（そのまま出る）。
         */
        alert.informativeText = "目的: \(goal)\n画像の送信先: \(destination)\n選んだアプリの前面ウィンドウだけを、最大12操作・5分まで操作します。1操作ごとの確認はありません。画像は実行終了時に削除します。"
        alert.accessoryView = choice
        alert.addButton(withTitle: "このアプリで始める"); alert.addButton(withTitle: "中止")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn, apps.indices.contains(choice.indexOfSelectedItem)
        else { throw Failure("user_cancelled") }
        let selected = apps[choice.indexOfSelectedItem]
        selected.activate(options: [.activateIgnoringOtherApps])
        for _ in 0..<20 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == selected.processIdentifier { break }
        }
        let target = try currentTarget()
        guard target.pid == selected.processIdentifier else { throw Failure("target_changed") }
        grantRunConsent(dir, target)
        return target
    }
    /*
     * 一度だけの許可。**helper は 1 操作ごとに起動し直される**ので、状態はプロセスに残せない。
     * 選んだ窓に紐づけて、所有者だけが読める 0600 のファイルに 5 分の期限付きで置く。
     * 期限・窓の同一性・承認の有効期限は、これがあっても素通りしない。
     */
    static func consentPath(_ dir: URL, _ t: Target) -> String {
        dir.appendingPathComponent("consent-\(t.pid)-\(t.windowId).json").path
    }
    static func grantRunConsent(_ dir: URL, _ t: Target) {
        let until = Date().timeIntervalSince1970 * 1000 + 5 * 60 * 1000
        let path = consentPath(dir, t)
        unlink(path)
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { return }
        defer { close(fd) }
        let body = "{\"expiresAt\":\(until)}"
        _ = body.withCString { write(fd, $0, strlen($0)) }
    }
    static func runConsented(_ dir: URL, _ t: Target) -> Bool {
        let path = consentPath(dir, t)
        var info = stat()
        guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), (info.st_mode & 0o077) == 0,
              let data = FileManager.default.contents(atPath: path),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let until = parsed["expiresAt"] as? Double, until.isFinite else { return false }
        guard until > Date().timeIntervalSince1970 * 1000 else { unlink(path); return false }
        return true
    }
    /*
     * 前面アプリの「主ウィンドウ」。以前は layer 0 の**最初の1件**を取っていたため、
     * Safari の高さ 90pt のツールバー窓や Chrome のリンク表示窓を掴むことがあった。
     * AX の main/focused window の矩形を CG の一覧と突き合わせて選ぶ。
     * 大きさの閾値では選ばない（正当な小さいダイアログを落とすため）。
     */
    static func currentTarget() throws -> Target {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid(),
              let bundle = app.bundleIdentifier else { throw Failure("no_target_window") }
        let denied = ["com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.keychainaccess"]
        guard !denied.contains(bundle), !bundle.hasPrefix("com.1password"),
              !bundle.hasPrefix("com.agilebits.onepassword") else { throw Failure("protected_application") }
        let windows = onScreenWindows(pid: app.processIdentifier)
        guard !windows.isEmpty else { throw Failure("no_target_window") }
        let preferred = axWindowRect(pid: app.processIdentifier).flatMap { rect in
            windows.first { $0.1.rect.equalTo(rect) }
        }
        let chosen = preferred ?? windows[0]
        return Target(bundleId: bundle, windowId: chosen.0, pid: app.processIdentifier, bounds: chosen.1)
    }
    /** layer 0 の可視ウィンドウを手前から。位置・大きさはここで取り直す。 */
    static func onScreenWindows(pid: Int32) -> [(UInt32, Bounds)] {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return [] }
        return windows.compactMap { w in
            guard (w[kCGWindowOwnerPID as String] as? Int32) == pid,
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let id = w[kCGWindowNumber as String] as? UInt32,
                  let b = w[kCGWindowBounds as String] as? [String: Double],
                  let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"],
                  x.isFinite, y.isFinite, width.isFinite, height.isFinite, width > 0, height > 0
            else { return nil }
            return (id, Bounds(x: x, y: y, width: width, height: height))
        }
    }
    /** AX が言う main window（無ければ focused window）の矩形。公開 API だけで照合する。 */
    static func axWindowRect(pid: Int32) -> CGRect? {
        let app = AXUIElementCreateApplication(pid)
        for attribute in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(app, attribute as CFString, &value) == .success,
                  let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { continue }
            if let rect = elementRect(value as! AXUIElement) { return rect }
        }
        return nil
    }
    /** AX 要素の画面上の矩形。Quartz 座標（左上原点）。 */
    static func elementRect(_ element: AXUIElement) -> CGRect? {
        var pos: CFTypeRef?; var size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &pos) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
              let pos, let size, CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
        else { return nil }
        var origin = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetValue(pos as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions)
        else { return nil }
        return CGRect(origin: origin, size: dimensions)
    }
    /** 固定した 1 枚のウィンドウを id で引き直す。前面かどうかはここでは問わない。 */
    static func windowBounds(pid: Int32, windowId: UInt32) throws -> Bounds {
        guard let found = onScreenWindows(pid: pid).first(where: { $0.0 == windowId })?.1 else {
            stage("window-missing want=\(windowId) have=\(onScreenWindows(pid: pid).map { String($0.0) }.joined(separator: ","))")
            throw Failure("target_changed")
        }
        return found
    }
    /*
     * 操作点に実際に見えているのが、固定したウィンドウであること。覆われていたら断る。
     * 見るのは通常ウィンドウ（layer 0）だけ。Dock やメニューバーは中身が透けている
     * 画面全体の窓を持っていて、点を含むかで数えるとどの点でも「覆われている」になる。
     */
    static func topmost(at p: CGPoint, is windowId: UInt32) -> Bool {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return false }
        for w in windows {
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  (w[kCGWindowOwnerPID as String] as? Int32) != getpid(),
                  let b = w[kCGWindowBounds as String] as? [String: Double],
                  let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"],
                  CGRect(x: x, y: y, width: width, height: height).contains(p)
            else { continue }
            return (w[kCGWindowNumber as String] as? UInt32) == windowId
        }
        return false
    }
    static func checkPermissions() throws {
        guard AXIsProcessTrusted() else { throw Failure("accessibility_required") }
        guard CGPreflightScreenCaptureAccess() else { throw Failure("screen_capture_required") }
    }
    /*
     * 固定するのは app / PID / windowID。**位置は動いてよい**——窓を動かしただけで
     * 中身は同じだから、座標を作り直して続ける。大きさが変われば中身も変わるので作り直す。
     * 前面かどうかはここでは見ない。入力の直前に `topmost(at:is:)` で見る。
     */
    static func rescope(_ f: Frame) throws -> Target {
        try checkPermissions()
        let bounds = try windowBounds(pid: f.pid, windowId: f.windowId)
        guard bounds.width == f.bounds.width, bounds.height == f.bounds.height else { throw Failure("stale_frame") }
        return Target(bundleId: f.bundleId, windowId: f.windowId, pid: f.pid, bounds: bounds)
    }
    /*
     * 対象の窓が画面に無いときだけ、いちど前に出してから引き直す。
     * 許可を実行単位の 1 回にまとめた以上、人は自分の作業へ戻る——別の Space に移る、
     * ⌘H で隠す、最小化する。そのたびに黙って止まるのでは、任せられない。
     * 戻すのは**選んだ 1 つのアプリ**だけで、対象が変わるわけではない。
     */
    static func rescopeActivating(_ f: Frame) async throws -> Target {
        if let found = try? rescope(f) { return found }
        guard let app = NSRunningApplication(processIdentifier: f.pid), !app.isTerminated
        else { throw Failure("target_changed") }
        stage("reveal")
        if app.isHidden { app.unhide() }
        app.activate(options: [.activateIgnoringOtherApps])
        for _ in 0..<20 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if let found = try? rescope(f) { return found }
        }
        return try rescope(f)
    }
    /*
     * 操作対象そのものの同一性。**画面全体の画素一致の代わりに使う。**
     * 全体一致は、テキスト欄のカーソルが点滅するだけで成立しない——
     * つまり一番やりたい「入力」で必ず落ちる。ここでは対象を絞って見る。
     * 位置はウィンドウ原点からの相対で持つ（窓が動いても同じ対象と分かるように）。
     */
    struct ElementIdentity {
        let role: String; let subrole: String; let identifier: String; let title: String
        let offsetX: Double; let offsetY: Double; let width: Double; let height: Double
        /*
         * 役割と、窓の中での位置・大きさは厳密に見る。ここが違えば別の対象。
         * subrole / identifier / title は**片方が空なら判断材料にしない**——
         * AX ツリーの作り直しで一時的に落ちることがあり（実測: AXEmptyGroup → 空）、
         * 「属性が無い」は「別物である」証拠にならない。埋まっている同士が食い違えば断る。
         */
        func matches(_ other: ElementIdentity) -> Bool {
            func agrees(_ a: String, _ b: String) -> Bool { a.isEmpty || b.isEmpty || a == b }
            func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1 }
            return role == other.role && agrees(subrole, other.subrole)
                && agrees(identifier, other.identifier) && agrees(title, other.title)
                && close(offsetX, other.offsetX) && close(offsetY, other.offsetY)
                && close(width, other.width) && close(height, other.height)
        }
    }
    /*
     * AX ツリーを遅れて作り込むアプリでは、同じ点でも 1 回目は粗い入れ物
     * （実測: AXGroup/AXLandmarkSearch）、少し後に本来の要素（AXTextArea）が返る。
     * **比べる前に、両側とも落ち着かせる。**片側だけ再試行しても噛み合わない。
     * 2 回続けて同じものが返ったらそれを採る。落ち着かなければ nil を返し、
     * 画素の完全一致に任せる（緩めるのではなく、判断材料を変えない）。
     */
    static func settledIdentity(at p: CGPoint, origin: Bounds) async -> ElementIdentity? {
        var previous = identity(at: p, origin: origin)
        for _ in 0..<5 {
            try? await Task.sleep(nanoseconds: 150_000_000)
            let now = identity(at: p, origin: origin)
            if let now, let previous, now.matches(previous) { return now }
            previous = now
        }
        return nil
    }
    static func identity(at p: CGPoint, origin: Bounds) -> ElementIdentity? {
        var raw: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &raw) == .success,
              let element = raw, let rect = elementRect(element) else { return nil }
        func text(_ attribute: String) -> String {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return "" }
            return (value as? String) ?? ""
        }
        let role = text(kAXRoleAttribute as String)
        guard !role.isEmpty else { return nil }
        return ElementIdentity(role: role, subrole: text(kAXSubroleAttribute as String),
                               identifier: text(kAXIdentifierAttribute as String), title: text(kAXTitleAttribute as String),
                               offsetX: rect.origin.x - origin.x, offsetY: rect.origin.y - origin.y,
                               width: rect.width, height: rect.height)
    }
    /*
     * 秘匿欄（パスワード等）に触れないための判定。
     * **「焦点が無い」と「判定できない」を分ける。**以前はどちらも「秘匿欄」として
     * 止めていたので、ページを開いた直後やアプリを前に出した直後——まだどこにも
     * 焦点が無いだけの状態——で正当な操作が止まっていた。
     * 焦点が無いのは既知の状態であって、秘匿欄がある証拠ではない。
     * 問い合わせ自体が失敗したときは、これまでどおり断る。
     */
    static func secureFocus() -> Bool {
        let system = AXUIElementCreateSystemWide()
        var focus: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focus)
        if status == .noValue || status == .attributeUnsupported { return false }
        guard status == .success, let focus else { return true }
        var subrole: CFTypeRef?
        guard AXUIElementCopyAttributeValue(focus as! AXUIElement, kAXSubroleAttribute as CFString, &subrole) == .success
        else { return false }
        return (subrole as? String) == (kAXSecureTextFieldSubrole as String)
    }
    static func canType(at p: CGPoint) -> Bool {
        guard !secureFocus() else { return false }
        let system = AXUIElementCreateSystemWide()
        var focus: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focus) == .success,
              let focus else { return false }
        let element = focus as! AXUIElement
        var role: CFTypeRef?, pos: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
              [kAXTextFieldRole as String, kAXTextAreaRole as String, kAXComboBoxRole as String].contains(role as? String ?? ""),
              AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &pos) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
              let pos, let size, CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
        else { return false }
        var origin = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetValue(pos as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions)
        else { return false }
        return CGRect(origin: origin, size: dimensions).contains(p)
    }
    static func consent(_ title: String, _ detail: String, image: NSImage? = nil) throws {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "続ける")
        alert.addButton(withTitle: "中止")
        alert.alertStyle = .warning
        if let image {
            let view = NSImageView(frame: NSRect(x: 0, y: 0, width: 360, height: 220))
            view.image = image; view.imageScaling = .scaleProportionallyUpOrDown
            alert.accessoryView = view
        }
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { throw Failure("user_cancelled") }
    }
    /*
     * 承認画面から対象アプリへ戻す。300ms 固定では activation が間に合わず、
     * 利用者が何もしていないのに `target_changed` になっていた。実際に前面になるまで待つ。
     */
    static func restore(_ t: Target) async throws {
        guard let app = NSRunningApplication(processIdentifier: t.pid), !app.isTerminated else { throw Failure("target_changed") }
        app.activate(options: [.activateIgnoringOtherApps])
        for _ in 0..<20 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == t.pid { return }
        }
        throw Failure("target_changed")
    }
    /*
     * ScreenCaptureKit は一時的に落ちることがある。以前はその例外が `Failure` でないため
     * すべて `helper_failed` に潰れ、何が起きたか分からないまま実行が終わっていた。
     * こちらの判断（`Failure`）はそのまま通し、それ以外は少し待って撮り直す。
     */
    static func capture(_ t: Target) async throws -> (CGImage, Data) {
        var last: Error?
        for attempt in 0..<3 {
            if attempt > 0 { try await Task.sleep(nanoseconds: 300_000_000) }
            do { return try await captureOnce(t) }
            catch let error as Failure { throw error }
            catch {
                last = error
                stage("capture-retry \(String(describing: type(of: error)))")
            }
        }
        stage("capture-failed \(last.map { String(describing: type(of: $0)) } ?? "unknown")")
        throw Failure("capture_failed")
    }
    static func captureOnce(_ t: Target) async throws -> (CGImage, Data) {
        try checkPermissions()
        guard !secureFocus() else { throw Failure("protected_field") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let w = content.windows.first(where: { $0.windowID == t.windowId && $0.owningApplication?.processID == t.pid })
        else { throw Failure("target_changed") }
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let config = SCStreamConfiguration()
        let scale = min(1.0, 1440.0 / max(t.bounds.width, t.bounds.height))
        config.width = max(1, Int((t.bounds.width * scale).rounded()))
        config.height = max(1, Int((t.bounds.height * scale).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        // 撮っている間に窓が動いていないこと。前面かどうかはここでは問わない。
        guard try windowBounds(pid: t.pid, windowId: t.windowId) == t.bounds else { throw Failure("stale_frame") }
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), data.count <= 10 * 1024 * 1024
        else { throw Failure("capture_failed") }
        return (image, data)
    }
    /*
     * 書き出し先が**symlink 越しでない**ことを確かめる。狙いは、渡された道の途中を
     * すり替えて別の場所へ書かせないこと。
     *
     * 判定に `resolvingSymlinksInPath()` を使ってはいけない。**あれは symlink を
     * 解くだけでなく、documented な仕様として `/private` 接頭辞も取り除く。**
     * そのため `/private/tmp/...` を渡すと `/tmp/...` が返り、symlink が 1 つも
     * 無いのに不一致になる（実測 2026-09-22: 状態ディレクトリを /tmp 以下に置いた
     * プレビューが、写真を 1 枚も書けずに `invalid_cache` で止まった）。
     * POSIX の `realpath(3)` は `/private/tmp` をそのまま返し、`/tmp` を渡されたときは
     * `/private/tmp` に直す——こちらが欲しいのはその挙動で、host 側の `realpath` と同じ。
     */
    static func canonicalDirectory(_ path: String) -> Bool {
        let dir = URL(fileURLWithPath: path).deletingLastPathComponent().path
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(dir, &buffer) != nil else { return false }
        return String(cString: buffer) == dir
    }
    static func privateWrite(_ data: Data, id: String, path: String) throws {
        guard id.hasPrefix("cv-"), UUID(uuidString: String(id.dropFirst(3))) != nil,
              URL(fileURLWithPath: path).lastPathComponent == "\(id).png",
              canonicalDirectory(path)
        else { throw Failure("invalid_cache") }
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Failure("cache_write_failed") }
        defer { close(fd) }
        try data.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { throw Failure("cache_write_failed") }
            var offset = 0
            while offset < buffer.count {
                let count = write(fd, base.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw Failure("cache_write_failed") }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw Failure("cache_write_failed") }
    }
    static func respond(_ request: Request) async throws -> Data {
        // The legacy foreground helper does not implement constrained consent.
        // Never silently ignore a caller's narrower target boundary.
        guard request.expectedTarget == nil else { throw Failure("target_constraint_unsupported") }
        try checkPermissions()
        stage("op-\(request.op)")
        if request.op == "begin" || request.op == "capture" {
            let t: Target
            if request.op == "begin" {
                guard let out = request.outputPath else { throw Failure("invalid_request") }
                t = try await selectTarget(goal: request.goal ?? "", recipient: request.recipient ?? "unknown",
                                           dir: URL(fileURLWithPath: out).deletingLastPathComponent())
            } else {
                guard let scope = request.scope else { throw Failure("invalid_scope") }
                t = try await rescopeActivating(scope)
            }
            let (image, png) = try await capture(t)
            guard let id = request.id, let path = request.outputPath else { throw Failure("invalid_request") }
            try privateWrite(png, id: id, path: path)
            return try JSONEncoder().encode(Frame(id: id, bundleId: t.bundleId, windowId: t.windowId, pid: t.pid,
                capturedAt: Date().timeIntervalSince1970 * 1000, width: image.width, height: image.height,
                bounds: t.bounds, sha256: digest(png)))
        }
        guard request.op == "apply", let f = request.scope, let a = request.action,
              let reference = request.referencePath, URL(fileURLWithPath: reference).lastPathComponent == "\(f.id).png"
        else { throw Failure("invalid_request") }
        guard let expires = request.authorizationExpiresAt, expires.isFinite,
              expires > Date().timeIntervalSince1970 * 1000 else { throw Failure("approval_expired") }
        guard a.textMode == nil, a.direction == nil, a.action != "scroll" else { throw Failure("policy_action_not_allowed") }
        stage("rescope")
        var t = try await rescopeActivating(f)
        /*
         * **決める前に前へ出す。**対象が背面にある間、アプリは中身を変える——
         * 実測では、Chrome が前面でない Google の検索欄が、同じ座標で
         * プレースホルダの静的テキストに見え、前面に戻すと入力欄に戻った。
         * 背面の姿で決めて前面で実行すれば、判断と実行がずれる。順序で直す。
         */
        stage("restore-first")
        try await restore(t)
        t = try rescope(f)
        guard Date().timeIntervalSince1970 * 1000 - f.capturedAt <= 60_000 else { throw Failure("stale_frame") }
        var p = try point(a, f, t.bounds)
        guard ["click", "type", "key"].contains(a.action), !secureFocus() else { throw Failure("protected_field") }
        if a.action == "type" {
            guard let text = a.text, !text.isEmpty, text.utf16.count <= 2000,
                  !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }), canType(at: p)
            else { throw Failure("invalid_text_target") }
        }
        if a.action == "key", navigationKeys[a.key ?? ""] == nil { throw Failure("invalid_key") }
        /*
         * 画像ハッシュは「どの画像で判断したか」の記録。**操作の可否はそれでは決めない。**
         * 画面全体の画素一致は、テキスト欄のカーソルが点滅するだけで成立せず、
         * 一番やりたい入力が必ず落ちる。AX で対象を特定できたときはその同一性で判断し、
         * できなかったときだけ従来どおり画素の完全一致に戻す。
         */
        stage("capture-before")
        let (_, before) = try await capture(t)
        let known = await settledIdentity(at: p, origin: t.bounds)
        stage(known == nil ? "identity-none" : "identity-known")
        if known == nil { guard digest(before) == f.sha256 else { throw Failure("stale_frame") } }
        let detail = a.action == "type" ? "入力内容: \(a.text ?? "")" : "操作: \(a.action) \(a.key ?? "")\n位置: \(Int(p.x)), \(Int(p.y))"
        let preview = NSImage(data: before)
        let dir = URL(fileURLWithPath: reference).deletingLastPathComponent()
        if runConsented(dir, t) { stage("consent-once") }
        else { try consent("この1操作を実行しますか？", "対象: \(t.bundleId)\n\(detail)\n期待する結果: \(a.expectation)", image: preview) }
        stage("restore")
        try await restore(t)
        stage("rescope-back")
        let back = try await rescopeActivating(f)
        p = try point(a, f, back.bounds)
        // 承認画面が前面だった遷移と、利用者が別へ移った遷移を分ける。見えているのが対象の窓か。
        stage("topmost")
        guard topmost(at: p, is: f.windowId) else { throw Failure("target_changed") }
        if let known {
            stage("identity-recheck")
            /*
             * Chrome など AX ツリーを遅延構築するアプリでは、最初の問い合わせが
             * 入れ物（WebArea/Group）を返し、少し後に本来の要素が返ることがある。
             * 窓と点は既に固定されているので、落ち着くまで数回だけ見直す。
             * それでも別物なら断る——「同じ対象か」を緩めはしない。
             */
            let settled = await settledIdentity(at: p, origin: back.bounds)
            guard settled?.matches(known) == true else {
                stage("identity-diff want=\(known.role)/\(known.subrole) have=\(settled?.role ?? "none")/\(settled?.subrole ?? "none")")
                throw Failure("target_changed")
            }
        } else {
            let (_, fresh) = try await capture(back)
            guard digest(fresh) == f.sha256 else { throw Failure("stale_frame") }
        }
        guard expires > Date().timeIntervalSince1970 * 1000 else { throw Failure("approval_expired") }
        stage("cantype")
        if a.action == "type", !canType(at: p) { throw Failure("invalid_text_target") }
        stage("post")
        /*
         * この経路は**人のカーソルを奪って**動かす。奪う側こそ、どこで何をしたかを
         * その場に残す必要がある。印は入力を横取りしない（当たり判定を持たない）。
         */
        let marker = Marker.show(around: screenRect(a, f, back.bounds), window: f.windowId)
        defer { marker?.orderOut(nil) }
        guard let source = CGEventSource(stateID: .hidSystemState) else { throw Failure("input_failed") }
        if a.action == "click" {
            guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)
            else { throw Failure("input_failed") }
            down.setIntegerValueField(.mouseEventClickState, value: 1)
            up.setIntegerValueField(.mouseEventClickState, value: 1)
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        } else if a.action == "key" {
            guard let code = navigationKeys[a.key ?? ""],
                  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
            else { throw Failure("input_failed") }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        } else {
            // UTF-16 chunks never split a surrogate pair. Japanese and non-BMP emoji are preserved.
            var units = Array((a.text ?? "").utf16)
            while !units.isEmpty {
                var count = min(20, units.count)
                if count < units.count && (0xD800...0xDBFF).contains(units[count - 1]) { count -= 1 }
                let chunk = Array(units.prefix(count)); units.removeFirst(count)
                for pressed in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: pressed) else { throw Failure("input_failed") }
                    chunk.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                    event.post(tap: .cghidEventTap)
                }
            }
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        // 操作が済んだあとも印を残す。100ms では目で追えない。
        if marker != nil { try await Task.sleep(nanoseconds: Marker.hold) }
        return Data("{\"status\":\"applied\"}".utf8)
    }
}

#if !GENIE_BACKGROUND && !GENIE_BACKGROUND_TEST
@main struct Main {
    /*
     * `async main` にしない。AppKit を使う以上、main actor の継続を回すのは
     * `NSApplication.run()` であって Swift の async main ではない。
     * async main のままだと、同意ダイアログのモーダルが閉じた直後の
     * 最初の suspension（`Task.sleep`）でプロセスが exit 0・無出力のまま畳まれ、
     * 画面を撮って返す前に死ぬ。ホスト側はそれを `helper_unavailable` として受け取る。
     * 自己テストは AppKit を起こさない（window server の無い CI で走らせるため）。
     */
    static func main() {
        if CommandLine.arguments.contains("--self-test") { selfTest(); return }
        // Read-only setup probe: never capture a screen or request TCC authorization.
        if CommandLine.arguments.contains("--status") {
            let supported: Bool
            if #available(macOS 14.4, *) { supported = true } else { supported = false }
            let ax = AXIsProcessTrusted()
            let screen = CGPreflightScreenCaptureAccess()
            let data = try! JSONSerialization.data(withJSONObject: [
                "supported": supported, "accessibility": ax, "screenRecording": screen,
                "ready": supported && ax && screen
            ], options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            print("")
            return
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in await respond() }
        app.run()
    }
    static func selfTest() {
        do {
            let f = Frame(id: "test", bundleId: "test", windowId: 1, pid: 1, capturedAt: 0, width: 1000, height: 500,
                bounds: Bounds(x: -1920, y: 200, width: 2000, height: 1000), sha256: "")
            let a = Action(action: "click", frameId: "test", expectation: "open",
                confidence: 0.95, risk: "navigation", text: nil, key: nil, elementId: nil,
                target: [100, 50, 200, 100])
            let p = try point(a, f)
            guard p.x == -1620, p.y == 350 else { throw Failure("coordinate_test_failed") }
            let bad = Action(action: "click", frameId: "other", expectation: "open",
                confidence: 1, risk: "navigation", text: nil, key: nil, elementId: nil,
                target: [-1, 0, 20, 20])
            do { _ = try point(bad, f); throw Failure("rejection_test_failed") }
            catch let error as Failure where error.code == "invalid_target" { }
            print("GENIE_COMPUTER_SELF_TEST_OK")
        } catch {
            fail(error)
        }
    }
    /** 応答を書いたら必ず終える。run loop は自分では止まらない。 */
    @MainActor static func respond() async {
        do {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            guard input.count <= 128 * 1024 else { throw Failure("invalid_request") }
            let request = try JSONDecoder().decode(Request.self, from: input)
            if #available(macOS 14.4, *) {
                let data = try await Helper.respond(request)
                FileHandle.standardOutput.write(data)
                exit(0)
            } else { throw Failure("macos_14_4_required") }
        } catch {
            fail(error)
        }
    }
    static func fail(_ error: Error) -> Never {
        let code = (error as? Failure)?.code ?? "helper_failed"
        let data = (try? JSONSerialization.data(withJSONObject: ["error": code])) ?? Data()
        FileHandle.standardOutput.write(data)
        exit(1)
    }
}
#endif
