import Foundation

/// 会話の中身を運ぶ先（段階 4 の下準備）。会話の**進み方**は `ConversationLoop` が決め、
/// ここは「マイクを開く・依頼を送る・読み上げる」を実際に行うだけ。
///
/// 提供元は、できないことを**できるふりをしない**。`capabilities` に正直に書き、
/// 使う側（VoiceHUDState）はそれを見て振る舞いを変える（例: 割り込めないなら半二重のまま）。
/// Gemini Live などを足すときは、この型を満たすものを 1 つ足し、本人の明示の同意で切り替える。
@MainActor
protocol ConversationProvider: AnyObject {
    var name: String { get }
    var capabilities: ConversationCapabilities { get }

    /// マイクを開く。`onFirstFrame` は実際の最初の音声フレームで、`onUtterance` は言い終えた文で呼ぶ。
    /// 戻り値は「開けたか」（開けなければ会話を終える）。
    func openInput(echoCancellation: Bool, onFirstFrame: @escaping () -> Void,
                   onUtterance: @escaping (String) -> Void) -> Bool
    func closeInput()
    /// 1 ターンを送る。答えは `onReply` で 1 回だけ返す。
    func send(_ text: String, onReply: @escaping (ConversationLoop.Reply) -> Void)
    /// 読み上げる。終わったら（止めたときも）`onFinish` を 1 回だけ呼ぶ。
    func speak(_ text: String, onFinish: @escaping () -> Void)
    func stopSpeaking()
    /// 会話が終わった。接続を閉じ、使った分を記録する（何も持たない提供元は何もしない）。
    func endSession()
}

extension ConversationProvider {
    func endSession() {}
}

/// 提供元ができること。宣言していないことを使う側は当てにしない。
struct ConversationCapabilities: Equatable {
    /// 読み上げ中に話しかけて止められるか（割り込み）。できなければ半二重。
    var bargeIn: Bool
    /// 音声（声そのもの）が Mac の外へ出るか。出るなら本人の明示の同意が要る。
    var sendsAudioOffDevice: Bool
    /// 読み上げの合成が Mac の外で行われるか。
    var synthesizesOffDevice: Bool
    /// 答えが来ないことがあるか（常時応答しない型）。あるなら「応答なし」でも会話を壊さない。
    var mayNotRespond: Bool
}

/// いまの経路: Apple の音声認識（端末）→ Genie の gateway（会話・仕事）→ macOS の読み上げ（端末）。
///
/// 「Local」とは呼ばない。認識と読み上げは端末でも、答えを作るのは gateway と、そこで選ばれた
/// モデルなので、すべてが端末の中ではない。
@MainActor
final class PipelineConversationProvider: ConversationProvider {
    let name = "pipeline"
    let capabilities = ConversationCapabilities(bargeIn: false, sendsAudioOffDevice: false,
                                                synthesizesOffDevice: false, mayNotRespond: false)

    private let openMic: (Bool, @escaping () -> Void, @escaping (String) -> Void) -> Bool
    private let closeMic: () -> Void
    private let submit: (String, @escaping (ConversationLoop.Reply) -> Void) -> Void
    private var speechOwner: UUID?

    init(openMic: @escaping (Bool, @escaping () -> Void, @escaping (String) -> Void) -> Bool,
         closeMic: @escaping () -> Void,
         submit: @escaping (String, @escaping (ConversationLoop.Reply) -> Void) -> Void) {
        self.openMic = openMic
        self.closeMic = closeMic
        self.submit = submit
    }

    func openInput(echoCancellation: Bool, onFirstFrame: @escaping () -> Void,
                   onUtterance: @escaping (String) -> Void) -> Bool {
        openMic(echoCancellation, onFirstFrame, onUtterance)
    }

    func closeInput() { closeMic() }

    func send(_ text: String, onReply: @escaping (ConversationLoop.Reply) -> Void) { submit(text, onReply) }

    func speak(_ text: String, onFinish: @escaping () -> Void) {
        let owner = UUID()
        speechOwner = owner
        GenieSpeechOutput.shared.read(text, owner: owner) { [weak self] in
            // 止めた・次の読み上げに替わった後の「読み終えた」は、このターンのものではない。
            guard let self, self.speechOwner == owner else { return }
            self.speechOwner = nil
            onFinish()
        }
    }

    func stopSpeaking() {
        guard let owner = speechOwner else { return }
        speechOwner = nil
        GenieSpeechOutput.shared.stop(owner: owner)
    }
}
