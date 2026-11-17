import XCTest
@testable import GenieMac

/// サーバのお知らせ（GET /v1/notices）の読み取り。壊れた本文で落ちない。
final class NoticeInboxTests: XCTestCase {
    func testDecodesNoticesFromTheGateway() {
        let body = """
        {"items":[
          {"id":"0192-a","kind":"reminder","title":"会議","body":"","job_id":"j1","task_id":null,"created_at":"2026-10-21T01:45:00Z"},
          {"id":"0192-b","kind":"scheduled_task","title":"予約の仕事を始めました：競合調査","body":"結果は作業一覧で開けます。","job_id":"j2","task_id":"t1","created_at":"2026-10-21T01:46:00Z"}
        ]}
        """
        let items = NoticeInbox.decode(Data(body.utf8))
        XCTAssertEqual(items.map(\.kind), ["reminder", "scheduled_task"])
        XCTAssertNil(items[0].task_id)
        XCTAssertEqual(items[1].task_id, "t1")
    }

    func testOpensTheWorkListForAgentSessionNotices() {
        let body = #"{"items":[{"id":"n1","kind":"agent_session","title":"Claude Code が承認を待っています","body":"決済を直す（api）。ターミナルで確かめてください。","task_id":null}]}"#
        let item = NoticeInbox.decode(Data(body.utf8)).first
        XCTAssertEqual(item?.kind, "agent_session")
        XCTAssertEqual(NoticeInbox.section(kind: "agent_session", taskId: ""), .work)
        XCTAssertEqual(NoticeInbox.section(kind: "work_hold", taskId: ""), .work)
        XCTAssertEqual(NoticeInbox.section(kind: "task_followup", taskId: ""), .work)
        XCTAssertEqual(NoticeInbox.section(kind: "scheduled_task", taskId: "t1"), .work)
        XCTAssertEqual(NoticeInbox.section(kind: "reminder", taskId: ""), .home)
    }

    func testIgnoresBrokenBodies() {
        XCTAssertEqual(NoticeInbox.decode(Data("not json".utf8)), [])
        XCTAssertEqual(NoticeInbox.decode(Data("{\"items\":[{\"id\":1}]}".utf8)), [])
    }
}
