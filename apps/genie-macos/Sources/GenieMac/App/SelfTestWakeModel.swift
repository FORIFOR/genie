import AVFoundation
import LiveKitWakeWord

extension SelfTest {
    /// `--selftest wakemodel <model.onnx> <wav...>`: 音声ファイルを 0.1 秒ずつ検出器に流し、起きたか・最高点を出す。
    /// マイクも外部送信も使わない。学習側（Python）と同じ判定になるかを確かめる。
    @MainActor static func wakeModel(_ args: [String]) async {
        guard let i = args.firstIndex(of: "wakemodel"), args.count > i + 2 else {
            print("SELFTEST_FAIL wakemodel: usage <model.onnx> <wav...>"); exit(2)
        }
        let model = URL(fileURLWithPath: args[i + 1])
        var woke = 0, total = 0
        for path in args[(i + 2)...] {
            guard let frames = loadMono16k(path) else { print("skip \(path)"); continue }
            do {
                let env = ProcessInfo.processInfo.environment
                let detector = try LiveKitWakeDetector(modelURL: model,
                    threshold: Float(env["WAKE_THRESHOLD"] ?? "") ?? 0.95, hits: Int(env["WAKE_HITS"] ?? "") ?? 2)
                // 本人の覚えた呼びかけは使わない（検査を端末の状態に左右させない）。比べるときは WAKE_VOICEPRINT で渡す。
                detector.voicePrint = env["WAKE_VOICEPRINT"].flatMap { WakeVoicePrint.load(from: URL(fileURLWithPath: $0)) }
                detector.speakerPrint = env["WAKE_SPEAKER"].flatMap { SpeakerPrint.load(from: URL(fileURLWithPath: $0)) }
                if let path = env["WAKE_SPEAKER_MODEL"] { detector.speakerEncoder = try? SpeakerEncoder(modelURL: URL(fileURLWithPath: path)) }
                if env["WAKE_TRACE"] != nil {
                    detector.onScore = { t, score in if score >= 0.3 { print(String(format: "  %.1fs %.2f", t, score)) } }
                }
                // 前に 2 秒の無音を置く（窓が満ちてから評価が始まる）。後ろにも 1 秒。
                let padded = [Float](repeating: 0, count: 32_000) + frames + [Float](repeating: 0, count: 16_000)
                var fired = false
                var start = 0
                while start < padded.count {
                    let end = min(padded.count, start + 1_600)
                    if detector.process(Array(padded[start..<end])) { fired = true }
                    start = end
                }
                total += 1; if fired { woke += 1 }
                print("\(fired ? "WAKE" : "----") \(URL(fileURLWithPath: path).lastPathComponent)\(fired ? " " + (detector.lastWake ?? "") : "")")
            } catch {
                print("SELFTEST_FAIL wakemodel: \(error)"); exit(2)
            }
        }
        // 1 回の評価にかかる時間（実行の仕組みごと）。
        for (name, provider) in [("cpu", ExecutionProvider.cpu), ("coreML", .coreML), ("coreMLCPUAndGPU", .coreMLCPUAndGPU)] {
            if let m = try? WakeWordModel(models: [model], sampleRate: 16_000, executionProvider: provider) {
                let audio = (0..<32_000).map { _ in Int16.random(in: -3000...3000) }
                _ = try? m.predict(audio)
                let t0 = Date()
                for _ in 0..<20 { _ = try? m.predict(audio) }
                print(String(format: "timing %@: %.1f ms per evaluation", name, Date().timeIntervalSince(t0) / 20 * 1000))
            }
        }
        print("SELFTEST_OK wakemodel: woke=\(woke)/\(total)")
        exit(0)
    }

    /// `--selftest voiceprint <enroll.wav> <out.json>`: 「声を覚える」の録音から、アプリと同じ手順で呼びかけを覚える。
    /// 本人の保存先には書かない。結果は `wakemodel` に WAKE_VOICEPRINT で渡して確かめる。
    static func voicePrint(_ args: [String]) {
        guard let i = args.firstIndex(of: "voiceprint"), args.count > i + 2,
              let audio = loadMono16k(args[i + 1]) else {
            print("SELFTEST_FAIL voiceprint: usage <enroll.wav> <out.json>"); exit(2)
        }
        let out = URL(fileURLWithPath: args[i + 2])
        // 前の比べ方（8 回の録音）。今の「声を覚える」は speaker で確かめる。
        guard let learned = WakeEnrollment.learn(audio, count: Int(ProcessInfo.processInfo.environment["WAKE_CALLS"] ?? "") ?? 8, saveTo: out) else {
            print("SELFTEST_FAIL voiceprint: too few usable calls"); exit(1)
        }
        print(String(format: "SELFTEST_OK voiceprint %d calls, match needs %.2f → %@", learned.templates.count, learned.threshold, out.path))
        exit(0)
    }

    /// `--selftest speaker <model.onnx> <enroll.wav> <count> <out.json> [wav...]`: 「声を覚える」の録音から、アプリと
    /// 同じ手順で本人の声を覚え、続くファイルそれぞれとの似かたを出す。本人の保存先には書かない。
    static func speaker(_ args: [String]) {
        guard let i = args.firstIndex(of: "speaker"), args.count > i + 4,
              let encoder = try? SpeakerEncoder(modelURL: URL(fileURLWithPath: args[i + 1])),
              let audio = loadMono16k(args[i + 2]), let count = Int(args[i + 3]) else {
            print("SELFTEST_FAIL speaker: usage <model.onnx> <enroll.wav> <count> <out.json> [wav...]"); exit(2)
        }
        guard let learned = WakeEnrollment.learnSpeaker(audio, count: count, encoder: encoder,
                                                        saveTo: URL(fileURLWithPath: args[i + 4])) else {
            print("SELFTEST_FAIL speaker: no usable call"); exit(1)
        }
        var passed = 0, total = 0
        for path in args.dropFirst(i + 5) {
            guard let frames = loadMono16k(path), let e = encoder.embedding(of: frames) else { print("skip \(path)"); continue }
            let s = learned.similarity(e)
            total += 1; if s >= SpeakerPrint.threshold { passed += 1 }
            print(String(format: "%@ %.3f %@", s >= SpeakerPrint.threshold ? "PASS" : "----", s, URL(fileURLWithPath: path).lastPathComponent))
        }
        print("SELFTEST_OK speaker: learned \(learned.calls) calls, passed=\(passed)/\(total)")
        exit(0)
    }
}
