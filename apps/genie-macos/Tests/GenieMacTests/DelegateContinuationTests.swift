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

final class DelegateTailTests: XCTestCase {
    /// liveflow 2026-10-19: Gemini は「チーズバーガーのM」で呼び、続きの「セットを注文して」を文字にしなかった。
    func testTailHeardOnTheMacIsAppended() {
        XCTAssertEqual(DelegateContinuation.appendTail("チーズバーガーのM", tail: "セットを注文して"), "チーズバーガーのMセットを注文して")
    }

    func testOverlapWithTheRequestIsNotRepeated() {
        XCTAssertEqual(DelegateContinuation.appendTail("チーズバーガーのM", tail: "バーガーのMセットを注文して。"), "チーズバーガーのMセットを注文して")
        XCTAssertEqual(DelegateContinuation.appendTail("チーズバーガーのM", tail: "チーズバーガーのMセットを注文して"), "チーズバーガーのMセットを注文して")
    }

    /// 手元の認識が全体を拾い、言い方が少し違って重ならないときは、手元の全体を使う（同じ言葉を二度並べない）。
    func testWholeUtteranceHeardOnTheMacReplacesTheCutRequest() {
        XCTAssertEqual(DelegateContinuation.appendTail("チーズバーガー", tail: "チーズバーガのMセットを注文して"), "チーズバーガのMセットを注文して")
    }

    func testTailAlreadyInTheRequestChangesNothing() {
        XCTAssertEqual(DelegateContinuation.appendTail("チーズバーガーのMセットを注文して", tail: "注文して"), "チーズバーガーのMセットを注文して")
        XCTAssertEqual(DelegateContinuation.appendTail("近くのカフェを探して", tail: " 。"), "近くのカフェを探して")
    }

    /// 同じ依頼の呼び直しは二度頼まない。短い答え（「ひとつ」）は同じとみなさない。
    func testCoversSameRequestButNotShortAnswers() {
        XCTAssertTrue(DelegateContinuation.covers("チーズバーガーのMセットを注文して", "チーズバーガーのM"))
        XCTAssertFalse(DelegateContinuation.covers("チーズバーガーのM", "チーズバーガーのMセットを注文して"))
        XCTAssertFalse(DelegateContinuation.covers("ひとつ", "ひとつ"))
    }

    func testAcceptedResponseAsksForOneShortAcknowledgement() {
        let accepted = GeminiLiveProvider.acceptedResponse("accepted")
        XCTAssertEqual(accepted["status"], "accepted")
        XCTAssertTrue(accepted["message"]?.contains("もう一度呼ばない") == true)
        XCTAssertEqual(GeminiLiveProvider.acceptedResponse("not_accepted"), ["status": "not_accepted"])
    }
}

final class TodayBriefIntentTests: XCTestCase {
    func testScheduleQuestionsGoToTheBrief() {
        for q in ["今日の予定を教えて", "今日の予定は？", "きょうは何か予定ある？", "本日のスケジュール", "今日のまとめ", "まとめを見せて"] {
            XCTAssertTrue(TodayBriefIntent.detect(q), q)
        }
    }

    func testChangingTheScheduleOrOtherQuestionsDoNot() {
        for q in ["今日の予定に会議を追加して", "今日の予定をキャンセルして", "明日の予定は？", "今日の天気は？", "今日やるべきことは？", "会議のまとめを作って"] {
            XCTAssertFalse(TodayBriefIntent.detect(q), q)
        }
    }
}

final class ReheardTests: XCTestCase {
    /// liveflow 2026-10-19: Gemini は「マクドナルド注文して」を「マクドナルド」で切り、何も返さなかった。
    func testCutOffHearingIsReplacedByTheLongerOne() {
        XCTAssertEqual(DelegateContinuation.longerHearing("マクドナルド注文して", than: "マクドナルド"), "マクドナルド注文して")
    }

    /// 黙った後は、聞き違え（「今日どう？」→「共同」）も手元の聞き取りで渡す。同じ言葉なら渡さない。
    func testAfterSilenceAMisheardRequestIsSentAsHeardOnTheMac() {
        XCTAssertEqual(DelegateContinuation.differentHearing("今日どう？", than: "共同"), "今日どう？")
        XCTAssertNil(DelegateContinuation.differentHearing("共同", than: "共同。"))
        XCTAssertNil(DelegateContinuation.differentHearing("あ", than: ""))
    }

    func testStageDirectionsCountAsSilence() {
        for said in ["...", "（返事をせずに待っています）", "<!-- 応答なし（待機） -->", "【待機】", ""] {
            XCTAssertTrue(GeminiLiveProvider.isSilentReply(said), said)
        }
        XCTAssertFalse(GeminiLiveProvider.isSilentReply("はい、どうされましたか？"))
        XCTAssertFalse(GeminiLiveProvider.isSilentReply("（確認します）承知しました"))
    }

    func testSameOrUnrelatedHearingIsNotSent() {
        XCTAssertNil(DelegateContinuation.longerHearing("マクドナルド", than: "マクドナルド。"))
        XCTAssertNil(DelegateContinuation.longerHearing("きょうはいい天気ですね", than: "マクドナルド"))
        XCTAssertNil(DelegateContinuation.longerHearing("", than: "マクドナルド"))
    }
}

final class UnheardSpeechTests: XCTestCase {
    /// 声らしい大きさの音だけを数える（静けさや小さな雑音は数えない）。
    func testVoicedSecondsCountsOnlySpeechLevelAudio() {
        let quiet = [Float](repeating: 0.001, count: 16_000)
        let voice = [Float](repeating: 0.05, count: 8_000)
        XCTAssertEqual(GeminiLiveProvider.voicedSeconds(quiet + voice), 0.5, accuracy: 0.001)
        XCTAssertEqual(GeminiLiveProvider.voicedSeconds(quiet), 0)
    }

    /// Genie 自身の声の残り（直前に Genie が言った言葉）は、利用者の言葉として渡さない。
    func testGeniesOwnWordsAreNotSentBack() {
        XCTAssertTrue(DelegateContinuation.covers("チーズバーガーのセットの数量を教えていただけますか？", "数量を教えて"))
        XCTAssertFalse(DelegateContinuation.covers("チーズバーガーのセットの数量を教えていただけますか？", "ひとつ"))
    }
}
