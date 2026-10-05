import XCTest
@testable import GenieMac

final class EndRequestTests: XCTestCase {
    func testSayingYouAreDoneClosesTheConversation() {
        for text in ["終了して", "終了してください。", "終わり", "おしまい", "閉じて", "ありがとう、終わり", "会話を終了して",
                     "ジーニー、終わりにして", "終わりで", "終わって", "バイバイ", "バイバーイ", "さようなら", "またね", "じゃあね",
                     "ありがとう。バイバイ。", "ストックにない。終わって。", "Bye bye.", "おやすみなさい"] {
            XCTAssertTrue(VoiceHUDState.isEndRequest(text), text)
        }
    }

    func testAWordInsideASentenceDoesNot() {
        for text in ["終わりの時間は？", "会議が終了したら教えて", "この作業を終えてから送って", "終了日を確認して", "おしまいまで読んで",
                     "仕事が終わって疲れた", "さようならの英語は？", "バイバイって言われた"] {
            XCTAssertFalse(VoiceHUDState.isEndRequest(text), text)
        }
    }

    func testGeminiIsGivenAnEndTool() throws {
        let setup = GeminiLive.setup(instruction: "x")
        let json = String(data: try JSONSerialization.data(withJSONObject: setup), encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains(GeminiLive.endTool))
    }
}
