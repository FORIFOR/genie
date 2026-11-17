import Foundation

extension SelfTest {
    /// `--selftest enrollrecord`: 「声を覚える」の録音に声が入るか（2026-10-18 の録音は無音だった）。
    /// 録る間、スピーカーから「ジーニー」ではない文を流す（動いている Genie を起こさない）。録ったファイルは消す。
    @MainActor static func enrollRecord() async {
        setvbuf(stdout, nil, _IONBF, 0)
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP enrollrecord"); exit(0) }
        // 本番と同じ状態から録る: 待ち受けが動いていて、会話（エコー除去の入り切り）を一度終えた後。
        final class Idle: WakeDetector { func process(_ frame: [Float]) -> Bool { false }; func reset() {} }
        let hub = VoiceInputHub.shared
        try? hub.startStandby(detector: Idle(), onWake: {})
        _ = try? hub.attach { _ in }
        hub.setEchoCancellation(true)
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        hub.detach()
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", "Kyoko", "マイクの確認をしています。録音に声が入るかを見ています。もう少しで終わります。"]
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { try? say.run() }
        // 「ジーニー」ではない文なので覚えさせない（本人の覚えた呼びかけを上書きしない）。
        guard let url = await WakeEnrollment.shared.record(count: 3, learn: false)?.url else {
            print("SELFTEST_FAIL enrollrecord: nothing saved (no voice in the recording)"); exit(1)
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        try? FileManager.default.removeItem(at: url)
        print("SELFTEST_OK enrollrecord (saved \(size) bytes, removed)")
        exit(0)
    }
}
