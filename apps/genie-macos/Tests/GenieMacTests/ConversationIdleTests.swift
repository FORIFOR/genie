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
}
