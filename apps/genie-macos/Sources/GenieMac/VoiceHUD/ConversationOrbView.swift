import SwiftUI

/// 会話の間の Dock。**中心のオーブ**が声に反応し、答えは声で返る（文字起こしは出さない）。
///
/// 聞いている間はマイクの大きさでオーブが動き、考えている間・話している間はその姿になる。
/// 状態は短い言葉 1 つで、止め方（会話を終了）は下の行にいつもある。
struct ConversationOrbView: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var voice = VoiceHUDState.shared
    @ObservedObject private var speech = GenieSpeechOutput.shared

    private var orbMode: GenieOrbMode {
        switch voice.conversation.phase {
        case .listening: .listening
        case .preparing: .preparing
        case .waiting: .thinking
        case .speaking: .speaking
        case .inactive: .idle
        }
    }

    private var label: String {
        switch voice.conversation.phase {
        case .listening, .preparing: Facts.conversationListening
        case .waiting: Facts.conversationThinking
        case .speaking: Facts.conversationSpeaking
        case .inactive: ""
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            GenieOrb(mode: orbMode, level: voice.conversation.phase == .listening ? voice.inputLevel : 0, size: 72)
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
            Text(label)
                .font(.system(size: S.type(Metrics.dockPrimarySize), weight: .medium))
                .foregroundStyle(Palette.text(dark))
                .accessibilityIdentifier("conversationOrbLabel")
            ConversationBar(showsPhase: false)
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .escapeKey { voice.endConversation(.user) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockConversation")
    }
}
