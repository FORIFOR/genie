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
        // --start: 見つけたら本番どおり会話を始め、続くかを見る（会話のマイクは実マイク）。
        let startConversation = args.contains("--start")
        let realWake = listener.onWake
        listener.onWake = { woke = true; if startConversation { realWake() } }
        listener.onHeard = { heard.append($0) }
        listener.evaluate()
        guard listener.listening else {
            print("SELFTEST_FAIL wakeword: did not start listening (mic/speech permission or mic in use)"); exit(2)
        }
        let deadline = Date().addingTimeInterval(Double(frames.count) / 16_000 + 6)
        while Date() < deadline, !woke { try? await Task.sleep(nanoseconds: 100_000_000) }
        if startConversation, woke {
            var timeline: [String] = []
            var ended = ""
            let token = GenieEventBus.shared.subscribe { event in
                if case .voiceSessionEnded(let reason) = event { ended = reason }
            }
            for step in 0..<40 {
                let hud = VoiceHUDState.shared
                timeline.append("\(step * 200)ms active=\(hud.conversation.isActive) mode=\(String(describing: hud.mode).prefix(30))")
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            _ = token
            print("WAKE_TIMELINE ended=\(ended)\n" + timeline.enumerated().filter { $0.offset % 5 == 0 }.map(\.element).joined(separator: "\n"))
            VoiceHUDState.shared.endConversation()
        }
        listener.suspend()
        let last = heard.suffix(4).joined(separator: " | ")
        print((woke ? "SELFTEST_OK" : "SELFTEST_FAIL") + " wakeword: woke=\(woke) heard=[\(last)]")
        exit(woke ? 0 : 2)
    }
}
