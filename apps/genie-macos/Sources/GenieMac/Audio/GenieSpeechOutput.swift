import AVFoundation
import SwiftUI

/// User-initiated macOS speech. No cloud TTS request or automatic reading of private answers.
@MainActor final class GenieSpeechOutput: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = GenieSpeechOutput()
    @Published private(set) var mode: GenieOrbMode = .idle
    @Published private(set) var owner: UUID?
    private let synthesizer = AVSpeechSynthesizer()
    private var utterance: AVSpeechUtterance?
    private var completion: (() -> Void)?
    override init() { super.init(); synthesizer.delegate = self }

    func read(_ text: String, owner: UUID, onFinish: (() -> Void)? = nil) {
        stop()
        let content = Self.spokenText(text)
        guard !content.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: content)
        utterance.voice = AVSpeechSynthesisVoice(language: content.range(of: "[ぁ-んァ-ン一-龯]", options: .regularExpression) != nil ? "ja-JP" : "en-US")
        self.utterance = utterance; self.owner = owner; self.completion = onFinish; mode = .preparing
        synthesizer.speak(utterance)
    }
    func stop(owner: UUID? = nil) {
        if let owner, self.owner != owner { return }
        utterance = nil; self.owner = nil; completion = nil; mode = .idle
        synthesizer.stopSpeaking(at: .immediate)
    }
    static func spokenText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "(?s)```.*?```", with: "", options: .regularExpression)
            .replacingOccurrences(of: "(?m)^#{1,6}\\s+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "[*`_]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.utterance === utterance else { return }
            self.mode = .speaking
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finished(utterance) }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finished(utterance) }
    private nonisolated func finished(_ utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.utterance === utterance else { return }
            let completion = self.completion
            self.utterance = nil; self.owner = nil; self.completion = nil; self.mode = .idle
            completion?()
        }
    }
}

struct GenieReadAloudButton: View {
    let text: String
    let owner: UUID
    @ObservedObject private var output = GenieSpeechOutput.shared
    private var active: Bool { output.owner == owner && output.mode != .idle }
    var body: some View {
        Button {
            if active { output.stop(owner: owner) }
            else {
                if case .listening = VoiceHUDState.shared.mode { VoiceHUDState.shared.cancelListening() }
                output.read(text, owner: owner)
            }
        } label: {
            HStack(spacing: 4) {
                if active { GenieOrb(mode: output.mode, size: 28) }
                else { Image(systemName: "speaker.wave.2") }
                Text(active ? "停止" : "読み上げ")
            }
        }
        .help(active ? "読み上げを停止" : "Macの音声で読み上げる")
        .accessibilityLabel(active ? "読み上げを停止" : "作成した文章を読み上げ")
        .accessibilityIdentifier("taskResultReadAloud")
        .onDisappear { output.stop(owner: owner) }
    }
}
