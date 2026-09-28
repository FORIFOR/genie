import SwiftUI

/// The user-selected glass orb. Text alongside it carries the accessible state.
struct GenieOrb: View {
    var mode: GenieOrbMode = .idle
    var level: Float = 0
    var size: CGFloat = Metrics.hudOrbSize
    @Environment(\.accessibilityReduceMotion) private var reduced

    var body: some View {
        Group {
            if CommandLine.arguments.contains("--selftest"),
               let image = LiquidOrbGPU.shared?.image(mode: mode, size: 192, level: level) {
                // Freeze a frame of the SAME Metal pipeline for reproducible UI goldens.
                Image(nsImage: image).resizable().scaledToFit()
            } else if LiquidOrbGPU.shared != nil {
                LiquidOrbSurface(mode: mode, level: level, reduced: reduced)
            } else if let image = NSImage(data: LiquidOrbAssets.fallbackPNG) {
                // A static frame of the same shader, with no GPU or browser dependency.
                Image(nsImage: image).resizable().scaledToFit()
                    .opacity(mode.animated ? 1 : 0.65)
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Compact, static idle entry; no continuous rendering while Genie is not working.
struct GenieVoiceMark: View {
    // Genie の印（ランプ）。ブランド記号であって、音の量ではない（`GenieBrandMark`）。
    var body: some View {
        // 1b: 待機の印は本文色で静止。青（presence）は聞く・作業するときだけ印の中に出る。
        GenieBrandMarkView(height: 12, color: Palette.text(true).opacity(0.92))
            .frame(height: 14)
    }
}
