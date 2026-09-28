import AppKit
import SwiftUI

/// 1b「形と動き」: Genie の存在を、球（GenieOrb）ではなくブランドの印そのもので示す。
///
/// 規則（Genie App UI 改修案 1b）
/// - 印は Dock に **1 つだけ**。`VoiceTaskDockView` が中身の外に置き、面が変わっても同じ場所に居続ける。
///   各 Dock は印の場所を `DockMarkSlot` で空けておくだけ。
/// - 動くのは印だけ。文字・停止・確認の操作は動かさない。
/// - listening: 輪郭が入力音量に合わせて伸縮する。working: 印の内側を青（presence）がゆっくり流れる。
/// - still / idle: 動かさない（確認・失敗・準備中・完了後）。
/// - 呼び出しの瞬間だけ横に伸びる（`stretchKey`）。受付と完了のときだけ一度膨らむ（`ackKey`）。
/// - Reduce Motion と `--selftest` では時間を止める。動きの代わりに **静止した形で状態を描き分ける**
///   （listening = 輪郭を出す、working = 内側の青を中央に止める）。golden はこの静止形で撮る。
/// 印の時間を止めるか。`--selftest` では止めて golden を再現できるようにする。
/// 動きそのものを確かめる検査（`--selftest markmotion`）だけは `GENIE_ANIMATE_IN_SELFTEST=1` で動かす。
enum GeniePresenceMotion {
    static let frozen = CommandLine.arguments.contains("--selftest")
        && ProcessInfo.processInfo.environment["GENIE_ANIMATE_IN_SELFTEST"] != "1"
}

enum GeniePresenceMode {
    case idle, still, listening, working
    var moving: Bool { self == .listening || self == .working }
}

/// 印の寸法と、各 Dock で印が収まる行の高さ（pt）。位置の計算は `VoiceTaskDockView.presence`。
enum DockMark {
    static let height: CGFloat = 18
    static let idleHeight: CGFloat = 12
    /// Listening / Thinking の 1 行目（以前は 36pt の orb が決めていた高さ）。
    static let rowHeight: CGFloat = 36
    /// Agent の見出し行（以前は 22pt の orb）。
    static let compactRowHeight: CGFloat = 22
    /// Result の 2 行の見出し。
    static let resultRowHeight: CGFloat = 40

    static func width(height: CGFloat) -> CGFloat {
        (height * GenieBrandMark.mark(forHeight: height).aspect).rounded()
    }
}

/// 印の場所を空けておく。印そのものは上位（`VoiceTaskDockView`）が 1 つだけ描く。
struct DockMarkSlot: View {
    var height: CGFloat = DockMark.height
    var rowHeight: CGFloat = DockMark.rowHeight
    var body: some View {
        Color.clear
            .frame(width: DockMark.width(height: height), height: rowHeight)
            .accessibilityHidden(true)
    }
}

struct GeniePresenceMark: View {
    var mode: GeniePresenceMode = .idle
    var level: Float = 0
    var height: CGFloat = DockMark.height
    /// 値が変わったときに一度だけ横へ伸びる（呼び出し）。
    var stretchKey: Int = 0
    /// 値が変わったときに一度だけ膨らむ（受付・完了）。
    var ackKey: Int = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var stretch = false
    @State private var ack = false

    private static let frozen = GeniePresenceMotion.frozen
    private var still: Bool { reduceMotion || Self.frozen }

    var body: some View {
        let m = GenieBrandMark.mark(forHeight: height)
        let w = DockMark.width(height: height)
        ZStack {
            if mode == .listening {
                Capsule()
                    .stroke(Palette.presence(true).opacity(0.7), lineWidth: 1)
                    .frame(width: w + 10, height: height + 10)
                    .scaleEffect(still ? 1 : 1 + CGFloat(LiquidOrbMotion.clampedLevel(level)) * 0.22)
                    .animation(still ? nil : .easeOut(duration: 0.08), value: level)
            }
            shape(m).foregroundStyle(Palette.text(true))
            if mode.moving {
                if still {
                    band(w: w, phase: 0.5).mask(shape(m))
                } else {
                    TimelineView(.animation) { ctx in
                        let period: Double = mode == .listening ? 1.6 : 2.6
                        let phase = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
                        band(w: w, phase: phase).mask(shape(m))
                    }
                }
            }
        }
        .frame(width: w, height: height)
        .scaleEffect(x: stretch ? 1.22 : (ack ? 1.14 : 1), y: stretch ? 0.86 : (ack ? 1.14 : 1))
        .onChange(of: stretchKey) { _, _ in react(stretching: true) }
        .onChange(of: ackKey) { _, _ in react(stretching: false) }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// 内側を流れる青の帯。phase 0…1 で左から右へ。
    private func band(w: CGFloat, phase: Double) -> some View {
        LinearGradient(stops: [
            .init(color: .clear, location: 0),
            .init(color: Palette.presence(true), location: 0.5),
            .init(color: .clear, location: 1),
        ], startPoint: .leading, endPoint: .trailing)
            .frame(width: w * 0.9, height: height)
            .offset(x: CGFloat(phase * 2 - 1) * w)
            .frame(width: w, height: height)
    }

    private func shape(_ m: (image: NSImage, aspect: CGFloat)) -> some View {
        Image(nsImage: m.image)
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .aspectRatio(m.aspect, contentMode: .fit)
            .frame(height: height)
    }

    /// 印は面の変形の間も見えているので、きっかけの直後に動かしてよい（変形と同じ 180ms 帯に収まる）。
    private func react(stretching: Bool) {
        guard !still else { return }
        let total = stretching ? Motion.markStretchMs : Motion.markAckMs
        withAnimation(.easeOut(duration: total * 0.4)) {
            if stretching { stretch = true } else { ack = true }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + total * 0.4) {
            withAnimation(.spring(response: total, dampingFraction: 0.62)) { stretch = false; ack = false }
        }
    }
}

/// 作業中だけ Dock の下辺を進む細い流れ。進捗率は表さない。
/// Reduce Motion / selftest では描かない（静止した線は区切り線に見えるため。状態は印の静止形で伝わる）。
struct DockFlowLine: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion || GeniePresenceMotion.frozen {
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
