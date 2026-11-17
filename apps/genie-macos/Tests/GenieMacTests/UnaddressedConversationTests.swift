import XCTest
@testable import GenieMac

/// 誰も Genie に話しかけていない会話を、早く閉じる（Gemini Live の月の上限を周りの声で使い切らない）。
@MainActor
final class UnaddressedConversationTests: XCTestCase {
    func testAPaidConversationClosesAfterTwentySecondsOfListening() {
        XCTAssertEqual(VoiceHUDState.paidIdleLimit, 20)
        var loop = ConversationLoop()
        loop.idleLimit = VoiceHUDState.paidIdleLimit
        let start = Date(timeIntervalSince1970: 0)
        _ = loop.start(now: start)
        _ = loop.tick(now: start)
        XCTAssertTrue(loop.isActive)
        _ = loop.tick(now: start.addingTimeInterval(19))
        XCTAssertTrue(loop.isActive)
        _ = loop.tick(now: start.addingTimeInterval(21))
        XCTAssertFalse(loop.isActive)
    }

    func testWaitingForDelegatedWorkKeepsTheConversationUpToNinetySeconds() {
        // 公式サイトを開く仕事の結果を伝える前に、20 秒で切れていた（2026-10-19）
        var loop = ConversationLoop()
        loop.idleLimit = VoiceHUDState.paidIdleLimit
        let start = Date(timeIntervalSince1970: 0)
        _ = loop.start(now: start)
        _ = loop.tick(now: start, waitingForWork: true)
        _ = loop.tick(now: start.addingTimeInterval(60), waitingForWork: true)
        XCTAssertTrue(loop.isActive)
        // 長い仕事でも、つなぎっぱなしにはしない
        _ = loop.tick(now: start.addingTimeInterval(91), waitingForWork: true)
        XCTAssertFalse(loop.isActive)
    }

    /// 結果が届いた瞬間に、待っていた時間を普段の 20 秒で数えて閉じない（liveflow 2026-10-20 00:17:50Z）。
    func testReportedWorkRestartsTheIdleClock() {
        var loop = ConversationLoop()
        loop.idleLimit = VoiceHUDState.paidIdleLimit
        let start = Date(timeIntervalSince1970: 0)
        _ = loop.start(now: start)
        _ = loop.tick(now: start, waitingForWork: true)
        _ = loop.tick(now: start.addingTimeInterval(26), waitingForWork: true)
        loop.workReported(now: start.addingTimeInterval(26))
        _ = loop.tick(now: start.addingTimeInterval(27), waitingForWork: false)
        XCTAssertTrue(loop.isActive, "Gemini が結果を伝える間は閉じない")
        _ = loop.tick(now: start.addingTimeInterval(47), waitingForWork: false)
        XCTAssertFalse(loop.isActive, "伝えた後は普段どおり 20 秒で閉じる")
    }

    func testTheSameInfoRequestIsRecognizedWhateverTheArgumentOrder() {
        // Gemini は同じ依頼を、引数の順を変えて 2 回呼んだ（2026-10-19）
        XCTAssertEqual(GeminiLiveProvider.infoKey(#"{"kind":"news","request":"今日のニュースを教えて"}"#),
                       GeminiLiveProvider.infoKey(#"{"request":"今日のニュースを教えて","kind":"news"}"#))
        XCTAssertNotEqual(GeminiLiveProvider.infoKey(#"{"kind":"news","request":"今日のニュース"}"#),
                          GeminiLiveProvider.infoKey(#"{"kind":"weather","request":"今日のニュース"}"#))
        XCTAssertEqual(GeminiLiveProvider.infoReuseSeconds, 15)
    }

    func testGeminiIsToldNotToAnswerVoicesThatAreNotForIt() {
        XCTAssertTrue(GeminiLiveProvider.instruction.contains("Genie に向けて話されていない声には返事をしないでください"))
        XCTAssertTrue(GeminiLiveProvider.instruction.contains("何も言わずに end_conversation を呼んでください"))
    }
}
