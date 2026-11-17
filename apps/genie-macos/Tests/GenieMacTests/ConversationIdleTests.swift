import XCTest
@testable import GenieMac

/// 有料の会話（Gemini Live）は、話しかけられなければ早めに終える（つなぎっぱなしで課金しない）。
final class ConversationIdleTests: XCTestCase {
    private func paidLoop(_ t0: Date) -> ConversationLoop {
        var loop = ConversationLoop()
        loop.idleLimit = 45; loop.firstSpeechLimit = 10
        _ = loop.start(now: t0)
        _ = loop.firstFrame(generation: loop.generation)
        return loop
    }

    func testAFalseWakeWithNoWordsEndsAfterTenSeconds() {
        let t0 = Date()
        var loop = paidLoop(t0)
        XCTAssertTrue(loop.tick(now: t0.addingTimeInterval(9)).isEmpty)
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(10)).last, .ended(reason: .idle))
        XCTAssertFalse(loop.isActive)
    }

    func testAfterTalkingSilenceEndsItAndThinkingOrSpeakingIsNotSilence() {
        let t0 = Date()
        var loop = paidLoop(t0)
        _ = loop.utterance("ジーニー、天気は？", generation: loop.generation)
        XCTAssertTrue(loop.tick(now: t0.addingTimeInterval(60)).isEmpty, "waiting for the answer is not idle")
        _ = loop.reply(.settled("晴れです。"))
        XCTAssertTrue(loop.tick(now: t0.addingTimeInterval(120)).isEmpty, "speaking is not idle")
        _ = loop.speechFinished(generation: loop.generation)
        _ = loop.firstFrame(generation: loop.generation)
        _ = loop.tick(now: t0.addingTimeInterval(121))
        XCTAssertTrue(loop.tick(now: t0.addingTimeInterval(165)).isEmpty)
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(166)).last, .ended(reason: .idle))
    }

    func testTheOnDeviceConversationKeepsItsFiveMinutes() {
        let t0 = Date()
        var loop = ConversationLoop()
        _ = loop.start(now: t0)
        _ = loop.firstFrame(generation: loop.generation)
        XCTAssertTrue(loop.tick(now: t0.addingTimeInterval(120)).isEmpty)
        XCTAssertTrue(loop.isActive)
    }

    /// 声を出さずに欄へ打っている間は閉じない（2026-10-24、打ちかけの文ごと 10 秒で消えていた）。
    func testTypingKeepsTheConversationOpenAndCountsFromTheLastKeystroke() {
        let t0 = Date()
        var loop = paidLoop(t0)
        loop.typed(hasDraft: true, now: t0.addingTimeInterval(8))
        XCTAssertTrue(loop.tick(now: t0.addingTimeInterval(30)).isEmpty, "typing is not silence")
        loop.typed(hasDraft: true, now: t0.addingTimeInterval(50))
        XCTAssertTrue(loop.tick(now: t0.addingTimeInterval(109)).isEmpty)
        // 打つのをやめて置いたままなら、最後に打ってから 60 秒で閉じる（声を送り続けない）
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(110)).last, .ended(reason: .idle))
        XCTAssertTrue(loop.typedAny, "not a false wake")
    }

    func testClearingTheFieldReturnsToTheUsualLimit() {
        let t0 = Date()
        var loop = paidLoop(t0)
        loop.typed(hasDraft: true, now: t0.addingTimeInterval(2))
        loop.typed(hasDraft: false, now: t0.addingTimeInterval(5))
        XCTAssertTrue(loop.tick(now: t0.addingTimeInterval(14)).isEmpty)
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(15)).last, .ended(reason: .idle))
    }

    func testANewConversationForgetsTheOldDraft() {
        let t0 = Date()
        var loop = paidLoop(t0)
        loop.typed(hasDraft: true, now: t0)
        _ = loop.end(.user)
        _ = loop.start(now: t0.addingTimeInterval(100))
        _ = loop.firstFrame(generation: loop.generation)
        XCTAssertFalse(loop.typedAny)
        XCTAssertEqual(loop.tick(now: t0.addingTimeInterval(110)).last, .ended(reason: .idle))
    }
}
