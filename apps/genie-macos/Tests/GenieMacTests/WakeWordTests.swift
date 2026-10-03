import XCTest
@testable import GenieMac

/// 「ジーニー」の呼びかけ。端末の中で聞き取り、いつもの会話を始める。
@MainActor
final class WakeWordTests: XCTestCase {
    func testTheWakeWordIsFoundInTheWaysTheRecognizerWritesIt() {
        for text in ["ジーニー", "ジーニー、明日の天気は", "じーにー", "ねえジーニ", "ｼﾞｰﾆｰ", "Genie", "hey genie", "ジー ニー"] {
            XCTAssertTrue(WakeWordListener.containsWakeWord(text), text)
        }
        for text in ["今日の天気", "ジニア", "銀二", "ジーンズ", ""] {
            XCTAssertFalse(WakeWordListener.containsWakeWord(text), text)
        }
    }

    func testItListensOnlyWhenNothingElseUsesTheMicrophoneOrSpeaks() {
        let ready = WakeWordListener.Conditions(enabled: true, microphoneGranted: true, speechAuthorized: true,
                                                screenLocked: false, asleep: false,
                                                conversationActive: false, micInUse: false, speaking: false)
        XCTAssertTrue(WakeWordListener.mayListen(ready))
        var c = ready; c.enabled = false; XCTAssertFalse(WakeWordListener.mayListen(c))
        c = ready; c.microphoneGranted = false; XCTAssertFalse(WakeWordListener.mayListen(c))
        c = ready; c.speechAuthorized = false; XCTAssertFalse(WakeWordListener.mayListen(c))
        c = ready; c.screenLocked = true; XCTAssertFalse(WakeWordListener.mayListen(c))
        c = ready; c.asleep = true; XCTAssertFalse(WakeWordListener.mayListen(c))
        c = ready; c.conversationActive = true; XCTAssertFalse(WakeWordListener.mayListen(c))
        c = ready; c.micInUse = true; XCTAssertFalse(WakeWordListener.mayListen(c))
        // 自分の読み上げで起動しない。
        c = ready; c.speaking = true; XCTAssertFalse(WakeWordListener.mayListen(c))
    }

    func testItCanBeTurnedOffAndRemembersThat() {
        let suite = "wake-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let listener = WakeWordListener(defaults: defaults)
        XCTAssertTrue(listener.enabled)
        listener.enabled = false
        XCTAssertFalse(WakeWordListener(defaults: defaults).enabled)
        XCTAssertFalse(listener.listening)
    }
}
