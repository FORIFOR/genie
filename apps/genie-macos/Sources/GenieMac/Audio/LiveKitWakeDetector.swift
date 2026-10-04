import Foundation
import LiveKitWakeWord

/// 端末の中だけで「ジーニー」を聞き分ける（livekit-wakeword の検出器 + Genie 用に学習した分類器 `genie_ja.onnx`）。
///
/// - 直近 2 秒を手元に持ち、`stride` ごとにその 2 秒を評価する（毎回 2 秒待つのではない）
/// - `threshold` を `hits` 回続けて超えたら呼びかけとみなす（一瞬の似た音で起きない）
/// - 起きた後 `cooldown` 秒は評価しない
/// - 推論は `VoiceInputHub` の専用の列から 1 回ずつ呼ばれる（同じモデルを並行して呼ばない）
final class LiveKitWakeDetector: WakeDetector {
    static let modelName = "genie_ja"
    let threshold: Float
    let hits: Int
    static let stride = 3_200            // 0.2 秒（16 kHz）
    static let windowSamples = 32_000    // 2 秒
    static let cooldown = 2.0

    private let model: WakeWordModel
    private var ring = [Int16](repeating: 0, count: windowSamples)
    private var filled = 0
    private var sinceEval = 0
    private var streak = 0
    private var quietUntil = Date.distantPast
    /// 調整用: 直近の最高点（genie.log に時々書く）。
    private var peak: Float = 0
    private var lastPeakLog = Date()

    /// 直近 1 秒に声らしい大きさの音が無ければ評価しない（呼びかけは 1.2 秒以内に言い終えている）。
    /// 静かな部屋で推論を回し続けない（常時 CPU 50% 超だった。2026-10-05 計測）。
    static let speechLevel: Float = 0.006
    private var recentLoud: [(rms: Float, samples: Int)] = []   // フレームごとの大きさ（直近 1 秒ぶん）

    init(modelURL: URL, threshold: Float = 0.8, hits: Int = 2, provider: ExecutionProvider = .cpu) throws {
        model = try WakeWordModel(models: [modelURL], sampleRate: 16_000, executionProvider: provider)
        self.threshold = threshold
        self.hits = hits
    }

    func reset() {
        ring = [Int16](repeating: 0, count: Self.windowSamples)
        filled = 0; sinceEval = 0; streak = 0; recentLoud = []
    }

    func process(_ frame: [Float]) -> Bool {
        let samples = frame.map { Int16(max(-1, min(1, $0)) * Float(Int16.max)) }
        if samples.count >= Self.windowSamples {
            ring = Array(samples.suffix(Self.windowSamples))
        } else {
            ring.removeFirst(samples.count)
            ring.append(contentsOf: samples)
        }
        filled = min(Self.windowSamples, filled + samples.count)
        sinceEval += samples.count
        let rms = sqrt(frame.reduce(0) { $0 + $1 * $1 } / Float(max(1, frame.count)))
        recentLoud.append((rms, frame.count))
        var kept = recentLoud.reduce(0) { $0 + $1.samples }
        while kept - (recentLoud.first?.samples ?? 0) >= 16_000 { kept -= recentLoud.removeFirst().samples }
        guard filled >= Self.windowSamples, sinceEval >= Self.stride, Date() >= quietUntil else { return false }
        sinceEval = 0
        guard (recentLoud.map(\.rms).max() ?? 0) >= Self.speechLevel else { streak = 0; return false }
        guard let score = try? model.predict(ring)[Self.modelName] else { return false }
        notePeak(score)
        streak = score >= threshold ? streak + 1 : 0
        guard streak >= hits else { return false }
        streak = 0
        quietUntil = Date().addingTimeInterval(Self.cooldown)
        GenieLog.write("wake", String(format: "model score %.2f", score))
        return true
    }

    private func notePeak(_ score: Float) {
        peak = max(peak, score)
        guard Date().timeIntervalSince(lastPeakLog) > 30 else { return }
        if peak >= 0.3 { GenieLog.write("wake", String(format: "peak score in the last 30 s: %.2f", peak)) }
        peak = 0; lastPeakLog = Date()
    }

    /// 分類器の置き場所: 本人用に作り直したもの（Application Support）を優先し、無ければアプリ同梱のもの。
    static func modelURL() -> URL? {
        let custom = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Genie/wake/\(modelName).onnx")
        if FileManager.default.fileExists(atPath: custom.path) { return custom }
        return Bundle.main.url(forResource: modelName, withExtension: "onnx")
    }
}
