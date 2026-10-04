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
                let detector = try LiveKitWakeDetector(modelURL: model)
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
                print("\(fired ? "WAKE" : "----") \(URL(fileURLWithPath: path).lastPathComponent)")
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
}
