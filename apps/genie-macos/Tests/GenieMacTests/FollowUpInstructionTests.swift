import XCTest
@testable import GenieMac

/// 段階 5: 「あと、〜」は、直前の仕事が動いている間だけ、その仕事への追加指示になる。
final class FollowUpInstructionTests: XCTestCase {
    func testOnlyAnExplicitLeadingConnectiveMakesAFollowUp() {
        for text in ["あと、テストも追加して", "それと ダークモードも確認して", "ついでに、見出しも直して", "追加で、画像も差し替えて", "それから、PDF にもして"] {
            XCTAssertTrue(VoiceHUDState.isFollowUp(text), text)
        }
        for text in ["あとで見る", "あとは任せる", "それとなく聞いて", "テストも追加して", "明日のあと、会議がある", "あとがきを書いて"] {
            XCTAssertFalse(VoiceHUDState.isFollowUp(text), text)
        }
    }
}
