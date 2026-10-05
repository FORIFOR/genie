import AVFoundation
import SwiftUI

/// Genie の声。**Gemini TTS だけ**で読む（macOS 標準の読み上げは使わない。本人の指示 2026-10-04）。
/// 音声を作れなければ黙って終わる（待つ側は止めない）。理由は genie.log に残す。
@MainActor final class GenieSpeechOutput: NSObject, ObservableObject, AVAudioPlayerDelegate {
    static let shared = GenieSpeechOutput()
    @Published private(set) var mode: GenieOrbMode = .idle
    @Published private(set) var owner: UUID?
    private var player: AVAudioPlayer?
    private var work: Task<Void, Never>?
    /// 読み終えた（止めた場合も）ときに一度だけ呼ぶ。会話の次のターンはこれを待ってマイクを開く。
    private var completion: (() -> Void)?

    func read(_ text: String, owner: UUID, onFinish: (() -> Void)? = nil) {
        stop()
        let content = Self.spokenText(text)
        // 読むものが無い（コードだけの答えなど）。**知らせずに黙らない** —— 待つ側が止まる。
        guard !content.isEmpty else { onFinish?(); return }
        self.owner = owner; completion = onFinish; mode = .preparing
        let key = GeminiLiveSettings.shared.apiKey()
        work = Task { [weak self] in
            do {
                let audio = try await GeminiSpeech.synthesize(content, apiKey: key)
                guard let self, !Task.isCancelled, self.owner == owner else { return }
                let player = try AVAudioPlayer(data: audio)
                player.delegate = self
                self.player = player
                self.mode = .speaking
                if !player.play() { self.finish(owner) }
            } catch {
                guard !Task.isCancelled else { return }
                GenieLog.write("speech", "Gemini TTS failed: \(GenieLog.clip(String(describing: error), 160))")
                self?.finish(owner)
            }
        }
    }

    /// 決まった文（呼びかけへの返事など）の音声を先に作っておく。作れなくても何もしない。
    func prepare(_ text: String) {
        let content = Self.spokenText(text)
        guard !content.isEmpty, !FileManager.default.fileExists(atPath: GeminiSpeech.cacheURL(for: content).path) else { return }
        let key = GeminiLiveSettings.shared.apiKey()
        Task.detached {
            do { _ = try await GeminiSpeech.synthesize(content, apiKey: key) }
            catch { GenieLog.write("speech", "Gemini TTS prepare failed: \(GenieLog.clip(String(describing: error), 160))") }
        }
    }

    func stop(owner: UUID? = nil) {
        if let owner, self.owner != owner { return }
        let completion = self.completion
        work?.cancel(); work = nil
        player?.stop(); player = nil
        self.owner = nil; self.completion = nil; mode = .idle
        completion?()
    }

    private func finish(_ owner: UUID) {
        guard self.owner == owner else { return }
        let completion = self.completion
        work = nil; player = nil
        self.owner = nil; self.completion = nil; mode = .idle
        completion?()
    }

    static func spokenText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "(?s)```.*?```", with: "", options: .regularExpression)
            .replacingOccurrences(of: "(?m)^#{1,6}\\s+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "[*`_]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, self.player === player, let owner = self.owner else { return }
            self.finish(owner)
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, self.player === player, let owner = self.owner else { return }
            GenieLog.write("speech", "could not play the Gemini audio")
            self.finish(owner)
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
        .help(active ? "読み上げを停止" : "Genie の声で読み上げる")
        .accessibilityLabel(active ? "読み上げを停止" : "作成した文章を読み上げ")
        .accessibilityIdentifier("taskResultReadAloud")
        .onDisappear { output.stop(owner: owner) }
    }
}
