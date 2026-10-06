import XCTest
@testable import GenieMac

/// 今日のまとめ（先回り 段階1）: 読み方・いつ作るか・サービスへ渡す材料・会話へ渡す文。
final class BriefTests: XCTestCase {
    private let body = #"""
    {"schema":"genie.brief/v1","date":"2026-10-06","generated_at":"2026-10-06T00:30:00.000Z",
     "text":"今日の予定は3件、次は10:00の「設計レビュー」です。","talk":"今日の予定は3件、次は10:00からです。",
     "highlights":["次の予定: 10:00 設計レビュー"],
     "sections":[
      {"id":"calendar","title":"予定","status":"ok","fetched_at":"2026-10-06T00:29:00Z","sources":[{"name":"このMacのカレンダー","url":""}],
       "lines":[{"text":"10:00–11:00 設計レビュー","time":"10:00"}]},
      {"id":"news","title":"ニュース","status":"stale","reason":"timeout","fetched_at":null,"sources":[],"lines":[]},
      {"id":"markets","title":"監視銘柄","status":"none","reason":"株価の取得元が未設定です","fetched_at":null,"sources":[],"lines":[]}]}
    """#

    func testDecodesTheBriefAndRoutesItToItsOwnCard() throws {
        let card = try XCTUnwrap(BriefCard.decode(body))
        XCTAssertEqual(card.sections.map(\.status), ["ok", "stale", "none"])
        XCTAssertEqual(card.sections[0].lines.first?.time, "10:00")
        XCTAssertNotNil(card.generated)
        guard case .brief(let routed) = DockCard.decode(body) else { return XCTFail("brief card expected") }
        XCTAssertEqual(routed, card)
        XCTAssertNil(BriefCard.decode(body.replacingOccurrences(of: "genie.brief/v1", with: "genie.info/v1")))
        // 保存して読み直しても同じ
        let saved = try XCTUnwrap(card.encoded().flatMap { String(data: $0, encoding: .utf8) })
        XCTAssertEqual(BriefCard.decode(saved), card)
    }

    func testMakesOneBriefPerDayAfterSevenAndNeverBackfills() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        func at(_ day: Int, _ hour: Int) -> Date { calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))! }
        let today = try XCTUnwrap(BriefCard.decode(body))
        XCTAssertFalse(BriefStore.isDue(latest: nil, now: at(6, 6), calendar: calendar), "7 時前は作らない")
        XCTAssertTrue(BriefStore.isDue(latest: nil, now: at(6, 7), calendar: calendar))
        XCTAssertFalse(BriefStore.isDue(latest: today, now: at(6, 22), calendar: calendar), "今日の分はもうある")
        XCTAssertTrue(BriefStore.isDue(latest: today, now: at(9, 8), calendar: calendar), "3 日止まっていても作るのは今日の 1 枚")
        XCTAssertEqual(BriefStore.day(at(9, 8), calendar: calendar), "2026-10-09")
    }

    func testSendsOnlyWhatTheMacHasAndSaysWhenItHasNothing() throws {
        let now = Date(timeIntervalSince1970: 1_791_255_000)
        let events = [CalendarAccess.Event(title: "A社訪問", startEpoch: now.timeIntervalSince1970 + 3600, endEpoch: now.timeIntervalSince1970 + 7200,
                                           calendar: "仕事", location: "品川", allDay: false)]
        let granted = BriefStore.input(now: now, calendarStatus: .granted, events: events, work: nil, workFailed: false, interests: ["半導体", "為替", "金利", "多すぎ"])
        let calendarInput = try XCTUnwrap(granted["calendar"] as? [String: Any])
        XCTAssertEqual(calendarInput["status"] as? String, "granted")
        let rows = try XCTUnwrap(calendarInput["events"] as? [[String: Any]])
        XCTAssertEqual(rows.first?["title"] as? String, "A社訪問")
        XCTAssertEqual(rows.first?["location"] as? String, "品川")
        XCTAssertNotNil((rows.first?["start"] as? String)?.range(of: #"[+-]\d{2}:\d{2}$|Z$"#, options: .regularExpression), "時差つき")
        XCTAssertEqual((granted["attention"] as? [String: Any])?["status"] as? String, "none", "Work をつないでいなければ none")
        XCTAssertEqual(granted["interests"] as? [String], ["半導体", "為替", "金利"], "話題は 3 つまで")

        let denied = BriefStore.input(now: now, calendarStatus: .denied, events: events, work: nil, workFailed: true, interests: [])
        XCTAssertEqual(((denied["calendar"] as? [String: Any])?["events"] as? [Any])?.count, 0, "許可が無ければ予定を渡さない")
        XCTAssertEqual((denied["attention"] as? [String: Any])?["status"] as? String, "stale", "読めなかったら未更新")
    }

    func testTellsTheConversationHowOldTheBriefIs() throws {
        let card = try XCTUnwrap(BriefCard.decode(body))
        let generated = try XCTUnwrap(card.generated)
        XCTAssertEqual(VoiceHUDState.briefTalk(card, now: generated.addingTimeInterval(30)),
                       "今日の予定は3件、次は10:00からです。（いまにまとめた内容です。画面にまとめを出しています）")
        XCTAssertTrue(VoiceHUDState.briefTalk(card, now: generated.addingTimeInterval(3 * 3600)).contains("3時間前"))
        XCTAssertFalse(VoiceHUDState.briefTalk(card, now: generated).contains("設計レビュー"), "会話へは題名を渡さない")
    }
}
