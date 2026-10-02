import XCTest
@testable import GenieMac

/// 段階 4: Gemini Live の送受信の形と、上限・同意の扱い。通信はしない（キーが無くても確かめられる部分）。
final class GeminiLiveTests: XCTestCase {
    private func object(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
    }

    func testSetupAsksForAudioWithTranscriptsSearchAndOnlyTheDelegateFunction() {
        let setup = object(GeminiLive.json(GeminiLive.setup(instruction: "短く")))["setup"] as? [String: Any]
        XCTAssertEqual(setup?["model"] as? String, "models/gemini-3.8-live")
        XCTAssertEqual((setup?["generationConfig"] as? [String: Any])?["responseModalities"] as? [String], ["AUDIO"])
        XCTAssertNotNil(setup?["inputAudioTranscription"])
        XCTAssertNotNil(setup?["outputAudioTranscription"])
        let tools = setup?["tools"] as? [[String: Any]] ?? []
        XCTAssertEqual(tools.flatMap { $0.keys }.sorted(), ["functionDeclarations", "googleSearch"], "道具は Google 検索と、仕事を渡す関数だけ")
        let functions = tools.compactMap { $0["functionDeclarations"] as? [[String: Any]] }.flatMap { $0 }
        XCTAssertEqual(functions.map { $0["name"] as? String }, ["delegate_task"], "関数は仕事を渡す 1 つだけ")
    }

    func testQuotaAndKeyClosuresAreExplainedInsteadOfRetried() {
        XCTAssertTrue(GeminiLive.fatalCloseMessage(code: 1011, reason: "You exceeded your current quota, please check your plan and billing details.")?.contains("利用枠") == true)
        XCTAssertTrue(GeminiLive.fatalCloseMessage(code: 1008, reason: "API key not valid.")?.contains("API キー") == true)
        XCTAssertTrue(GeminiLive.fatalCloseMessage(code: 1011, reason: "Your prepayment credits are depleted. Please go to AI Studio")?.contains("前払いクレジット") == true)
        XCTAssertNil(GeminiLive.fatalCloseMessage(code: 1001, reason: nil), "回線の切断はつなぎ直す")
        XCTAssertNil(GeminiLive.fatalCloseMessage(code: 1011, reason: "Internal error"), "一時的な内部エラーはつなぎ直す")
    }

    func testAudioIsSixteenBitLittleEndianPCMAtSixteenKilohertz() throws {
        let chunk = object(GeminiLive.json(GeminiLive.audioChunk([0, 1, -1, 2])))
        let audio = (chunk["realtimeInput"] as? [String: Any])?["audio"] as? [String: Any]
        XCTAssertEqual(audio?["mimeType"] as? String, "audio/pcm;rate=16000")
        let data = try XCTUnwrap(Data(base64Encoded: audio?["data"] as? String ?? ""))
        XCTAssertEqual([UInt8](data), [0x00, 0x00, 0xFF, 0x7F, 0x01, 0x80, 0xFF, 0x7F], "0, +max, -max, 範囲外は丸める")
    }

