import XCTest
@testable import GenieMac

/// 段階 2: 「Genie と会話」の一連の遷移を、マイク・読み上げ・依頼の実物なしで確かめる。
final class ConversationLoopTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func started() -> (ConversationLoop, Int) {
        var loop = ConversationLoop()
        let effects = loop.start(now: t0)
        XCTAssertEqual(effects, [.openMicrophone(generation: loop.generation)])
        XCTAssertEqual(loop.firstFrame(generation: loop.generation), [.readyCue])
        XCTAssertEqual(loop.phase, .listening)
        return (loop, loop.generation)
    }

    func testATurnSendsSpeaksAndListensAgainWithTheMicrophoneClosedInBetween() {
        var (loop, g) = started()
        XCTAssertEqual(loop.utterance("明日の天気は？", generation: g), [.closeMicrophone, .send("明日の天気は？")])
        XCTAssertEqual(loop.phase, .waiting)
        XCTAssertEqual(loop.reply(.settled("明日は雨です。")), [.speak("明日は雨です。", generation: g)])
        XCTAssertEqual(loop.phase, .speaking, "読み上げ中はマイクを開かない（半二重）")
        XCTAssertEqual(loop.speechFinished(generation: g), [.openMicrophone(generation: g)])
        XCTAssertEqual(loop.phase, .preparing, "2 ターン目を聞く")
    }

    func testEveryKindOfReplyReturnsToListening() {
        for reply: ConversationLoop.Reply in [.settled(""), .settled("   "), .working, .failed("接続を確認してください。"), .held] {
            var (loop, g) = started()
            _ = loop.utterance("依頼", generation: g)
            let effects = loop.reply(reply)
            if case .speak = effects.first {
                XCTAssertEqual(loop.speechFinished(generation: g), [.openMicrophone(generation: g)], "\(reply)")
            } else {
                XCTAssertEqual(effects, [.openMicrophone(generation: g)], "空の答えはすぐ次を聞く: \(reply)")
            }
            XCTAssertEqual(loop.phase, .preparing, "\(reply) のあとも次を聞ける")
        }
    }

    func testWorkInProgressIsAcknowledgedOnlyAsAccepted() {
        var (loop, g) = started()
        _ = loop.utterance("この資料を直して", generation: g)
        guard case .speak(let text, _) = loop.reply(.working).first else { return XCTFail("受付を知らせない") }
        XCTAssertTrue(text.contains("受け付けました"))
        XCTAssertFalse(text.contains("完了"), "受け付けただけで完了とは言わない")
    }

    func testEndingStopsEverythingAndIgnoresLateNotices() {
        var (loop, g) = started()
        _ = loop.utterance("依頼", generation: g)
        _ = loop.reply(.settled("答え"))
        XCTAssertEqual(loop.end(.user), [.stopSpeaking, .closeMicrophone, .ended(reason: .user)])
        XCTAssertFalse(loop.isActive)
        XCTAssertEqual(loop.speechFinished(generation: g), [], "終わった後の読み上げ完了でマイクを開かない")
        XCTAssertEqual(loop.utterance("遅れた確定文", generation: g), [], "終わった後の確定文で送らない")
        XCTAssertEqual(loop.reply(.settled("遅れた答え")), [], "終わった後の答えで読み上げない")
        XCTAssertEqual(loop.end(.user), [], "二度終えない")
    }

    func testARestartDoesNotReviveTheOldGeneration() {
        var (loop, g) = started()
        _ = loop.end(.user)
        _ = loop.start(now: t0.addingTimeInterval(10))
        XCTAssertNotEqual(loop.generation, g)
        XCTAssertEqual(loop.utterance("古い世代", generation: g), [])
    }

    func testFiveMinutesIsAHardLimitThatSpeechDoesNotExtend() {
        var (loop, g) = started()
        _ = loop.utterance("依頼", generation: g)
        _ = loop.reply(.settled(""))
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(200)), [], "話していても延びない・途中で終わらない")
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(271)), [.warnEnding])
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(280)), [], "知らせは 1 回")
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(300)), [.closeMicrophone, .ended(reason: .timeout)])
    }

    func testNoInactivityTimeoutBeforeFiveMinutes() {
        var (loop, _) = started()
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(120)), [], "90 秒の無操作では終わらない")
        XCTAssertTrue(loop.isActive)
    }

    func testExtensionIsExplicitAndBounded() {
        var (loop, _) = started()
        _ = loop.tick(now: t0.addingTimeInterval(275))
        XCTAssertTrue(loop.extend(now: t0.addingTimeInterval(276)))
        XCTAssertEqual(loop.remaining(at: t0.addingTimeInterval(300)), 300)
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(571)), [.warnEnding], "延ばしたら次の終わり際にまた知らせる")
        XCTAssertTrue(loop.extend(now: t0.addingTimeInterval(580)))
        XCTAssertFalse(loop.extend(now: t0.addingTimeInterval(590)), "合計 15 分まで")
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(900)), [.closeMicrophone, .ended(reason: .timeout)])
    }

    func testTheReadyCueSoundsOnceAfterTheFirstFrameOnly() {
        var loop = ConversationLoop()
        let g0 = loop.generation
        _ = loop.start(now: t0)
        XCTAssertEqual(loop.firstFrame(generation: g0), [], "古い世代のフレームでは鳴らさない")
        XCTAssertEqual(loop.firstFrame(generation: loop.generation), [.readyCue])
        let g = loop.generation
        _ = loop.utterance("依頼", generation: g)
        _ = loop.reply(.settled(""))
        XCTAssertEqual(loop.firstFrame(generation: g), [], "2 ターン目では鳴らさない")
    }

    func testStoppingSpeechKeepsTheConversationAndListens() {
        var (loop, g) = started()
        _ = loop.utterance("依頼", generation: g)
        _ = loop.reply(.settled("長い答え"))
        XCTAssertEqual(loop.stopSpeaking(), [.stopSpeaking, .openMicrophone(generation: g)])
        XCTAssertTrue(loop.isActive, "読み上げ停止は会話を終えない")
        XCTAssertEqual(loop.stopSpeaking(), [], "読み上げていなければ何もしない")
    }

    func testAnEmptyUtteranceKeepsListening() {
        var (loop, g) = started()
        XCTAssertEqual(loop.utterance("  ", generation: g), [])
        XCTAssertEqual(loop.phase, .listening)
    }
}
