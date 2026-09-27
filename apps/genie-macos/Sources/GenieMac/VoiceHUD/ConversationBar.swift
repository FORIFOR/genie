import SwiftUI

/// 「Genie と会話」の間だけ出る 1 行。何をしているか・マイクが開いているか・どう止めるかを見せる。
///
/// 「会話を終了」は声だけを止める（仕事は取り消さない）。「閉じる」（表示）や
/// 仕事の取り消しとは別の操作にしてある。延長は本人の操作だけで、終わる 30 秒前に出る。
struct ConversationBar: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var voice = VoiceHUDState.shared

    private var remaining: String {
        let s = max(0, Int(voice.conversationRemaining.rounded(.up)))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    /// いま何をしているか。答えのカードを残して次を聞いている間も、聞いていることが分かるように。
    private var phaseLabel: String {
        switch voice.conversation.phase {
        case .listening: Facts.conversationListening
        case .waiting: Facts.conversationThinking
        case .speaking: Facts.conversationSpeaking
        case .preparing, .inactive: "\(Facts.dockConversation)中"
        }
    }

    var body: some View {
        if voice.conversation.isActive {
            HStack(spacing: 8) {
                Circle()
                    .fill(voice.conversation.phase == .listening ? Palette.accent(dark) : Palette.muted(dark))
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
                Text(voice.conversationEnding ? "\(Facts.conversationEnding) · \(remaining)" : "\(phaseLabel) · \(remaining)")
                    .font(.system(size: S.type(Metrics.dockMetaSize)).monospacedDigit())
                    .foregroundStyle(voice.conversationEnding ? Palette.text(dark) : Palette.muted(dark))
                    .accessibilityIdentifier("conversationRemaining")
                Spacer(minLength: 0)
                // 読み上げだけを止める（会話は続く）。「会話を終了」とは別の操作。
                if voice.conversation.phase == .speaking {
                    Button { voice.stopConversationSpeech() } label: {
                        Text(Facts.conversationStopSpeech)
                            .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                            .foregroundStyle(Palette.text(dark))
                            .frame(height: 24)
                            .padding(.horizontal, 8)
                    }
                    .buttonStyle(GenieControlStyle(radius: 7, base: 0.06))
                    .accessibilityIdentifier("conversationStopSpeech")
                }
                if voice.conversationEnding, voice.conversation.canExtend {
                    Button { voice.extendConversation() } label: {
                        Text(Facts.conversationExtend)
                            .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                            .foregroundStyle(Palette.text(dark))
                            .frame(height: 24)
                            .padding(.horizontal, 8)
                    }
                    .buttonStyle(GenieControlStyle(radius: 7, base: 0.06))
                    .accessibilityIdentifier("conversationExtend")
                }
                Button { voice.endConversation(.user) } label: {
                    Text(Facts.conversationEnd)
                        .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                        .foregroundStyle(Palette.text(dark))
                        .frame(height: 24)
                        .padding(.horizontal, 8)
                }
                .buttonStyle(GenieControlStyle(radius: 7, base: 0.06))
                .accessibilityIdentifier("conversationEnd")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("conversationBar")
        }
    }
}
