import XCTest
@testable import GenieMac

/// 音声入力の「整える」: 言葉は変えず、ほかの意味になり得ない言い淀みだけを消す。
final class DictationCleanupTests: XCTestCase {
    func testRemovesUnambiguousFillersAtWordBoundaries() {
        XCTAssertEqual(DictationCleanup.clean("えーっと、明日の会議の資料を共有してください。"), "明日の会議の資料を共有してください。")
        XCTAssertEqual(DictationCleanup.clean("えーと明日の天気教えて"), "明日の天気教えて")
        XCTAssertEqual(DictationCleanup.clean("資料は、えー、来週送ります。"), "資料は、来週送ります。")
        XCTAssertEqual(DictationCleanup.clean("うーん、それでお願いします。"), "それでお願いします。")
    }

    func testKeepsWordsThatAreNotFillers() {
        // 指示語・返事・語の中の長音は消さない。
        XCTAssertEqual(DictationCleanup.clean("あの資料を共有してください。"), "あの資料を共有してください。")
        XCTAssertEqual(DictationCleanup.clean("その件はまあ大丈夫です。"), "その件はまあ大丈夫です。")
        XCTAssertEqual(DictationCleanup.clean("ええ、そうです。"), "ええ、そうです。")
        XCTAssertEqual(DictationCleanup.clean("ケーキを買ってえーと言った"), "ケーキを買ってえーと言った")
        XCTAssertEqual(DictationCleanup.clean("明日の天気教えて"), "明日の天気教えて")
    }

    func testNeverReturnsEmpty() {
        XCTAssertEqual(DictationCleanup.clean("えーっと"), "えーっと")
    }
}

final class DictationTerminationTests: XCTestCase {
    func testEachSegmentEndsAsASentence() {
        XCTAssertEqual(DictationCleanup.terminated("資料を共有してください"), "資料を共有してください。")
        XCTAssertEqual(DictationCleanup.terminated("資料を共有してください。"), "資料を共有してください。")
        XCTAssertEqual(DictationCleanup.terminated("本当ですか？"), "本当ですか？")
        XCTAssertEqual(DictationCleanup.terminated("「はい」"), "「はい」")
        XCTAssertEqual(DictationCleanup.terminated(""), "")
    }
}
