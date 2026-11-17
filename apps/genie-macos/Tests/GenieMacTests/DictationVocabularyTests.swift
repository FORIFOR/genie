import XCTest
@testable import GenieMac

/// 個人の辞書の置き換え。サーバの applyVocabulary と同じ規則（長い順・置き換えた結果は置き換えない）。
final class DictationVocabularyTests: XCTestCase {
    private let vocabulary = DictationVocabulary(entries: [
        .init(spoken: "ジーニー", written: "Genie"),
        .init(spoken: "ジーニーアプリ", written: "Genie.app"),
        .init(spoken: "Genie", written: "XXX"),
        .init(spoken: "スーパーインターン", written: "スーパーインターン"),
        .init(spoken: "カレンダーリンク", written: "https://cal.example.com/me?ref=" + String(repeating: "x", count: 40)),
    ])

    func testReplacesLongestFirstAndNeverReplacesItsOwnOutput() {
        XCTAssertEqual(vocabulary.apply("ジーニーアプリでジーニーを開く"), "Genie.appでGenieを開く")
        XCTAssertEqual(vocabulary.apply("変わらない文"), "変わらない文")
        XCTAssertEqual(DictationVocabulary().apply("空の辞書"), "空の辞書")
    }

    func testHintsAreShortSpokenFormsOnce() {
        XCTAssertEqual(vocabulary.hints, ["ジーニー", "ジーニーアプリ", "Genie", "スーパーインターン", "カレンダーリンク"])
    }

    func testDecodesTheGatewayList() {
        let body = #"{"items":[{"id":"1","spoken":"ジーニー","written":"Genie","created_at":"2026-10-21T00:00:00Z"}]}"#
        XCTAssertEqual(DictationVocabulary.decode(Data(body.utf8)),
                       DictationVocabulary(entries: [.init(spoken: "ジーニー", written: "Genie", id: "1")]))
        XCTAssertNil(DictationVocabulary.decode(Data("nope".utf8)))
    }

    func testLoadsTheCopyKeptOnDisk() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("vocab-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try JSONEncoder().encode(vocabulary).write(to: url)
        let store = DictationVocabularyStore(fileURL: url)
        XCTAssertEqual(store.apply("ジーニーで"), "Genieで")
    }
}