    func testServerMessagesBecomeEvents() {
        let pcm = Data([0x00, 0x10, 0x00, 0xF0]).base64EncodedString()
        let events = GeminiLive.parse("""
        {"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"\(pcm)"}}]},
         "inputTranscription":{"text":"明日の天気"},"outputTranscription":{"text":"雨です"},"turnComplete":true},
         "usageMetadata":{"totalTokenCount":42}}
        """)
        XCTAssertEqual(events, [
            .audio(Data([0x00, 0x10, 0x00, 0xF0]), sampleRate: 24_000),
            .inputTranscript("明日の天気"), .outputTranscript("雨です"), .turnComplete, .usage(totalTokens: 42),
        ])
        XCTAssertEqual(GeminiLive.parse(#"{"setupComplete":{}}"#), [.setupComplete])
        XCTAssertEqual(GeminiLive.parse(#"{"toolCall":{"functionCalls":[{"id":"c1","name":"delegate_task","args":{"request":"資料を直して"}}]}}"#),
                       [.toolCall(id: "c1", name: "delegate_task", request: "資料を直して")])
        XCTAssertEqual(GeminiLive.parse(#"{"goAway":{"timeLeft":"5s"}}"#), [.goAway(timeLeft: "5s")])
        XCTAssertEqual(GeminiLive.parse(#"{"sessionResumptionUpdate":{"newHandle":"h1","resumable":true}}"#),
                       [.resumption(handle: "h1", resumable: true)])
        XCTAssertEqual(GeminiLive.parse(#"{"sessionResumptionUpdate":{"newHandle":"h2","resumable":false}}"#),
                       [.resumption(handle: "h2", resumable: false)])
        XCTAssertEqual(GeminiLive.parse(#"{"serverContent":{"interrupted":true}}"#), [.interrupted])
        XCTAssertEqual(GeminiLive.parse("not json"), [])
    }

    func testToolResponseCarriesOnlyTheStatus() {
        let r = object(GeminiLive.json(GeminiLive.toolResponse(id: "c1", name: "delegate_task", response: ["status": "accepted"])))
        let f = ((r["toolResponse"] as? [String: Any])?["functionResponses"] as? [[String: Any]])?.first
        XCTAssertEqual(f?["id"] as? String, "c1")
        XCTAssertEqual(f?["response"] as? [String: String], ["status": "accepted", "scheduling": "WHEN_IDLE"],
                       "受付は話の途中に割り込ませず、区切りで伝える（scheduling は response の中）")
    }

    /// 3.8 Live で送ってはいけない設定を入れない（proactive audio は常に有効で false はエラー。言語は指示で決める）。
    func testSetupFollowsTheThreePointEightRules() {
        let json = GeminiLive.json(GeminiLive.setup(instruction: "短く"))
        for forbidden in ["thinkingConfig", "thinking_level", "thinkingLevel", "enableAffectiveDialog", "proactivity",
                          "proactiveAudio", "languageCode"] {
            XCTAssertFalse(json.contains(forbidden), "\(forbidden) を送っている")
        }
        let setup = object(json)["setup"] as? [String: Any]
        let input = setup?["realtimeInputConfig"] as? [String: Any]
        XCTAssertEqual(input?["activityHandling"] as? String, "START_OF_ACTIVITY_INTERRUPTS", "話し始めたら出力を止める")
        let vad = input?["automaticActivityDetection"] as? [String: Any]
        XCTAssertEqual(vad?["disabled"] as? Bool, false, "区切りはサーバーの自動判定に任せる")
        let silence = vad?["silenceDurationMs"] as? Int ?? 0
        XCTAssertTrue((500...800).contains(silence), "話し終わりの判定は公式の推奨 500〜800ms の中（\(silence)）")
        XCTAssertNotNil(setup?["contextWindowCompression"], "長い会話は履歴を圧縮する")
        XCTAssertNotNil(setup?["sessionResumption"], "接続が切れても同じ会話へ戻れる")
        let tool = (setup?["tools"] as? [[String: Any]])?.compactMap { $0["functionDeclarations"] as? [[String: Any]] }.first?.first
        XCTAssertEqual(tool?["behavior"] as? String, "NON_BLOCKING", "仕事の完了を待たずに会話を続ける")
        XCTAssertTrue(GeminiLiveProvider.instruction.contains("日本語"), "言語は指示で決める")
        let voice = (((setup?["generationConfig"] as? [String: Any])?["speechConfig"] as? [String: Any])?["voiceConfig"] as? [String: Any])?["prebuiltVoiceConfig"] as? [String: Any]
        XCTAssertEqual(voice?["voiceName"] as? String, "Kore", "声は本人の指定どおり Kore")
        XCTAssertTrue(GeminiLiveProvider.instruction.contains("丁寧な言葉づかい"), "丁寧な受け答え")
        XCTAssertTrue(GeminiLiveProvider.instruction.contains("Google 検索で調べて"), "公開情報は検索して声で伝える")
        XCTAssertTrue(GeminiLiveProvider.instruction.contains("断らずに"), "注文・予約は断らずに Genie へ渡す（確定の前に Genie が本人に確認する）")
        XCTAssertFalse(GeminiLiveProvider.instruction.contains("許可されるまで実行しないでください"), "承認は Genie の確認カードが受け持つ。Gemini に断らせない")
    }

    func testResumeHandleIsSentOnlyWhenGiven() {
        let fresh = (object(GeminiLive.json(GeminiLive.setup(instruction: "x")))["setup"] as? [String: Any])?["sessionResumption"] as? [String: Any]
        XCTAssertNil(fresh?["handle"])
        let resumed = (object(GeminiLive.json(GeminiLive.setup(instruction: "x", resumeHandle: "h1")))["setup"] as? [String: Any])?["sessionResumption"] as? [String: Any]
        XCTAssertEqual(resumed?["handle"] as? String, "h1")
    }

    func testPlaybackConvertsLittleEndianPCM() {
        XCTAssertEqual(GeminiLiveProvider.floats(from: Data([0xFF, 0x7F, 0x00, 0x00])), [1, 0])
    }

    func testBudgetMustBeSetAndIsEnforcedPerMonth() {
        let sep = Date(timeIntervalSince1970: 1_790_000_000) // 2026-09
        var budget = GeminiLiveBudget(monthlyMinutes: 0, usedSeconds: 0, month: "")
        XCTAssertFalse(budget.canStart(at: sep).ok, "上限を決めるまで使えない")
        budget.monthlyMinutes = 10
        XCTAssertTrue(budget.canStart(at: sep).ok)
        budget.record(seconds: 540, at: sep)
        XCTAssertEqual(budget.remainingSeconds(at: sep), 60)
        budget.record(seconds: 120, at: sep)
        XCTAssertFalse(budget.canStart(at: sep).ok, "使い切ったら始めない")
        XCTAssertEqual(budget.remainingSeconds(at: sep), 0)
        let oct = sep.addingTimeInterval(40 * 86_400)
        XCTAssertTrue(budget.canStart(at: oct).ok, "月が変われば 0 から")
        XCTAssertEqual(budget.remainingSeconds(at: oct), 600)
    }

    @MainActor
    func testGeminiIsActiveOnlyWithConsentKeyAndLimit() {
        let suite = "genie.gemini.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        for hasKey in [false, true] {
            let settings = GeminiLiveSettings(defaults: defaults, initialHasKey: hasKey)
            XCTAssertFalse(settings.active, "本人がオンにするまでは使わない")
            settings.setEnabled(true)
            settings.setMonthlyMinutes(30)
            XCTAssertEqual(settings.active, hasKey, "同意・上限があってもキーが無ければ使わない")
            settings.setMonthlyMinutes(0)
            XCTAssertFalse(settings.active, "上限が無ければ使わない")
            settings.setMonthlyMinutes(30)
            settings.setEnabled(false)
            XCTAssertFalse(settings.active, "本人がオンにしていなければ使わない")
        }
    }
}
