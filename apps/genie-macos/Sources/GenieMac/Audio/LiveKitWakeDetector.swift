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
    private var quietUntil = Date.distantPast
    /// 調整用: 直近の最高点（genie.log に時々書く）。
    private var peak: Float = 0
    private var lastPeakLog = Date()

    /// 直近 1 秒に声らしい大きさの音が無ければ評価しない（呼びかけは 1.2 秒以内に言い終えている）。
    /// 静かな部屋で推論を回し続けない（常時 CPU 50% 超だった。2026-10-05 計測）。
    static let speechLevel: Float = 0.006
    private var recentLoud: [(rms: Float, samples: Int)] = []   // フレームごとの大きさ（直近 1 秒ぶん）

    /// 判定の厳しさ。学習に使っていない声で（2026-10-05）:
    /// 0.80×2 = 検出 39/46・誤検出 3/116、0.90×3 = 38/46・1/116、**0.95×2 = 39/46・1/116**（実機の誤検出 9 件中 2）。
    /// 3 回続けては、本人の短い「ジーニー」（0.94〜0.99 が一瞬）を取りこぼしていた（genie.log 2026-10-05）。
    /// 「Mac が音を出している間だけ厳しく」は、OBS 等が出力装置を開いたままだと常に「出している」になり、見分けられなかった。
    init(modelURL: URL, threshold: Float = 0.95, hits: Int = 2, provider: ExecutionProvider = .cpu) throws {
        model = try WakeWordModel(models: [modelURL], sampleRate: 16_000, executionProvider: provider)
        self.threshold = threshold
        self.hits = hits
    }

    func reset() {
        ring = [Int16](repeating: 0, count: Self.windowSamples)
        filled = 0; sinceEval = 0; decision = WakeDecision(); recentLoud = []; recentCalls = []
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
        heardSeconds += Double(samples.count) / 16_000
        sinceEval += samples.count
        let rms = sqrt(frame.reduce(0) { $0 + $1 * $1 } / Float(max(1, frame.count)))
        recentLoud.append((rms, frame.count))
        noteInput(rms)
        var kept = recentLoud.reduce(0) { $0 + $1.samples }
        while kept - (recentLoud.first?.samples ?? 0) >= 16_000 { kept -= recentLoud.removeFirst().samples }
        guard filled >= Self.windowSamples, sinceEval >= Self.stride, Date() >= quietUntil else { return false }
        sinceEval = 0
        guard (recentLoud.map(\.rms).max() ?? 0) >= Self.speechLevel else { decision.quiet(); return false }
        guard let out = try? model.predictDetailed(ring), let score = out.scores[Self.modelName] else { return false }
        notePeak(score)
        onScore?(heardSeconds, score)
        // 覚えた呼びかけと比べる窓（高い点の出た直近の窓）。言い終わりの位置で embedding が揺れるので 1 つに絞らない。
        if score >= WakeDecision.repeatFloor, out.embeddings.count == WakeVoicePrint.dimension {
            recentCalls.append((heardSeconds, out.embeddings))
        }
        recentCalls.removeAll { heardSeconds - $0.at > Self.compareSeconds }
        let verdict = decision.next(score: score, threshold: threshold, hits: hits,
                                    at: Date(timeIntervalSinceReferenceDate: heardSeconds))
        guard verdict != .none else { return false }
        var label = String(format: "model score %.2f%@", score, verdict == .repeated ? " (called again)" : "")
        // 声を覚えていれば、本人の声でなければ起きない（周りの会話・テレビで起きていた）。
        // 話者の特徴（SpeakerPrint）があればそれで、無ければ前の「言い方の形」（WakeVoicePrint）で比べる。
        if let speaker = speakerPrint, let encoder = speakerEncoder {
            recentCalls = []
            let window = ring.map { Float($0) / Float(Int16.max) }
            guard let embedding = encoder.embedding(of: window) else {
                GenieLog.write("wake", label + " — held back: too little voice to tell who called"); return false
            }
            let similarity = speaker.similarity(embedding)
            lastSpeakerSimilarity = similarity
            if similarity >= SpeakerPrint.threshold {
                label += String(format: " — the enrolled voice (%.2f)", similarity)
            } else if similarity >= SpeakerPrint.unsure, let voiced = SpeakerEncoder.voiced(window) {
                // 迷う点: 起きて、続けて話した声も合わせて確かめ直す（WakeController）。「ジーニー」は 1 秒に満たず、
                // 本人でも 0.42 に届かないことがあった（本人の 2 回の呼びかけどうしで 0.42、2026-10-20）
                label += String(format: " — unsure (%.2f), confirming with what follows", similarity)
                pendingConfirmation = voiced
            } else {
                GenieLog.write("wake", label + String(format: " — held back: another voice (%.2f, needs %.2f)",
                                                      similarity, SpeakerPrint.threshold))
                return false
            }
            GenieLog.write("wake", label)
        } else if let print = voicePrint {
            let similarity = recentCalls.map { print.similarity($0.embedding) }.max() ?? 0
            recentCalls = []
            guard similarity >= print.threshold else {
                GenieLog.write("wake", label + String(format: " — held back: unlike the enrolled calls (%.2f, needs %.2f)",
                                                      similarity, print.threshold))
                return false
            }
            label += String(format: " — like the enrolled calls (%.2f)", similarity)
            GenieLog.write("wake", label)
        } else {
            GenieLog.write("wake", label)
        }
        quietUntil = Date().addingTimeInterval(Self.cooldown)
        lastFiredWindow = ring
        lastWake = label
        return true
    }

    /// 検査（--selftest wakemodel）: 直近に起きたときの判定（どの道で起きたか）。
    private(set) var lastWake: String?

    /// 起きると決めた時点から、これだけ前までの高い点の窓を比べる。
    static let compareSeconds: TimeInterval = 1.0
    private var recentCalls: [(at: TimeInterval, embedding: [Float])] = []

    /// 声を覚えたときの呼びかけ（無ければ分類器だけで決める）。覚え直したら差し替える。
    private let printLock = NSLock()
    private var storedPrint: WakeVoicePrint? = WakeVoicePrint.load()
    var voicePrint: WakeVoicePrint? {
        get { printLock.lock(); defer { printLock.unlock() }; return storedPrint }
        set { printLock.lock(); storedPrint = newValue; printLock.unlock() }
    }

    /// 本人の声（無ければ使わない）。覚え直したら差し替える。
    private var storedSpeaker: SpeakerPrint? = SpeakerPrint.load()
    var speakerPrint: SpeakerPrint? {
        get { printLock.lock(); defer { printLock.unlock() }; return storedSpeaker }
        set { printLock.lock(); storedSpeaker = newValue; printLock.unlock() }
    }
    /// 話者の特徴を出すモデル（同梱が無ければ nil。そのときは前の比べ方だけ）。
    var speakerEncoder: SpeakerEncoder? = SpeakerEncoder.modelURL().flatMap { try? SpeakerEncoder(modelURL: $0) }
    /// 迷う点で起きたときの呼びかけの声（続けて話した声と合わせて確かめ直す）。受け取ったら消える。
    private var pendingValue: [Float]?
    var pendingConfirmation: [Float]? {
        get { printLock.lock(); defer { printLock.unlock() }; return pendingValue }
        set { printLock.lock(); pendingValue = newValue; printLock.unlock() }
    }
    func takePendingConfirmation() -> [Float]? {
        printLock.lock(); defer { printLock.unlock() }
        let value = pendingValue; pendingValue = nil; return value
    }
    /// 検査（--selftest wakemodel）: 直近に本人かを比べたときの似かた。
    private(set) var lastSpeakerSimilarity: Float?

    private var decision = WakeDecision()
    /// 検査（--selftest wakemodel）: 評価のたびに、音の時刻と点を渡す。
    var onScore: ((TimeInterval, Float) -> Void)?
    /// 聞いた音の長さ（秒）。呼び直しの間は音の時刻で測る（ファイルを速く流す検査でも、マイクと同じ判定になる）。
    private var heardSeconds: TimeInterval = 0

    /// マイクに音が届いているかの調べ: 1 分ごとに、待ち受けで聞いた最大の大きさを残す。
    private var inputMax: Float = 0
    private var inputLogged = Date()
    private func noteInput(_ rms: Float) {
        inputMax = max(inputMax, rms)
        guard Date().timeIntervalSince(inputLogged) >= 60 else { return }
        GenieLog.write("wake", String(format: "input level in the last minute: %.4f (speech gate %.4f)", inputMax, Self.speechLevel))
        inputMax = 0; inputLogged = Date()
    }

    /// 直近に起きたときの 2 秒（誤検出だったら学び直しに使う。端末の中だけ）。
    private(set) var lastFiredWindow: [Int16]?
    /// 呼んだのに起きなかったときの調べ: 声のまとまりごとに最高点を 1 行残す（0.5 以上で起きなかったもの）。
    private var burstMax: Float = 0
    private func notePeak(_ score: Float) {
        if score >= 0.3 { burstMax = max(burstMax, score) }
        else if burstMax > 0 {
            if burstMax >= 0.5 {
                GenieLog.write("wake", String(format: "near miss %.2f (one call %.2f, called twice %.2f)", burstMax, threshold, WakeDecision.repeatFloor))
            }
            burstMax = 0
        }
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

/// 起きるかどうかの判定（点数の並びだけで決める。モデルを使わないので試験できる）。
///
/// - 閾値を `hits` 回続けて超えたら起きる（一瞬の似た音で起きない）。
/// - **呼び直し**: 一瞬だけ閾値を超えた（続かなかった）呼びかけが、`repeatWindow` 秒以内にもう一度あれば起きる。
///   本人の短い「ジーニー」は 1.00 が一瞬だけ出て続かず、何度呼んでも起きなかった（genie.log 2026-10-16
///   02:18〜02:21、30 秒ごとの最高点 1.00 が 3 回・near miss 0.87〜0.94 が 4 回で、会話は始まらなかった）。
///   閾値を下げるのと違い、離れた 2 回の高い点が要るので、テレビや会話の一瞬では起きにくい。
struct WakeDecision {
    enum Verdict { case none, streak, repeated }
    static let repeatWindow: TimeInterval = 12
    /// 呼びかけの始まりどうしがこれより近ければ、同じ呼びかけの揺れとみなす。1.2 秒では、ふつうの文
    /// （「明日の天気は…銀行に行ってから、新しいシステムの設定を…」、Kyoko の合成音）の 0.91 → 0.89 で起きた。
    static let repeatGap: TimeInterval = 1.5
    /// 点がここより下がったら、1 回の呼びかけが終わった（次に高くなれば別の呼びかけ）。
    /// 以前は高い点が出るたびに「前の高い点」を更新していたので、高い点が続く間は 2 回目と数えられなかった。
    static let releaseLevel: Float = 0.5
    /// 呼び直しで数える点。本人の「ジーニー」は 0.77〜0.86 で止まる日があった（genie.log 2026-10-16 03:19〜04:09、
    /// 1 回で起きる 0.95 に届かず、呼んでも反応しなかった）。1 回だけでは起きず、2 回が要る。
    static let repeatFloor: Float = 0.80

    private(set) var streak = 0
    private var callStart: Date?
    private var inCall = false

    mutating func quiet() { streak = 0; inCall = false }

    mutating func next(score: Float, threshold: Float, hits: Int, at now: Date) -> Verdict {
        if score >= threshold {
            streak += 1
            if streak >= hits { self = WakeDecision(); return .streak }
        } else {
            streak = 0
        }
        if score < Self.releaseLevel { inCall = false }
        guard score >= Self.repeatFloor, !inCall else { return .none }
        // 新しい呼びかけの始まり。
        inCall = true
        if let start = callStart {
            let since = now.timeIntervalSince(start)
            if since < Self.repeatGap { return .none }   // 同じ呼びかけの揺れ
            if since <= Self.repeatWindow { self = WakeDecision(); return .repeated }
        }
        callStart = now
        return .none
    }
}
