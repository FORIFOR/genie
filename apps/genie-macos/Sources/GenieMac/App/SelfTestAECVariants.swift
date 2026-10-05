import AVFoundation

extension SelfTest {
    /// `--selftest aecvariants <name>`: voice processing の engine に再生を足す組み立て方を 1 つ試す（固まる組み立てがあるので 1 回 1 つ）。
    @MainActor static func aecVariants(_ args: [String]) async {
        setvbuf(stdout, nil, _IONBF, 0)
        let name = args.last ?? ""
        let e = AVAudioEngine()
        let p = AVAudioPlayerNode()
        do {
            switch name {
            case "connectFirst":     // 再生をつないでから VP
                e.attach(p); e.connect(p, to: e.mainMixerNode, format: AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1))
                try e.inputNode.setVoiceProcessingEnabled(true)
            case "mixerNil":         // VP の後、形式を指定せずにつなぐ
                try e.inputNode.setVoiceProcessingEnabled(true)
                e.attach(p); e.connect(p, to: e.mainMixerNode, format: nil)
            case "toOutput":         // ミキサーを通さず出力へ
                try e.inputNode.setVoiceProcessingEnabled(true)
                e.attach(p); e.connect(p, to: e.outputNode, format: e.outputNode.inputFormat(forBus: 0))
            case "mono24k":          // VP の後、24 kHz mono でミキサーへ
                try e.inputNode.setVoiceProcessingEnabled(true)
                e.attach(p); e.connect(p, to: e.mainMixerNode, format: AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1))
            default: print("unknown"); exit(2)
            }
            print("\(name): built (out \(e.outputNode.outputFormat(forBus: 0)), in \(e.inputNode.outputFormat(forBus: 0)))")
            try e.start()
            print("\(name): started")
            let buf = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!, frameCapacity: 2400)!
            buf.frameLength = 2400
            if name != "toOutput" { p.scheduleBuffer(buf, completionHandler: nil); p.play(); print("\(name): playing") }
            try? await Task.sleep(nanoseconds: 500_000_000)
            e.stop()
            print("SELFTEST_OK aecvariants \(name)")
        } catch { print("SELFTEST_FAIL aecvariants \(name): \(error)") }
        exit(0)
    }
}
