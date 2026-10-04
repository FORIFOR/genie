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

    /// 端末内の認識器は短い「ジーニー」を「ジー」「ジニ」「爺」と書く（2026-10-04 実測）。
    func testShortCallsWrittenLooselyWakeOnlyWhenTheUtteranceIsOver() {
        for text in ["ジー", "ジニ", "爺", "G", "ねえ、ジニ", "ヘイ ジー"] {
            XCTAssertTrue(WakeWordListener.containsWakeWord(text, final: true), text)
            XCTAssertFalse(WakeWordListener.containsWakeWord(text, final: false), text)
        }
        // 本人の声では漢字で書かれた（「地に」「字」）。一言だけなら呼びかけとみなす。
        for text in ["地に", "字", "地に。", "ねえ、地に", "字に", "二"] where text != "二" {
            XCTAssertTrue(WakeWordListener.containsWakeWord(text, final: true), text)
        }
        // 続けて呼ぶと「字に字に」と書かれた（実機 2026-10-04）。3 回までの繰り返しは呼びかけ。
        for text in ["字に字に", "地に地に", "ジニジニ", "ジーニジーニ", "字に字に字に"] {
            XCTAssertTrue(WakeWordListener.containsWakeWord(text, final: true), text)
        }
        XCTAssertFalse(WakeWordListener.containsWakeWord("字に字に字に字に", final: true))
        XCTAssertFalse(WakeWordListener.containsWakeWord("字に字", final: false))
        for text in ["現地に行く", "土地に", "地にある", "二つ", "時々", "字が汚い", "字に字に書く"] {
            XCTAssertFalse(WakeWordListener.containsWakeWord(text, final: true), text)
        }
        for text in ["ジーンズ", "ジーンズを買う", "ジニアの花", "爺さん", "Gメール"] {
            XCTAssertFalse(WakeWordListener.containsWakeWord(text, final: true), text)
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
