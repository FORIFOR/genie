import AVFoundation

extension SelfTest {
    /// `--selftest hubecho`: 共有マイク（VoiceInputHub + MicCapture）でエコー除去を有効にして、
    /// (a) 別のアプリの声（= 本人の割り込み役）は届き、(b) ハブで鳴らした声（= Genie の声）は小さくなるか。
    @MainActor static func hubEcho() async {
        setvbuf(stdout, nil, _IONBF, 0)
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP hubecho"); exit(0) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("hubecho.aiff")
        let say = Process(); say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", "Kyoko", "-o", tmp.path, "ちょっと待って、東京じゃなくて大阪の天気を教えて。"]
        try? say.run(); say.waitUntilExit()
        let hub = VoiceInputHub()
        let lock = NSLock(); var rmsSum: Double = 0; var n = 0
        _ = try? hub.attach { frame in
            let r = sqrt(frame.reduce(0) { $0 + Double($1 * $1) } / Double(max(1, frame.count)))
            lock.lock(); rmsSum += r; n += 1; lock.unlock()
        }
        func measure(_ label: String, _ body: () async -> Void) async {
            try? await Task.sleep(nanoseconds: 400_000_000)
            lock.lock(); rmsSum = 0; n = 0; lock.unlock()
            await body()
            lock.lock(); let avg = n > 0 ? rmsSum / Double(n) : 0; let frames = n; lock.unlock()
            print(String(format: "%@: mean rms %.4f over %d frames", label, avg, frames))
        }
        for echo in [false, true] {
            hub.setEchoCancellation(echo)
            await measure("echo=\(echo) quiet") { try? await Task.sleep(nanoseconds: 1_200_000_000) }
            await measure("echo=\(echo) other app voice") {
                let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/afplay"); p.arguments = [tmp.path]
                try? p.run(); while p.isRunning { try? await Task.sleep(nanoseconds: 100_000_000) }
            }
            await measure("echo=\(echo) Genie's own playback") {
                guard let file = try? AVAudioFile(forReading: tmp),
                      let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
                      (try? file.read(into: src)) != nil,
                      let conv = AVAudioConverter(from: file.processingFormat, to: MicCapture.playbackFormat),
                      let out = AVAudioPCMBuffer(pcmFormat: MicCapture.playbackFormat,
                                                 frameCapacity: AVAudioFrameCount(Double(src.frameLength) * 24_000 / file.processingFormat.sampleRate + 1024)) else { return }
                var fed = false; var err: NSError?
                conv.convert(to: out, error: &err) { _, st in if fed { st.pointee = .endOfStream; return nil }; fed = true; st.pointee = .haveData; return src }
                var done = false
                hub.play(out) { done = true }
                while !done { try? await Task.sleep(nanoseconds: 100_000_000) }
            }
        }
        hub.detach()
        print("SELFTEST_OK hubecho")
        exit(0)
    }
}
