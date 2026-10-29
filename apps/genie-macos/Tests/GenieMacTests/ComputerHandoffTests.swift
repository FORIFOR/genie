import XCTest
@testable import GenieMac

/// 画面操作の引き継ぎ（ComputerHandoff）。言い方と、helper・worker が読む印。
@MainActor
final class ComputerHandoffTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("handoff-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        ComputerHandoff.directoryOverride = directory
    }

    override func tearDown() async throws {
        ComputerHandoff.directoryOverride = nil
        try? FileManager.default.removeItem(at: directory)
    }

    func testHearsTakingOverAndGivingBack() {
        for said in ["ここから自分で操作する", "認証画面だけ自分で操作します", "あとは私がやる", "操作を代わって"] {
            XCTAssertEqual(ComputerHandoff.intent(said, handing: false), .take, said)
        }
        for said in ["続きお願い", "じゃあ続きをお願い", "続けて", "終わったよ", "ログインできたので続き"] {
            XCTAssertEqual(ComputerHandoff.intent(said, handing: true), .giveBack, said)
        }
        // 本人の番でないときの「続けて」はふだんの会話（奪わない）
        XCTAssertNil(ComputerHandoff.intent("続けて", handing: false))
        XCTAssertNil(ComputerHandoff.intent("続きお願い", handing: false))
        XCTAssertNil(ComputerHandoff.intent("自分で操作する方法を教えてほしいのですが、設定画面のどこから開けばいいですか", handing: false))
        XCTAssertNil(ComputerHandoff.intent("今日の予定は？", handing: true))
    }

    func testMarksOnlyOpenScreenSessionsAndRemovesTheMarkOnGiveBack() throws {
        let session = directory.appendingPathComponent("background-\(UUID().uuidString).json")
        try Data("{}".utf8).write(to: session)
        try Data("x".utf8).write(to: directory.appendingPathComponent("shot.png"))
        XCTAssertFalse(ComputerHandoff.handing)

        XCTAssertEqual(ComputerHandoff.take(), 1)
        XCTAssertTrue(ComputerHandoff.handing)
        // 送りかけの入力を失効させる印（人が触ったときと同じ）と、本人の番の印。中身は理由の語だけ
        XCTAssertEqual(try String(contentsOfFile: session.path + ".interrupted", encoding: .utf8), "human_takeover:handoff")
        XCTAssertEqual(try String(contentsOfFile: session.path + ".handoff", encoding: .utf8), "handoff")
        let mode = try FileManager.default.attributesOfItem(atPath: session.path + ".handoff")[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)

        XCTAssertEqual(ComputerHandoff.giveBack(), 1)
        XCTAssertFalse(ComputerHandoff.handing)
        XCTAssertFalse(FileManager.default.fileExists(atPath: session.path + ".handoff"))
        // 失効の印は helper が再開のときに消す（こちらで消して古い入力を通さない）
        XCTAssertTrue(FileManager.default.fileExists(atPath: session.path + ".interrupted"))
    }

    func testSaysSoWhenNothingIsBeingOperated() {
        XCTAssertEqual(ComputerHandoff.take(), 0)
        XCTAssertEqual(ComputerHandoff.answer(for: .take, sessions: 0), "いま Genie が操作している画面はありません。そのまま操作してください。")
        XCTAssertTrue(ComputerHandoff.answer(for: .giveBack, sessions: 1).contains("撮り直して"))
    }
}
