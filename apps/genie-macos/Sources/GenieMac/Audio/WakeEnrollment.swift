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
    static let count = 20
    static let interval = 3.0
    private(set) var running = false

    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Genie/wake", isDirectory: true)
    }

    /// 録り終えたら保存先を返す（失敗は nil）。録る間は呼びかけの待ち受けを止める。
    func record() async -> URL? {
        guard !running, Permissions.microphone == .granted else { return nil }
        running = true
        defer { running = false }
        WakeController.shared.stop()
        defer { WakeController.shared.start() }
        GenieLog.write("wake", "enrollment: recording \(Self.count) calls")
        let mic = MicCapture()
        let lock = NSLock()
        var samples: [Float] = []
        do {
            try mic.start(echoCancellation: false) { frame in lock.lock(); samples += frame; lock.unlock() }
        } catch {
            GenieLog.write("wake", "enrollment: microphone failed \(error)"); return nil
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        for _ in 0..<Self.count {
            NSSound(named: "Tink")?.play()
            try? await Task.sleep(nanoseconds: UInt64(Self.interval * 1_000_000_000))
        }
        mic.stop()
        lock.lock(); let audio = samples; lock.unlock()
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
