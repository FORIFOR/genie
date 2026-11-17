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

    func testPutsAgentSessionsThatNeedTheUserFirstAndSaysWhatTheyWaitFor() {
        func row(_ id: String, _ state: String, _ attention: String, reason: String? = nil,
                 policy: String = "watch", title: String? = "頼み", project: String? = "genie") -> String {
            #"{"id":"\#(id)","source":"claude_code","external_session_id":"x","project":\#(project.map { "\"\($0)\"" } ?? "null"),"title":\#(title.map { "\"\($0)\"" } ?? "null"),"state":"\#(state)","waiting_reason":\#(reason.map { "\"\($0)\"" } ?? "null"),"user_policy":"\#(policy)","attention":"\#(attention)","confidence":"confirmed","last_activity_at":"2026-10-28T05:00:00.000Z"}"#
        }
        let body = "{\"items\":[" + [
            row("ended", "ended", "ended"),
            row("work", "working", "working"),
            row("idle", "idle", "idle", title: nil),
            row("paused", "waiting_user", "paused", reason: "permission", policy: "paused_by_user"),
            row("stall", "working", "stalled_suspected"),
            row("perm", "waiting_user", "needs_user", reason: "permission"),
            row("input", "waiting_user", "needs_user", reason: "input"),
            row("error", "error", "needs_user", project: nil),
        ].joined(separator: ",") + "]}"
        let items = AgentSessionsBoard.decode(Data(body.utf8))
        XCTAssertEqual(items.map(\.id), ["perm", "input", "error", "stall", "work", "idle", "paused", "ended"])
        let by = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        XCTAssertEqual(by["perm"]?.stateLine, "承認を待っています")
        XCTAssertEqual(by["input"]?.stateLine, "あなたの返事を待っています")
        XCTAssertEqual(by["error"]?.stateLine, "うまくいかずに止まりました")
        XCTAssertEqual(by["error"]?.origin, "Claude Code")
        // 推した状態は「かもしれません」と言い、確かな状態と言い分ける
        XCTAssertTrue(by["stall"]?.stateLine.contains("かもしれません") == true)
        // 応答を終えただけ。終わった扱いにしない
        XCTAssertEqual(by["idle"]?.stateLine, "応答を終えて、次の頼みを待っています")
        XCTAssertEqual(by["idle"]?.name, "genie")
        // 本人が止めたら、承認待ちでも返事が要るとは言わない
        XCTAssertEqual(by["paused"]?.stateLine, "見守りを止めています")
        XCTAssertFalse(by["paused"]?.needsUser == true)
        XCTAssertEqual(by["perm"]?.origin, "Claude Code · genie")
        XCTAssertEqual(AgentSessionsBoard.decode(Data("nope".utf8)), [])
    }

    func testSaysHeldUnknownAndCheckedSessionsApart() {
        func row(_ id: String, _ state: String, _ attention: String, check: String? = nil,
                 policy: String = "watch") -> String {
            #"{"id":"\#(id)","source":"claude_code","project":"genie","title":"頼み","state":"\#(state)","waiting_reason":null,"user_policy":"\#(policy)","attention":"\#(attention)","last_activity_at":"2026-10-28T05:00:00.000Z"\#(check.map { ",\"check_state\":\"\($0)\"" } ?? "")}"#
        }
        let body = "{\"items\":[" + [
            row("passed", "idle", "idle", check: "passed"),
            row("changed", "idle", "idle", check: "changed"),
            row("held", "waiting_user", "held", policy: "paused_by_user"),
            row("unknown", "working", "unknown"),
            row("failed", "idle", "idle", check: "failed"),
            row("old", "idle", "idle"),
        ].joined(separator: ",") + "]}"
        let items = AgentSessionsBoard.decode(Data(body.utf8))
        // 最後のテストが失敗したものは返事が要るものと同じく上に。保留は止めたものと並べて下に
        XCTAssertEqual(items.map(\.id), ["failed", "unknown", "passed", "changed", "old", "held"])
        let by = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        XCTAssertEqual(by["passed"]?.stateLine, "応答を終えました（テストが通っています）")
        XCTAssertEqual(by["changed"]?.stateLine, "応答を終えました（変更をまだテストで確かめていません）")
        XCTAssertEqual(by["failed"]?.stateLine, "応答を終えましたが、最後のテストが失敗しています")
        XCTAssertTrue(by["failed"]?.needsUser == true)
        // 古い gateway（check_state なし）は今までどおり
        XCTAssertEqual(by["old"]?.stateLine, "応答を終えて、次の頼みを待っています")
        XCTAssertEqual(by["held"]?.stateLine, "保留中（知らせません）")
        XCTAssertFalse(by["held"]?.needsUser == true)
        XCTAssertTrue(by["held"]?.quiet == true)
        // 何も届かなくなったものを終わったとも止まったとも言わない
        XCTAssertEqual(by["unknown"]?.stateLine, "しばらく何も届いていないので、いまの状態は分かりません")
    }

    func testSummarisesTheWorkOverviewWithoutZeroCounts() {
        let body = #"{"counts":{"running":3,"needs_user":2,"suspected":0,"held":1,"done_today":0},"attention":["a","b"],"text":"…"}"#
        let overview = WorkOverviewBoard.decode(Data(body.utf8))
        XCTAssertEqual(overview?.summary, "確かめてほしいもの 2 件 ・ 動いているもの 3 件 ・ 保留 1 件")
        XCTAssertEqual(overview?.attention, ["a", "b"])
        let empty = #"{"counts":{"running":0,"needs_user":0,"suspected":0,"held":0,"done_today":0},"attention":[],"text":"x"}"#
        XCTAssertNil(WorkOverviewBoard.decode(Data(empty.utf8))?.summary)
        XCTAssertNil(WorkOverviewBoard.decode(Data("nope".utf8)))
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
