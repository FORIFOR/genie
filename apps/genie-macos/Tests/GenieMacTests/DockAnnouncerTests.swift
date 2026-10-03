import XCTest
@testable import GenieMac

/// 状態を動きや色だけで伝えない: 変わり目を VoiceOver に言う。言わない面では黙る。
final class DockAnnouncerTests: XCTestCase {
    func testAnnouncesTheTurningPointsOnly() {
        XCTAssertEqual(DockAnnouncer.text(for: .ack(DockAck(id: UUID(), title: "要約")), previous: .thinking, activeCount: 1),
                       "かしこまりました。要約")
        XCTAssertEqual(DockAnnouncer.text(for: .ack(DockAck(id: UUID(), title: "要約", rejected: "保存先がありません。")), previous: .thinking, activeCount: 0),
                       "この依頼は実行できません。保存先がありません。")
        XCTAssertEqual(DockAnnouncer.text(for: .result(AgentResult(title: "移行ガイド", actions: [], kind: "下書き")), previous: .agent, activeCount: 0),
                       "下書きができました。移行ガイド")
        XCTAssertEqual(DockAnnouncer.text(for: .result(AgentResult(title: "英訳", actions: [], failed: true, cancelled: true)), previous: .agent, activeCount: 0),
                       "止めました。英訳")
        XCTAssertEqual(DockAnnouncer.text(for: .agent, previous: .idle, activeCount: 2), "Genie: 2件 実行中")
        XCTAssertNil(DockAnnouncer.text(for: .agent, previous: .agent, activeCount: 3), "作業中のまま件数が変わるたびには言わない")
        XCTAssertNil(DockAnnouncer.text(for: .listening(partial: ""), previous: .idle, activeCount: 0))
        XCTAssertNil(DockAnnouncer.text(for: .thinking, previous: .listening(partial: "x"), activeCount: 0))
        XCTAssertNil(DockAnnouncer.text(for: .idle, previous: .agent, activeCount: 0))
    }
}
