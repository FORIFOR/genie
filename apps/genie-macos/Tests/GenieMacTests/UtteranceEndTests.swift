import XCTest
@testable import GenieMac

/// 話し終わりの判定。周りに音があっても、言葉が止まれば送る（2026-10-03 実機で送られなかった）。
final class UtteranceEndTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func close(audioAgo: TimeInterval, textAgo: TimeInterval, stable: TimeInterval?) -> Bool {
        let now = t0.addingTimeInterval(10)
        return SpeechTranscriber.shouldClose(now: now, lastAudio: now.addingTimeInterval(-audioAgo),
                                             lastTextChange: now.addingTimeInterval(-textAgo),
                                             segmentStart: t0, utteranceGap: 2.2, textStableGap: stable)
    }

    func testSilenceStillEndsTheUtterance() {
        XCTAssertTrue(close(audioAgo: 2.3, textAgo: 0.1, stable: 2.5))
    }

    func testBackgroundSoundNoLongerKeepsItOpenOnceTheWordsStop() {
        // 音は途切れない（周りの音）が、文字は 2.6 秒変わっていない → 閉じて送る。
        XCTAssertTrue(close(audioAgo: 0.0, textAgo: 2.6, stable: 2.5))
        // まだ話している（文字が変わり続けている）→ 閉じない。
        XCTAssertFalse(close(audioAgo: 0.0, textAgo: 1.0, stable: 2.5))
    }

    func testMeetingTranscriptionKeepsTheOldRule() {
        // 会議の文字起こしは文字の静止では閉じない（textStableGap なし）。
        XCTAssertFalse(close(audioAgo: 0.0, textAgo: 9.0, stable: nil))
    }
}
