import XCTest
@testable import GenieMac

final class WakeDecisionTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)
    private func run(_ scores: [(Double, Float)]) -> [WakeDecision.Verdict] {
        var d = WakeDecision()
        return scores.map { d.next(score: $0.1, threshold: 0.95, hits: 2, at: t0.addingTimeInterval($0.0)) }
    }

    func testTwoHighScoresInARowWake() {
        XCTAssertEqual(run([(0, 0.97), (0.2, 0.99)]).last, .streak)
    }

    /// 本人の短い「ジーニー」: 一瞬だけ 1.00 が出て続かない。呼び直せば起きる（2026-10-16 の genie.log）。
    func testCallingAgainAfterASingleSpikeWakes() {
        let verdicts = run([(0, 1.0), (0.2, 0.6), (8, 0.3), (9, 1.0), (9.2, 0.4)])
        XCTAssertEqual(verdicts, [.none, .none, .none, .repeated, .none])
    }

    func testOneSpikeAloneDoesNotWake() {
        XCTAssertFalse(run([(0, 1.0), (0.2, 0.5), (5, 0.7), (30, 0.94)]).contains { $0 != .none })
    }

    /// 本人の「ジーニー」が 0.83〜0.86 で止まる日（2026-10-16 午後）: 2 回呼べば起きる。1 回では起きない。
    func testTwoCallsBelowTheOneCallThresholdWake() {
        XCTAssertEqual(run([(0, 0.84), (0.2, 0.4), (6, 0.86), (6.2, 0.3)]), [.none, .none, .repeated, .none])
        XCTAssertEqual(run([(0, 0.84), (0.2, 0.4)]), [.none, .none])
    }

    func testCallsBelowTheRepeatFloorNeverWake() {
        XCTAssertFalse(run([(0, 0.79), (0.2, 0.3), (5, 0.77), (5.2, 0.3), (9, 0.78)]).contains { $0 != .none })
    }

    /// 同じ呼びかけの中で途切れた高い点（0.4 秒後）は、呼び直しと数えない。
    func testSpikesWithinOneUtteranceAreNotARepeat() {
        XCTAssertEqual(run([(0, 1.0), (0.2, 0.5), (0.4, 0.98)]), [.none, .none, .none])
    }

    func testSpikesFarApartDoNotWake() {
        XCTAssertEqual(run([(0, 1.0), (0.2, 0.3), (13, 1.0)]), [.none, .none, .none])
    }

    func testAfterWakingTheRepeatStartsOver() {
        let verdicts = run([(0, 1.0), (0.2, 0.3), (5, 1.0), (5.2, 0.3), (10, 1.0), (10.2, 0.3)])
        XCTAssertEqual(verdicts, [.none, .none, .repeated, .none, .none, .none])
    }

    /// 呼びかけの始まりから数える: 高い点が続いていても、始まりから 1.5 秒を過ぎた次の呼びかけで起きる。
    func testRepeatIsCountedFromTheStartOfEachCall() {
        XCTAssertEqual(run([(0, 0.9), (0.2, 0.9), (0.4, 0.9), (0.6, 0.2), (1.6, 0.9)]), [.none, .none, .none, .none, .repeated])
    }

    /// ふつうの文の中の、1.2 秒しか離れていない 2 つの高い点（0.91 → 0.89）では起きない（Kyoko の合成音）。
    func testTwoSpikesInOneSentenceDoNotWake() {
        XCTAssertEqual(run([(0, 0.91), (0.2, 0.2), (1.2, 0.89), (1.4, 0.2)]), [.none, .none, .none, .none])
    }

    /// 一度下がって（0.4）すぐ戻った点（0.6 秒後）は、同じ呼びかけの揺れ。
    func testDipWithinOneCallIsNotARepeat() {
        XCTAssertEqual(run([(0, 0.9), (0.2, 0.4), (0.6, 0.9), (0.8, 0.2)]), [.none, .none, .none, .none])
    }
}
