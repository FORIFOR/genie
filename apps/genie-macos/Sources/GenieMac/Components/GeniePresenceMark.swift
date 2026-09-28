import AppKit
import SwiftUI

/// 1b「形と動き」: Genie の存在を、球（GenieOrb）ではなくブランドの印そのもので示す。
///
/// 規則（Genie App UI 改修案 1b）
/// - 動くのは印だけ。文字・停止・確認の操作は動かさない。
/// - listening: 輪郭が入力音量に合わせて伸縮する。working: 印の内側を青（presence）がゆっくり流れる。
/// - still / idle: 動かさない（確認・失敗・準備中・完了後）。
/// - 呼び出しの瞬間だけ横に伸びる（stretchOnAppear）。受付と完了のときだけ一度膨らむ（ackOnAppear）。
/// - Reduce Motion では静止。`--selftest` では時間を止め、golden を再現可能に保つ。
enum GeniePresenceMode {
    case idle, still, listening, working
    var moving: Bool { self == .listening || self == .working }
}

struct GeniePresenceMark: View {
    var mode: GeniePresenceMode = .idle
    var level: Float = 0
    var height: CGFloat = 18
    var stretchOnAppear = false
    var ackOnAppear = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var stretch = false
    @State private var ack = false

    private static let frozen = CommandLine.arguments.contains("--selftest")
    private var animates: Bool { mode.moving && !reduceMotion && !Self.frozen }

    var body: some View {
        let m = GenieBrandMark.mark(forHeight: height)
        let w = (height * m.aspect).rounded()
        ZStack {
            if mode == .listening {
                Capsule()
                    .stroke(Palette.presence(true).opacity(0.7), lineWidth: 1)
                    .frame(width: w + 10, height: height + 10)
                    .scaleEffect(1 + CGFloat(LiquidOrbMotion.clampedLevel(level)) * 0.22)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: level)
            }
            shape(m).foregroundStyle(Palette.text(true))
            if animates {
                TimelineView(.animation) { ctx in
                    let period: Double = mode == .listening ? 1.6 : 2.6
                    let phase = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
                    LinearGradient(stops: [
                        .init(color: .clear, location: 0),
                        .init(color: Palette.presence(true), location: 0.5),
                        .init(color: .clear, location: 1),
                    ], startPoint: .leading, endPoint: .trailing)
                        .frame(width: w * 0.9, height: height)
                        .offset(x: CGFloat(phase * 2 - 1) * w)
                        .frame(width: w, height: height)
                        .mask(shape(m))
                }
            }
        }
        .frame(width: w, height: height)
        .scaleEffect(x: stretch ? 1.22 : (ack ? 1.14 : 1), y: stretch ? 0.86 : (ack ? 1.14 : 1))
        .onAppear(perform: react)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func shape(_ m: (image: NSImage, aspect: CGFloat)) -> some View {
        Image(nsImage: m.image)
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .aspectRatio(m.aspect, contentMode: .fit)
            .frame(height: height)
    }

    /// 中身は面の変形が終わってから見える（VoiceTaskDockView.contentVisible）。反応もその後に合わせる。
    private func react() {
        guard !reduceMotion, !Self.frozen, stretchOnAppear || ackOnAppear else { return }
        let start = Motion.dockResizeMs + Motion.dockContentDelayMs
        let total = stretchOnAppear ? Motion.markStretchMs : Motion.markAckMs
        DispatchQueue.main.asyncAfter(deadline: .now() + start) {
            withAnimation(.easeOut(duration: total * 0.4)) {
                if stretchOnAppear { stretch = true } else { ack = true }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + total * 0.4) {
                withAnimation(.spring(response: total, dampingFraction: 0.62)) { stretch = false; ack = false }
            }
        }
    }
}

/// 作業中だけ Dock の下辺を進む細い流れ。進捗率は表さない。
struct DockFlowLine: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion || CommandLine.arguments.contains("--selftest") {
            EmptyView()
        } else {
            GeometryReader { geo in
                TimelineView(.animation) { ctx in
                    let phase = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
                    let w = geo.size.width * 0.3
                    LinearGradient(colors: [.clear, Palette.presence(true), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: w, height: 1.5)
                        .offset(x: -w + CGFloat(phase) * (geo.size.width + w))
                }
            }
            .frame(height: 1.5)
            .clipped()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}
