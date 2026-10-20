import AppKit
import AVFoundation
import LiveKitWakeWord

/// 本人の「ジーニー」を録る（呼びかけ検出を本人の声で学び直すため）。
///
/// 短い合図音を `interval` 秒ごとに `count` 回鳴らす。合図の後に「ジーニー」と言ってもらい、全体を 1 本の
/// 16 kHz mono WAV として端末の中にだけ残す（`~/Library/Application Support/Genie/wake/enroll-*.wav`、0600）。
/// 外へは送らない。区切り（1 回ずつの切り出し）は学習の側（tools/wakeword/train.py）が音の大きさで行う。
@MainActor
final class WakeEnrollment {
    static let shared = WakeEnrollment()
    /// 20 回は多すぎた（利用者、2026-10-19）。話者の特徴（`SpeakerPrint`）なら 2 回で足りる
    /// （LibriSpeech 80 人で、2 回で覚えたとき本人 95.6%・他人 0.11%）。
    nonisolated static let count = 2
    nonisolated static let interval = 3.0
    private(set) var running = false

    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Genie/wake", isDirectory: true)
    }

    struct Recording {
        let url: URL
        /// 覚えた呼びかけの数（声が録れず覚えられなければ nil。そのときは前に覚えたものをそのまま使う）。
        let learnedCalls: Int?
    }

    /// 録り終えたら保存先を返す（失敗は nil）。録る間は呼びかけの待ち受けを止める。
    /// `learn` なら、録った呼びかけを覚えて待ち受けに渡す（`WakeVoicePrint`）。
    func record(count: Int = WakeEnrollment.count, learn: Bool = true) async -> Recording? {
        guard !running, Permissions.microphone == .granted else { return nil }
        running = true
        defer { running = false }
        WakeController.shared.stop()
        defer { WakeController.shared.start() }
        GenieLog.write("wake", "enrollment: recording \(count) calls")
        // 待ち受けと同じマイク（VoiceInputHub）で録る。別の MicCapture を開くと、待ち受けの engine と並んだときに
        // ほぼ無音（RMS 0.0001〜0.0003、合図音だけがかすかに）しか録れなかった（2026-10-18 15:00Z の録音）。
        let collector = Collector()
        do {
            try VoiceInputHub.shared.startStandby(detector: collector, onWake: {})
        } catch {
            GenieLog.write("wake", "enrollment: microphone failed \(error)"); return nil
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        for _ in 0..<count {
            NSSound(named: "Tink")?.play()
            try? await Task.sleep(nanoseconds: UInt64(Self.interval * 1_000_000_000))
        }
        VoiceInputHub.shared.stopStandby()
        let audio = collector.samples
        // 声が録れていなければ残さない（無音を「本人の声」として学ばせない）。
        let loudest = audio.reduce(Float(0)) { max($0, abs($1)) }
        guard loudest >= Self.minimumPeak else {
            GenieLog.write("wake", String(format: "enrollment: no voice recorded (peak %.4f) — not saved", loudest))
            return nil
        }
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
        let url = Self.directory.appendingPathComponent("enroll-\(stamp).wav")
        do {
            try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try Self.writeWAV(audio, to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            GenieLog.write("wake", String(format: "enrollment: saved %.0f s", Double(audio.count) / 16_000))
        } catch {
            GenieLog.write("wake", "enrollment: could not save \(error)"); return nil
        }
        guard learn else { return Recording(url: url, learnedCalls: nil) }
        let learned = await Task.detached { Self.learnSpeaker(audio, count: count) }.value
        if let learned { (WakeController.shared.detector as? LiveKitWakeDetector)?.speakerPrint = learned }
        return Recording(url: url, learnedCalls: learned?.calls)
    }

    /// 録音から本人の声（話者の特徴）を覚えて保存する。待ち受けとは別のモデルで計算する（並行して呼ばない）。
    nonisolated static func learnSpeaker(_ audio: [Float], count: Int, encoder: SpeakerEncoder? = nil,
                                         saveTo url: URL = SpeakerPrint.url) -> SpeakerPrint? {
        guard let encoder = encoder ?? SpeakerEncoder.modelURL().flatMap({ try? SpeakerEncoder(modelURL: $0) }) else {
            GenieLog.write("wake", "enrollment: speaker model unavailable — voice not learned"); return nil
        }
        // 合図ごとの区切り（合図音の 0.25 秒は除く）から、待ち受けと同じ切り出し（SpeakerEncoder.voiced）で声を取る
        let embeddings = speakerSlots(in: audio, count: count).compactMap { encoder.embedding(of: $0) }
        guard let print = SpeakerPrint.make(embeddings: embeddings) else {
            GenieLog.write("wake", "enrollment: no usable call of \(count) — voice not learned"); return nil
        }
        do {
            try print.save(to: url)
            GenieLog.write("wake", "enrollment: learned the voice from \(print.calls) of \(count) calls")
            return print
        } catch {
            GenieLog.write("wake", "enrollment: could not save the voice \(error)"); return nil
        }
    }

    /// 録音から呼びかけを覚えて保存する。待ち受けとは別の分類器で計算する（同じモデルを並行して呼ばない）。
    nonisolated static func learn(_ audio: [Float], count: Int, saveTo url: URL = WakeVoicePrint.url) -> WakeVoicePrint? {
        guard let modelURL = LiveKitWakeDetector.modelURL(),
              let model = try? WakeWordModel(models: [modelURL], sampleRate: 16_000, executionProvider: .cpu) else {
            GenieLog.write("wake", "enrollment: classifier unavailable — calls not learned"); return nil
        }
        let calls = WakeVoicePrint.calls(in: audio, count: count, interval: interval)
        let embeddings = calls.compactMap { WakeVoicePrint.embedding(of: $0, model: model, name: LiveKitWakeDetector.modelName) }
        guard let print = WakeVoicePrint.make(embeddings: embeddings) else {
            GenieLog.write("wake", "enrollment: \(embeddings.count) of \(count) calls usable — too few to learn (need \(WakeVoicePrint.minimumCalls))")
            return nil
        }
        do {
            try print.save(to: url)
            GenieLog.write("wake", String(format: "enrollment: learned %d of %d calls (match needs %.2f)",
                                          print.templates.count, count, print.threshold))
            return print
        } catch {
            GenieLog.write("wake", "enrollment: could not save the learned calls \(error)"); return nil
        }
    }

    /// 合図の 1 秒後から `interval` 秒ごとの区切り（合図音の 0.25 秒は除く）。`WakeVoicePrint.calls` と同じ位置で、切り出しはしない。
    nonisolated static func speakerSlots(in audio: [Float], count: Int, first: Double = 1.0) -> [[Float]] {
        let rate = 16_000.0
        return (0..<count).compactMap { k in
            let s0 = Int((first + interval * Double(k) + 0.25) * rate), s1 = Int((first + interval * Double(k + 1)) * rate)
            return s1 <= audio.count ? Array(audio[s0..<s1]) : nil
        }
    }

    /// 録音の最大振幅がこれ未満なら、声が録れていない（待ち受けの声は 0.04〜0.09 の RMS で届いている）。
    static let minimumPeak: Float = 0.02

    /// 録る間、待ち受けの代わりに音を受け取る（呼びかけとしては扱わない）。
    private final class Collector: WakeDetector {
        private let lock = NSLock()
        private var buffer: [Float] = []
        var samples: [Float] { lock.lock(); defer { lock.unlock() }; return buffer }
        func process(_ frame: [Float]) -> Bool { lock.lock(); buffer += frame; lock.unlock(); return false }
        func reset() {}
    }

    static func writeWAV(_ samples: [Float], to url: URL) throws {
        var data = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16_000); u32(32_000); u16(2); u16(16)
        data.append(contentsOf: Array("data".utf8)); u32(bytes)
        for s in samples { u16(UInt16(bitPattern: Int16(max(-1, min(1, s)) * Float(Int16.max)))) }
        try data.write(to: url, options: .atomic)
    }
}
