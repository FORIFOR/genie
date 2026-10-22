import XCTest
@testable import GenieMac

/// 予約の一覧・チャット連携の状態の読み取りと、音声入力の履歴（この Mac の中だけ）。
final class AccountBoardsTests: XCTestCase {
    func testReadsSchedulesAndSaysWhenTheyRunNext() throws {
        let body = #"""
        {"items":[
          {"id":"a","name":"毎日 8:00 に「今日の予定をまとめて」を頼む","status":"active","kind":"task",
           "next_run_at":"2026-10-21T23:00:00.000Z","last_error":null,"consecutive_errors":0,"extra":1},
          {"id":"b","name":"平日の 18:00 に「日報」をお知らせ","status":"paused","kind":"reminder",
           "next_run_at":null,"last_error":null,"consecutive_errors":0},
          {"id":"c","name":"15 分ごとに「メールを確認して」を頼む","status":"disabled","kind":"task",
           "next_run_at":null,"last_error":"timeout","consecutive_errors":10}
        ]}
        """#
        let items = ScheduleBoard.decode(Data(body.utf8))
        XCTAssertEqual(items.map(\.id), ["a", "b", "c"])
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        XCTAssertEqual(ScheduleBoard.format(try XCTUnwrap(ScheduleBoard.parse("2026-10-21T23:00:00.000Z")), timeZone: tokyo),
                       "10/22（木）8:00")
        XCTAssertTrue(items[0].stateLine.hasPrefix("次は "))
        XCTAssertEqual(items[1].stateLine, "止めています")
        XCTAssertEqual(items[2].stateLine, "続けて失敗したので止まりました（timeout）")
        XCTAssertEqual(ScheduleBoard.decode(Data("nope".utf8)), [])
    }

    func testReadsChannelStatusWithoutSecrets() throws {
        let body = #"{"slack":{"configured":true,"transport":"socket","socket":{"state":"open"}},"line":{"configured":false},"durableInbox":true,"approvalButtons":false}"#
        let status = try JSONDecoder().decode(ChatChannelsBoard.Status.self, from: Data(body.utf8))
        XCTAssertTrue(status.slack.configured)
        XCTAssertEqual(status.slack.transport, "socket")
        XCTAssertFalse(status.line.configured)
    }

    private func history(_ now: @escaping () -> Date = Date.init) -> (DictationHistory, URL, UserDefaults) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("history-\(UUID().uuidString).json")
        let defaults = UserDefaults(suiteName: "history-\(UUID().uuidString)")!
        return (DictationHistory(fileURL: url, defaults: defaults, now: now), url, defaults)
    }

    func testKeepsInsertedTextOnThisMacOnly() throws {
        let (store, url, defaults) = history()
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertTrue(store.enabled)
        store.record(text: "Genie で送る。", original: "えー、ジーニーで送る。", app: "Notes", secureField: false)
        store.record(text: "same", original: "same", app: "Notes", secureField: false)
        store.record(text: "hunter2", original: "hunter2", app: "Safari", secureField: true)
        XCTAssertEqual(store.recent.map(\.text), ["same", "Genie で送る。"])
        XCTAssertEqual(store.recent.last?.original, "えー、ジーニーで送る。")
        XCTAssertNil(store.recent.first?.original)
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        // 次に起動しても残る
        XCTAssertEqual(DictationHistory(fileURL: url, defaults: defaults).recent.count, 2)
        // 止めたら消え、残さない
        store.setEnabled(false)
        XCTAssertEqual(store.recent, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        store.record(text: "later", original: "later", app: "Notes", secureField: false)
        XCTAssertEqual(store.recent, [])
    }

    func testForgetsOldAndExtraItems() {
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let (store, url, _) = history({ clock })
        defer { try? FileManager.default.removeItem(at: url) }
        store.record(text: "old", original: "old", app: "Notes", secureField: false)
        clock.addTimeInterval(DictationHistory.maxAge + 1)
        XCTAssertEqual(store.recent, [])
        for i in 0..<(DictationHistory.maxItems + 5) {
            store.record(text: "t\(i)", original: "t\(i)", app: "Notes", secureField: false)
        }
        XCTAssertEqual(store.recent.count, DictationHistory.maxItems)
        XCTAssertEqual(store.recent.first?.text, "t\(DictationHistory.maxItems + 4)")
    }
}
