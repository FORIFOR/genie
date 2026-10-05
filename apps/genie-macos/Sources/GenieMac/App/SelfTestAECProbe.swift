import AVFoundation

extension SelfTest {
    /// `--selftest aecprobe`: 再生と録音を 1 つの engine にまとめ、エコー除去（voice processing）が
    /// (a) 外の声（別のアプリが鳴らす `say`）を通すか、(b) 自分で鳴らした声を消すか、を最大振幅で測る。
    @MainActor static func aecProbe() async {
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP aecprobe: mic not granted"); exit(0) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("aecprobe.aiff")
        let say = Process(); say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", "Kyoko", "-o", tmp.path, "東京の明日の天気は、午前中は晴れで、午後から雨になるでしょう。"]
        try? say.run(); say.waitUntilExit()
        guard let file = try? AVAudioFile(forReading: tmp) else { print("SELFTEST_FAIL aecprobe: no audio"); exit(2) }

        for aec in [false, true] {
            setvbuf(stdout, nil, _IONBF, 0)
            let engine = AVAudioEngine()
            // 再生をつないでから voice processing を有効にする（逆の順だと出力の初期化が -10875 で失敗するか固まる）。
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
            let input = engine.inputNode
            do { try input.setVoiceProcessingEnabled(aec) } catch { print("voice processing \(aec) failed: \(error)") }
            let lock = NSLock(); var peak: Float = 0
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buf, _ in
                guard let ch = buf.floatChannelData else { return }
                var m: Float = 0
                for i in 0..<Int(buf.frameLength) { m = max(m, abs(ch[0][i])) }
                lock.lock(); peak = max(peak, m); lock.unlock()
            }
            do { try engine.start() } catch { print("engine start failed (aec=\(aec)): \(error)"); continue }
            func measure(_ label: String, _ body: () async -> Void) async {
                try? await Task.sleep(nanoseconds: 500_000_000)
                lock.lock(); peak = 0; lock.unlock()
                await body()
                lock.lock(); let p = peak; lock.unlock()
                print(String(format: "aec=%@ %@: peak %.3f", aec ? "on " : "off", label, p))
            }
            await measure("quiet") { try? await Task.sleep(nanoseconds: 1_500_000_000) }
            await measure("other app voice (say)") {
                let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/afplay"); p.arguments = [tmp.path]
                try? p.run(); while p.isRunning { try? await Task.sleep(nanoseconds: 100_000_000) }
            }
            await measure("own playback") {
                player.scheduleFile(file, at: nil, completionHandler: nil); player.play()
                let seconds = Double(file.length) / file.processingFormat.sampleRate
                try? await Task.sleep(nanoseconds: UInt64((seconds + 0.3) * 1_000_000_000))
            }
            input.removeTap(onBus: 0); engine.stop()
        }
        print("SELFTEST_OK aecprobe")
        exit(0)
    }
}
