import Foundation

extension SelfTest {
    /// Gemini TTS に実際に 1 回頼み、声が返るかを見る（キーは表示しない。音は鳴らさない）。
    @MainActor static func geminiTTS(_ args: [String]) async {
        let text = "テストです。\(Int(Date().timeIntervalSince1970))"
        let key = GeminiLiveSettings.shared.apiKey()
        let started = Date()
        do {
            let audio = try await GeminiSpeech.synthesize(text, apiKey: key)
            try? FileManager.default.removeItem(at: GeminiSpeech.cacheURL(for: text))
            let riff = audio.prefix(4) == Data("RIFF".utf8)
            print(String(format: "SELFTEST_OK geminitts: bytes=%d wav=%@ seconds=%.2f", audio.count, riff ? "yes" : "no", Date().timeIntervalSince(started)))
            exit(riff ? 0 : 2)
        } catch {
            print("SELFTEST_FAIL geminitts: key=\(key == nil ? "missing" : "present") \(error)")
            exit(2)
        }
    }
}
