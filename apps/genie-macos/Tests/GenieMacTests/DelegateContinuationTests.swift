import XCTest
@testable import GenieMac

/// 言いかけの間で頼まれた依頼に、続きの言葉を足す（R02 呼びかけの後の言葉を捨てない）。
final class DelegateContinuationTests: XCTestCase {
    func testAddsWhatWasSaidAfterThePause() {
        XCTAssertEqual(DelegateContinuation.merge("端末を 120 台にしたら", continuation: "、提案書とスライドも合わせた案を作って。"),
                       "端末を 120 台にしたら、提案書とスライドも合わせた案を作って")
        XCTAssertEqual(DelegateContinuation.merge("端末を120台にしたら、", continuation: "提案書も"), "端末を120台にしたら、提案書も")
    }

    func testKeepsTheRequestWhenNothingNewWasSaid() {
        XCTAssertEqual(DelegateContinuation.merge("近くのマクドナルド", continuation: "  "), "近くのマクドナルド")
        XCTAssertEqual(DelegateContinuation.merge("マクドナルドの公式サイトを Safari で開いて", continuation: "Safari で開いて"),
                       "マクドナルドの公式サイトを Safari で開いて", "Gemini の依頼に既に入っている続きは重ねない")
    }

    func testRecognisesASecondCallForTheSameContinuation() {
        XCTAssertTrue(DelegateContinuation.isPart("提案書とスライドも合わせた案を作って", of: "提案書とスライドも合わせた案を作って。"))
        XCTAssertTrue(DelegateContinuation.isPart("提案書とスライドも合わせた案", of: "提案書とスライドも合わせた案を作って"))
        XCTAssertFalse(DelegateContinuation.isPart("天気を教えて", of: "提案書とスライドも合わせた案を作って"))
        XCTAssertFalse(DelegateContinuation.isPart("はい", of: "はい"), "短すぎる言葉では同じ話と決めない")
    }
}

final class DelegateSubjectTests: XCTestCase {
    /// liveflow 2026-10-16: 「マクドナル」「したい。」の 2 ターンに分かれ、Gemini は「注文したい」だけを渡した。
    func testBareOrderGetsTheEarlierWords() {
        XCTAssertEqual(DelegateContinuation.withSubject("注文したい", heardBefore: "マクドナル したい。"), "マクドナルで注文したい")
        XCTAssertEqual(DelegateContinuation.withSubject("注文したい", heardBefore: "マクドナルドで"), "マクドナルドで注文したい")
    }

    func testRequestsWithASubjectStayAsTheyAre() {
        XCTAssertEqual(DelegateContinuation.withSubject("チーズバーガーを1つ注文して", heardBefore: "マクドナル"), "チーズバーガーを1つ注文して")
        XCTAssertEqual(DelegateContinuation.withSubject("近くのカフェを探して", heardBefore: "えっと"), "近くのカフェを探して")
    }

    func testLongOrEmptyEarlierTalkIsNotAdded() {
        XCTAssertEqual(DelegateContinuation.withSubject("注文したい", heardBefore: ""), "注文したい")
        XCTAssertEqual(DelegateContinuation.withSubject("注文したい", heardBefore: "昨日の会議の資料をまとめてから来週の予定を確認して"), "注文したい")
    }
}
