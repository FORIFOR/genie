import AppKit
import AVFoundation

/// 本人の「ジーニー」を録る（呼びかけ検出を本人の声で学び直すため）。
///
/// 短い合図音を `interval` 秒ごとに `count` 回鳴らす。合図の後に「ジーニー」と言ってもらい、全体を 1 本の
/// 16 kHz mono WAV として端末の中にだけ残す（`~/Library/Application Support/Genie/wake/enroll-*.wav`、0600）。
/// 外へは送らない。区切り（1 回ずつの切り出し）は学習の側（tools/wakeword/train.py）が音の大きさで行う。
@MainActor
final class WakeEnrollment {
    static let shared = WakeEnrollment()
    nonisolated static let count = 20
    static let interval = 3.0
    private(set) var running = false

    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Genie/wake", isDirectory: true)
    }

    /// 録り終えたら保存先を返す（失敗は nil）。録る間は呼びかけの待ち受けを止める。
    func record(count: Int = WakeEnrollment.count) async -> URL? {
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
            return url
        } catch {
            GenieLog.write("wake", "enrollment: could not save \(error)"); return nil
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
