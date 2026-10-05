import AppKit

/// `--selftest liveflow [scenario...]`: **本物の Gemini Live** で、人が話すのと同じ流れを通す。
/// 声は合成（say）で作り、実マイクの代わりに 0.1 秒ずつ実時間で流し込む。Gemini の声はスピーカーへ出さない。
/// 呼びかけは本物のモデル（genie_ja.onnx）で検出し、会話・道具・仕事・報告・終了を確かめる。
/// 実行: ASTRA_GATEWAY_URL・ASTRA_DESKTOP_IDENTITY でアプリと同じサービス・利用者に、ASTRA_DATA_ROOT で
/// 動いているアプリとは別の保存先に（同じ DB を同時に書かない）。scripts/liveflow.sh が組み立てる。
extension SelfTest {
    @MainActor static func liveFlow(_ args: [String]) async {
        setvbuf(stdout, nil, _IONBF, 0)
        NSApp.setActivationPolicy(.accessory)
        let hub = VoiceInputHub(mic: nil)
        hub.simulatedPlayback = true   // 本番と同じ全二重（話している間も聞く）
        _ = LocalStore.shared.open()   // 本番のアプリは起動時に開く（検査の実行では開かれていない）
        // Genie のサービスへつなぐ（頼んだ仕事を実行するため。本番のアプリは起動時につなぐ）。
        MainData.shared.load()
        for _ in 0..<60 where !MainData.shared.connected { try? await Task.sleep(nanoseconds: 250_000_000) }
        print("backend connected: \(MainData.shared.connected) via \(ProcessInfo.processInfo.environment["ASTRA_GATEWAY_URL"] ?? "default")")
        var log: [(Double, String)] = []
        let t0 = Date()
        func note(_ s: String) { let t = Date().timeIntervalSince(t0); log.append((t, s)); print(String(format: "%6.1fs %@", t, s)) }
        var userText = "", geminiText = ""
        VoiceHUDState.liveTestInput = hub
        VoiceHUDState.liveTestSilent = true
        VoiceHUDState.liveTestTranscripts = { text, user in
            if user { userText += text } else { geminiText += text }
        }
        guard let url = LiveKitWakeDetector.modelURL(), let detector = try? LiveKitWakeDetector(modelURL: url) else {
            print("SELFTEST_FAIL liveflow: wake model"); exit(2)
        }
        let wake = WakeController(hub: hub)
        try? wake.armForTest(detector: detector)

        // 実時間で流す（話す声 → 無ければ静けさ）。
        var queue: [[Float]] = []
        let feeder = Task.detached {
            while !Task.isCancelled {
                let frame: [Float] = await MainActor.run { queue.isEmpty ? (0..<1600).map { _ in Float.random(in: -0.0005...0.0005) } : queue.removeFirst() }
                hub.inject(frame)
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        func say(_ text: String) async {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("liveflow-\(abs(text.hashValue)).aiff")
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
            p.arguments = ["-v", "Kyoko", "-o", file.path, text]
            try? p.run(); p.waitUntilExit()
            guard let samples = loadMono16k(file.path) else { note("audio failed: \(text)"); return }
            var frames: [[Float]] = []
            var i = 0
            while i < samples.count { frames.append(Array(samples[i..<min(samples.count, i + 1600)])); i += 1600 }
            note("👤 \(text)")
            userText = ""
            queue.append(contentsOf: frames)
            while !queue.isEmpty { try? await Task.sleep(nanoseconds: 100_000_000) }
        }
        func wait(_ seconds: Double, _ label: String, until ok: () -> Bool) async -> Bool {
            let end = Date().addingTimeInterval(seconds)
            while Date() < end { if ok() { note("✓ \(label)"); return true }; try? await Task.sleep(nanoseconds: 200_000_000) }
            note("✗ \(label)"); return false
        }
        let hud = VoiceHUDState.shared
        var results: [(String, Bool)] = []
        try? await Task.sleep(nanoseconds: 2_500_000_000)   // 検出の窓が満ちるまで静けさ

        // S1 名前だけで呼ぶ
        geminiText = ""
        await say("ジーニー")
        let s1a = await wait(6, "S1 呼びかけで会話が始まる") { hud.conversation.isActive }
        let s1b = await wait(15, "S1 「どうされましたか」と返す") { geminiText.contains("どうされ") || geminiText.contains("何でしょう") || geminiText.contains("ご用件") }
        note("Gemini: \(geminiText.prefix(80))")
        results.append(("S1 名前だけで呼ぶ", s1a && s1b))

        // S2 近くの店
        geminiText = ""
        await say("近くのマクドナルドを調べて")
        let s2a = await wait(25, "S2 地図のカードが出る") {
            if case .card = hud.mode { return true }; return false
        }
        let s2b = await wait(25, "S2 Gemini が結果を伝える") { geminiText.contains("件") || geminiText.contains("マクドナルド") || geminiText.contains("見つ") }
        note("聞き取り: \(userText.prefix(40)) / Gemini: \(geminiText.prefix(100))")
        results.append(("S2 近くのマクドナルド", s2a && s2b))

        // S3 公式サイトを Safari で
        geminiText = ""
        await say("マクドナルドの公式サイトをサファリで開いて")
        func reports() -> Int { (hud.conversationProvider as? GeminiLiveProvider)?.trace.filter { $0.1 == "reported" }.count ?? 0 }
        let before = reports()
        // 合格: Genie が「開いた結果」を Gemini に戻し、その後に Gemini が「開いた・表示した」と伝え、失敗の言い方が無い。
        let reported = await wait(120, "S3 仕事の結果が会話に戻る") { reports() > before }
        let mark = geminiText.count
        try? await Task.sleep(nanoseconds: 8_000_000_000)
        let after = String(geminiText.dropFirst(mark))
        note("報告後の Gemini: \(after.prefix(120))")
        let s3 = reported && (after.contains("開き") || after.contains("表示"))
            && !["できません", "できませんでし", "見つけ", "申し訳"].contains(where: { after.contains($0) })
        note("聞き取り: \(userText.prefix(40)) / Gemini: \(geminiText.prefix(120))")
        results.append(("S3 公式サイトを Safari で", s3))

        // S4 終了
        await say("終了して")
        let s4 = await wait(10, "S4 会話が閉じる") { !hud.conversation.isActive }
        results.append(("S4 終了して", s4))

        feeder.cancel()
        hud.endConversation(.user)
        print("---")
        for (name, ok) in results { print("\(ok ? "PASS" : "FAIL") \(name)") }
        let allOK = results.allSatisfy(\.1)
        print((allOK ? "SELFTEST_OK" : "SELFTEST_FAIL") + " liveflow: \(results.filter(\.1).count)/\(results.count)")
        exit(allOK ? 0 : 2)
    }
}
