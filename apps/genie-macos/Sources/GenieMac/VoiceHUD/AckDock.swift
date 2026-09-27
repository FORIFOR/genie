import SwiftUI

/// 受付の応答（One Continuous Surface の 3）。**受け付けた（仕事ができた）ときだけ**「かしこまりました」。
/// 受け付けられなかった依頼は、同じ面で理由と「閉じる」を出す（受け付けたようには見せない）。
struct AckDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let ack: DockAck

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Image(systemName: ack.rejected == nil ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(ack.rejected == nil ? Palette.accent(dark) : Palette.warning(dark))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(ack.rejected == nil ? Facts.taskAccepted : Facts.taskRejected)
                        .font(.system(size: S.type(Metrics.dockTitleSize), weight: .semibold))
                        .foregroundStyle(Palette.text(dark))
                    Text(ack.rejected ?? "\(ack.title) · \(Facts.taskAcceptedSub)")
                        .font(.system(size: S.type(Metrics.dockMetaSize)))
                        .foregroundStyle(Palette.muted(dark))
                        .lineLimit(ack.rejected == nil ? 1 : 3)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if ack.rejected != nil {
                    Button { GenieStateStore.shared.dismissAck() } label: {
                        Text(Facts.resultClose)
                            .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                            .foregroundStyle(Palette.text(dark))
                            .frame(height: 28)
                            .padding(.horizontal, 9)
                    }
                    .buttonStyle(GenieControlStyle(radius: 7, base: 0.06))
                    .accessibilityIdentifier("ackClose")
                }
            }
            ConversationBar()
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .escapeKey { GenieStateStore.shared.dismissAck() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(ack.rejected == nil ? "dockAck" : "dockRejected")
    }
}

/// 音声入力で言い淀みを消して入れた直後（5 秒）。押せば入れた欄の文を元の文へ戻す。
struct DictatedDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let notice: DictatedText

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "text.badge.checkmark")
                .font(.system(size: 13))
                .foregroundStyle(Palette.accent(dark))
                .accessibilityHidden(true)
            Text(Facts.dictationCleaned)
                .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                .foregroundStyle(Palette.text(dark))
                .lineLimit(1)
            Spacer(minLength: 0)
            Button { VoiceHUDState.shared.restoreDictated(notice) } label: {
                Text(Facts.dictationRestore)
                    .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                    .foregroundStyle(Palette.text(dark))
                    .frame(height: 28)
                    .padding(.horizontal, 9)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0.06))
            .help(notice.original)
            .accessibilityIdentifier("dictationRestore")
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .escapeKey { VoiceHUDState.shared.mode = .idle }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockDictated")
    }
}
