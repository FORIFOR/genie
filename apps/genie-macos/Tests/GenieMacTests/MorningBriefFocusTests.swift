import XCTest
@testable import GenieMac

/// 朝の画面: 冒頭の要約、メール由来の候補と登録済みの区別、プロフィールの「保存しない」。
@MainActor
final class MorningBriefFocusTests: XCTestCase {
    func testSummaryDecodesAndOlderSavedCardsStillDecode() {
        let base = #"{"schema":"genie.brief/v1","date":"2026-10-12","generated_at":"2026-10-11T23:00:00.000Z","text":"","talk":"","highlights":[],"sections":[]"#
        XCTAssertNil(BriefCard.decode(base + "}")?.summary)
        let card = BriefCard.decode(base + #","summary":["今日は予定が入っていません。","急いで対応が要るものは見つかっていません。"]}"#)
        XCTAssertEqual(card?.summary?.count, 2)
    }

    private func context(confirmed: Bool?) throws -> WorkContext {
        let json = """
        {"generated_at":"2026-10-12T00:00:00Z","inference_enabled":true,"priorities":[],"waiting_on":[],
         "owed":[{"id":"owed:gmail:1","to":"A社","what":"提案資料の確認","due_at":null,"project":null,
                  "sources":[{"source":"gmail","external_id":"1","label":"件名","observed_at":"2026-10-11T00:00:00Z"}]
                  \(confirmed.map { ",\"confirmed\":\($0)" } ?? "")}],
         "week":{"meeting_hours":0,"deadlines":0,"unanswered":1,"waiting":0},"sources":{"gmail":1}}
        """
        return try WorkContextStore.decoder.decode(WorkContext.self, from: Data(json.utf8))
    }

    func testConfirmKeepsTheCandidateAndMarksItRegistered() throws {
        XCTAssertNil(try context(confirmed: nil).owed[0].confirmed, "older gateways omit the flag: still a candidate")
        let store = WorkContextStore.shared
        store.install(try context(confirmed: false), profile: nil)
        store.correct("owed:gmail:1", action: "confirm")
        XCTAssertEqual(store.context?.owed.first?.confirmed, true)
        store.correct("owed:gmail:1", action: "done")
        XCTAssertTrue(store.context?.owed.isEmpty == true)
        store.install(nil, profile: nil)
    }

    func testRejectedProfileItemsStayOutAfterReanalysis() {
        let store = InitialProfileStore.shared
        let sections = InitialProfileSections(focus: ["Genie開発", "Ｇｅｎｉｅ 営業"], people: ["田中"], priorities: [],
                                              workPattern: [], openItems: 0)
        store.installForTesting(nil, rejected: [InitialProfileStore.rejectionKey("genie 営業")])
        XCTAssertEqual(store.visible(sections).focus, ["Genie開発"], "full-width / case variants of a removed item stay removed")
        store.reject("田中")
        XCTAssertEqual(store.visible(sections).people, [])
        store.installForTesting(nil)
    }

    func testProjectLabelHiddenWhenItRepeatsTheTitle() {
        XCTAssertTrue(WorkFormat.repeats("「プログラミング」に関する新着イベントが公開されました (10/7)",
                                         in: "「プログラミング」に関する新着イベントが公開されました（10/7）"))
        XCTAssertTrue(WorkFormat.repeats("注文受付完了", in: "注文受付完了 ご注文ありがとうございます。"))
        XCTAssertFalse(WorkFormat.repeats("MOPITA", in: "MTI に見積の返信"))
        XCTAssertFalse(WorkFormat.repeats("", in: "題"))
    }
}
