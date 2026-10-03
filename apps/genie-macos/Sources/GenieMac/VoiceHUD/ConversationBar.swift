import SwiftUI

/// 「Genie と会話」の間だけ出る 1 行。何をしているか・マイクが開いているか・どう止めるかを見せる。
///
/// 「会話を終了」は声だけを止める（仕事は取り消さない）。「閉じる」（表示）や
/// 仕事の取り消しとは別の操作にしてある。延長は本人の操作だけで、終わる 30 秒前に出る。
struct ConversationBar: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var voice = VoiceHUDState.shared
    /// いまの状態（聞いています など）を書くか。見出しがすでに状態を言っている面（聞いている・考え中）では
    /// 重ねて書かない。答えのカードを残している間は、ここだけが状態を伝える。
    var showsPhase = true

    private var remaining: String {
        let s = max(0, Int(voice.conversationRemaining.rounded(.up)))
        return "\(Facts.conversationRemaining) " + String(format: "%d:%02d", s / 60, s % 60)
    }

    /// マイクが開いている（開けている途中を含む）。カードを残して次を待つ間も「聞いています」と言う。
    private var micOpen: Bool { voice.conversation.phase == .listening || voice.conversation.phase == .preparing }

    private var phaseLabel: String {
        switch voice.conversation.phase {
        case .listening, .preparing: Facts.conversationListening
        case .waiting: Facts.conversationThinking
        case .speaking: Facts.conversationSpeaking
        case .inactive: ""
        }
    }

    var body: some View {
        if voice.conversation.isActive {
            VStack(alignment: .leading, spacing: 8) {
                // カードの出所の行と混ざらないよう、面の区切りは hairline で（影や地は使わない）。
                Rectangle().fill(Color.hairline(dark)).frame(height: 0.5)
                HStack(spacing: 8) {
                    Circle()
                        .fill(micOpen ? Palette.accent(dark) : Palette.muted(dark))
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                    if showsPhase {
                        Text(phaseLabel)
                            .font(.system(size: S.type(Metrics.dockMetaSize)))
                            .foregroundStyle(micOpen ? Palette.text(dark) : Palette.muted(dark))
                            .accessibilityIdentifier("conversationPhase")
                    }
                    // 残り時間。終わり際（30 秒前）は時間だけを目立たせ、状態は消さない。
                    Text(voice.conversationEnding ? "\(Facts.conversationEnding) \(remaining)" : remaining)
                        .font(.system(size: S.type(Metrics.dockMetaSize)).monospacedDigit())
                        .foregroundStyle(voice.conversationEnding ? Palette.warning(dark) : Palette.muted(dark))
                        .accessibilityIdentifier("conversationRemaining")
                    Spacer(minLength: 0)
                    // 読み上げだけを止める（会話は続く）。「会話を終了」とは別の操作。
                    if voice.conversation.phase == .speaking {
                        barButton(Facts.conversationStopSpeech, id: "conversationStopSpeech") { voice.stopConversationSpeech() }
                    }
                    if voice.conversationEnding, voice.conversation.canExtend {
                        barButton(Facts.conversationExtend, id: "conversationExtend") { voice.extendConversation() }
                    }
                    barButton(Facts.conversationEnd, id: "conversationEnd") { voice.endConversation(.user) }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("conversationBar")
        }
    }

    private func barButton(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                .foregroundStyle(Palette.text(dark))
                .frame(height: 24)
                .padding(.horizontal, 8)
        }
        .buttonStyle(GenieControlStyle(radius: 7, base: 0.06))
        .accessibilityIdentifier(id)
    }
}
