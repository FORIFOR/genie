import AVFoundation
import Foundation

/// `--selftest micprobe`: 本物のマイクに音が届くか。取り込みを 1 つずつ開いて、最大振幅を測る。
///   1. 除去なし・静か   2. 除去なし・`say` で声を流す   3. 除去あり（voice processing）・声を流す
/// 会話のマイクはエコー除去を頼むので、3 で無音になるならそれが「声が文字にならない」原因。
extension SelfTest {
    @MainActor
    static func micProbe() async {
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP micprobe: mic not granted"); exit(0) }
        final class Peak: @unchecked Sendable {
            private let lock = NSLock(); private var v: Float = 0; private var n = 0
            func take(_ f: [Float]) { let m = f.reduce(Float(0)) { max($0, abs($1)) }; lock.lock(); v = max(v, m); n += f.count; lock.unlock() }
            var value: (Float, Int) { lock.lock(); defer { lock.unlock() }; return (v, n) }
        }
        func measure(echo: Bool, speak: Bool) async -> String {
            let mic = MicCapture()
            let peak = Peak()
            do { try mic.start(echoCancellation: echo) { peak.take($0) } } catch { return "start-failed(\(error))" }
            let vp = mic.voiceProcessingActive
            var say: Process?
            if speak {
                let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
                p.arguments = ["-v", "Kyoko", "明日の天気を教えてください。テストです。"]
                try? p.run(); say = p
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            say?.waitUntilExit()
            mic.stop()
            let (v, n) = peak.value
            return String(format: "peak=%.3f samples=%d vp=%@", v, n, vp ? "on" : "off")
        }
        let quiet = await measure(echo: false, speak: false)
        let loud = await measure(echo: false, speak: true)
        let echo = await measure(echo: true, speak: true)
        print("SELFTEST_OK micprobe: quiet[\(quiet)] speaking[\(loud)] speaking+AEC[\(echo)]")
        exit(0)
    }
}
