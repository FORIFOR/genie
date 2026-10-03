import AppKit

/// `--selftest wakeword <audio>`: 「ジーニー」の待ち受けを本番と同じ取り込み・認識器で動かし、
/// 音声ファイルを流し込んで、認識器が書いた文字と、呼びかけとして見つけたかを出す。マイクは使わない。
extension SelfTest {
    @MainActor
    static func wakeWord(_ args: [String]) async {
        NSApp.setActivationPolicy(.accessory)
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 2, let frames = loadMono16k(args[i + 2]), !frames.isEmpty else {
            print("SELFTEST_FAIL wakeword: usage <audio>"); exit(2)
        }
        RecordingRuntime.shared.voiceInjection = frames
        var heard: [String] = []
        var woke = false
        let listener = WakeWordListener.shared
        listener.onWake = { woke = true }
        listener.onHeard = { heard.append($0) }
        listener.evaluate()
        guard listener.listening else {
            print("SELFTEST_FAIL wakeword: did not start listening (mic/speech permission or mic in use)"); exit(2)
        }
        let deadline = Date().addingTimeInterval(Double(frames.count) / 16_000 + 6)
        while Date() < deadline, !woke { try? await Task.sleep(nanoseconds: 100_000_000) }
        listener.suspend()
        let last = heard.suffix(4).joined(separator: " | ")
        print((woke ? "SELFTEST_OK" : "SELFTEST_FAIL") + " wakeword: woke=\(woke) heard=[\(last)]")
        exit(woke ? 0 : 2)
    }
}
