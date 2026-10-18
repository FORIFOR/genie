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
        var maxLevel: Float = 0
        let levelWatch = Task { @MainActor in
            while !Task.isCancelled { maxLevel = max(maxLevel, hud.inputLevel); try? await Task.sleep(nanoseconds: 50_000_000) }
        }
        defer { levelWatch.cancel() }
        var results: [(String, Bool)] = []
        // 引数で場面を選べる（S1 と終了はいつも通す）。無ければすべて。
        let only = Set((args.firstIndex(of: "liveflow").map { Array(args[($0 + 1)...]) } ?? [])
            .map { $0.uppercased() }.filter { $0.range(of: #"^S\d+$"#, options: .regularExpression) != nil })
        func want(_ id: String) -> Bool { only.isEmpty || only.contains(id) }
        func reports() -> Int { (hud.conversationProvider as? GeminiLiveProvider)?.reports.count ?? 0 }
        let failureWords = ["できません", "できませんでし", "見つけ", "申し訳"]
        try? await Task.sleep(nanoseconds: 2_500_000_000)   // 検出の窓が満ちるまで静けさ

        // S1 名前だけで呼ぶ
        geminiText = ""
        await say("ジーニー")
        let s1a = await wait(6, "S1 呼びかけで会話が始まる") { hud.conversation.isActive }
        let s1b = await wait(15, "S1 「どうされましたか」と返す") { geminiText.contains("どうされ") || geminiText.contains("何でしょう") || geminiText.contains("ご用件") }
        note("Gemini: \(geminiText.prefix(80))")
        results.append(("S1 名前だけで呼ぶ", s1a && s1b))

        // S2 近くの店
        if want("S2") {
        geminiText = ""
        await say("近くのマクドナルドを調べて")
        let s2a = await wait(25, "S2 地図のカードが出る") {
            if case .card = hud.mode { return true }; return false
        }
        let s2b = await wait(25, "S2 Gemini が結果を伝える") { geminiText.contains("件") || geminiText.contains("マクドナルド") || geminiText.contains("見つ") }
        note("聞き取り: \(userText.prefix(40)) / Gemini: \(geminiText.prefix(100))")
        results.append(("S2 近くのマクドナルド", s2a && s2b))
        }

        // S3 公式サイトを Safari で
        if want("S3") {
        geminiText = ""
        let before = reports()
        await say("マクドナルドの公式サイトをサファリで開いて")
        // 合格: Genie が「開いた結果」を Gemini に戻し、その後に Gemini が「開いた・表示した」と伝え、失敗の言い方が無い。
        let reported = await wait(120, "S3 仕事の結果が会話に戻る") { reports() > before }
        let mark = geminiText.count
        try? await Task.sleep(nanoseconds: 8_000_000_000)
        let after = String(geminiText.dropFirst(mark))
        note("報告後の Gemini: \(after.prefix(120))")
        let s3 = reported && (after.contains("開き") || after.contains("表示"))
            && !failureWords.contains(where: { after.contains($0) })
        note("聞き取り: \(userText.prefix(40)) / Gemini: \(geminiText.prefix(120))")
        results.append(("S3 公式サイトを Safari で", s3))
        }

        // S5 書類の案: 見積り・提案書・スライドを 120 台に合わせる（案件は scripts/liveflow.sh が書類フォルダに用意する）
        if want("S5") {
        geminiText = ""
        let before = reports()
        await say("端末を120台にしたら、提案書とスライドも合わせた案を作って")
        // 合格: 端末が確かめた結果（確認すべて合格）が会話へ戻り、Gemini が案を作ったと伝え、失敗の言い方が無い。
        let reported = await wait(150, "S5 仕事の結果が会話に戻る") { reports() > before }
        let report = (hud.conversationProvider as? GeminiLiveProvider)?.reports.last ?? ""
        note("報告: \(report.prefix(160))")
        let mark = geminiText.count
        try? await Task.sleep(nanoseconds: 8_000_000_000)
        let after = String(geminiText.dropFirst(mark))
        note("報告後の Gemini: \(after.prefix(120))")
        let s5 = reported && report.contains("120にした案を作りました") && report.contains("すべて合格")
            && !report.contains("合いませんでした") && !report.contains("直していません")
            && (after.contains("案") || after.contains("合わせ") || after.contains("作り"))
            && !failureWords.contains(where: { after.contains($0) })
        note("聞き取り: \(userText.prefix(50))")
        results.append(("S5 書類の案（120台）", s5))
        }

        // S6 今日のまとめ: 「今日どう？」で get_today_brief を呼び、まとめのカードが出て、会話へは件数・状態だけが戻る
        if want("S6") {
        geminiText = ""
        func briefCalls() -> Int { (hud.conversationProvider as? GeminiLiveProvider)?.trace.filter { $0.1 == "today-brief" }.count ?? 0 }
        let calls = briefCalls()
        await say("今日どう？")
        let called = await wait(20, "S6 get_today_brief が呼ばれる") { briefCalls() > calls }
        let shown = await wait(60, "S6 今日のまとめのカードが出る") {
            if case .card(.brief) = hud.mode { return true }; return false
        }
        try? await Task.sleep(nanoseconds: 8_000_000_000)
        let card = BriefStore.shared.today()
        note("まとめ: \(card.map { $0.sections.map { "\($0.id)=\($0.status)" }.joined(separator: " ") } ?? "なし")")
        note("Gemini: \(geminiText.prefix(160))")
        // 会話へは題名・件名を渡していない（予定の題名が Gemini の発話に出ない）
        let titles = card?.sections.first { $0.id == "calendar" }?.lines.map(\.text) ?? []
        let leaked = titles.contains { line in line.split(separator: " ").dropFirst().joined(separator: " ").count >= 4 && geminiText.contains(line.split(separator: " ").dropFirst().joined(separator: " ")) }
        let s6 = called && shown && card != nil && !leaked
            && (geminiText.contains("予定") || geminiText.contains("天気") || geminiText.contains("まとめ"))
            && !failureWords.contains(where: { geminiText.contains($0) })
        results.append(("S6 今日どう？（今日のまとめ）", s6))
        }

        // S7〜S10 いまの情報: show_info が呼ばれ、専用カード（info）が出て、Google 検索の声だけで済ませない。
        func infoCalls() -> Int { (hud.conversationProvider as? GeminiLiveProvider)?.trace.filter { $0.1 == "info" }.count ?? 0 }
        func infoCard(_ kind: InfoCard.Kind) -> InfoCard? {
            if case .card(.info(let card)) = hud.mode, card.kind == kind { return card }; return nil
        }
        func infoScene(_ id: String, _ name: String, _ phrase: String, _ kind: InfoCard.Kind,
                       check: (InfoCard) -> Bool) async {
            guard want(id) else { return }
            geminiText = ""
            let calls = infoCalls()
            await say(phrase)
            let called = await wait(25, "\(id) show_info が呼ばれる") { infoCalls() > calls }
            let shown = await wait(30, "\(id) \(kind.rawValue) のカードが出る") { infoCard(kind) != nil }
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            let card = infoCard(kind)
            note("カード: \(card?.text.prefix(140) ?? "なし")")
            note("聞き取り: \(userText.prefix(40)) / Gemini: \(geminiText.prefix(140))")
            let ok = called && shown && card.map(check) == true
                && !geminiText.contains("どちらの") && !failureWords.contains(where: { geminiText.contains($0) })
            results.append(("\(id) \(name)", ok))
        }
        await infoScene("S7", "今日のニュース", "今日のニュースを教えて", .news) { ($0.news?.items.count ?? 0) >= 3 }
        await infoScene("S8", "日経平均", "日経平均はいくら？", .markets) {
            $0.markets?.quotes.contains { $0.symbol == "^N225" } == true
        }
        await infoScene("S9", "トヨタの株価", "トヨタの株価を教えて", .markets) {
            $0.markets?.quotes.contains { $0.symbol == "7203.T" } == true
        }
        // 場所を言わない → 端末の現在地（または設定の地域）。場所を聞き返さない。
        await infoScene("S10", "今日の天気（場所を言わない）", "今日の天気は？", .weather) {
            $0.weather?.days.isEmpty == false
        }

        // S11 「近くのマック」→ マクドナルドの店舗（事務所でない）
        if want("S11") {
        geminiText = ""
        await say("近くのマックを探して")
        let shown = await wait(30, "S11 地図のカードが出る") {
            if case .card(.places) = hud.mode { return true }; return false
        }
        var names: [String] = []
        if case .card(.places(let card)) = hud.mode { names = card.places.map(\.name) }
        note("店: \(names.prefix(5).joined(separator: " / "))")
        let s11 = shown && !names.isEmpty && names.allSatisfy { $0.contains("マクドナルド") || $0.contains("McDonald") }
            && !names.contains { $0.contains("本社") || $0.contains("事務所") || $0.contains("営業所") }
        results.append(("S11 近くのマック", s11))
        }

        // S12 注文の続き（2026-10-16 の失敗の再現）: 商品 → 数量 → 時刻 の順に進み、「手段がない」と言わない。
        // 準備（公式サイトを開く）の手前で止め、下書きは「やめて」で片づける。
        if want("S12") {
        try? await Task.sleep(nanoseconds: 8_000_000_000)   // 前の場面の Gemini の発話が終わるまで待つ
        geminiText = ""
        func lastReport() -> String { (hud.conversationProvider as? GeminiLiveProvider)?.reports.last ?? "" }
        var steps: [Bool] = []
        // 言い方は 2026-10-16 朝に本人が実際に言ったもの（「マクドナルドで注文したい」は合成音声だと「で注文」が欠けた）。
        for (phrase, expect) in [("マクドナルド注文して", "商品名と数量"),
                                 ("チーズバーガーのMセットを注文して", "数量を教えて"),
                                 ("ひとつ", "いつ届けたいですか")] {
            let before = reports()
            await say(phrase)
            // 黙って待ちすぎると会話が「無言」で閉じる（約 45 秒）。答えはふつう 15 秒以内に戻る。
            let got = await wait(30, "S12 「\(phrase)」に Genie が答える") { reports() > before }
            note("報告: \(lastReport().prefix(120)) / 聞き取り: \(userText.prefix(40))")
            let marks = (hud.conversationProvider as? GeminiLiveProvider)?.trace.suffix(8).map(\.1).joined(separator: ",") ?? ""
            note("足跡: \(marks)")
            if let g = hud.conversationProvider as? GeminiLiveProvider {
                note("送った音 \(g.lane.sentFrames) / 送らなかった音 \(g.lane.droppedFrames) / 会話の段 \(hud.conversation.phase)")
            }
            steps.append(got && lastReport().contains(expect))
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
        note("Gemini: \(geminiText.suffix(200))")
        let s12 = steps.allSatisfy { $0 } && !geminiText.contains("手段がない") && !geminiText.contains("手段はない")
        let before = reports()
        await say("注文をやめて")
        _ = await wait(30, "S12 下書きを片づける") { reports() > before }
        note("報告: \(lastReport().prefix(120))")
        results.append(("S12 マクドナルドの注文（商品→数量→時刻）", s12))
        }

        // S13 声が届いていることが画面で分かる（会話中のマイクの音量が波形へ届いた）
        note(String(format: "入力の波形: 最大 %.2f", maxLevel))
        results.append(("S13 声の大きさが会話の波形に届く", maxLevel > 0.1))

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
