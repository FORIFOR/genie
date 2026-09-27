import XCTest
@testable import GenieMac

/// One Continuous Surface（段階 ①）: 音声と仕事を別々に持ち、一枚の面は純関数で決める。
@MainActor
final class ContinuousSurfaceTests: XCTestCase {
    private var headless = false

    override func setUp() {
        super.setUp()
        headless = WindowCoordinator.headless
        WindowCoordinator.headless = true
        GenieStateStore.shared.reset()
    }

    override func tearDown() {
        VoiceHUDState.shared.clearConversationForShot()
        GenieStateStore.shared.reset()
        WindowCoordinator.headless = headless
        super.tearDown()
    }

    private let artifact = DockArtifact(kind: "下書き", title: "移行ガイドの要約", detail: "312字", actions: [.openWorkspace, .copy])

    // MARK: 一覧（出来事の順序）

    func testStaleAndLateEventsAreDropped() {
        var board = DockTaskBoard()
        let id = UUID()
        XCTAssertTrue(board.apply(DockTaskEvent(taskId: id, rev: 1, kind: .started(title: "要約", step: "読む"))))
        XCTAssertTrue(board.apply(DockTaskEvent(taskId: id, rev: 3, kind: .step("まとめる"))))
        XCTAssertFalse(board.apply(DockTaskEvent(taskId: id, rev: 2, kind: .step("読む"))), "古い工程で巻き戻る")
        XCTAssertEqual(board.task(id)?.step, "まとめる")
        XCTAssertTrue(board.apply(DockTaskEvent(taskId: id, rev: 4, kind: .cancelled("止めました"))))
        XCTAssertFalse(board.apply(DockTaskEvent(taskId: id, rev: 5, kind: .succeeded(artifact))), "止めた仕事が成功に変わる")
        XCTAssertEqual(board.task(id)?.status, .cancelled("止めました"))
        XCTAssertFalse(board.apply(DockTaskEvent(taskId: UUID(), rev: 1, kind: .step("x"))), "知らない仕事の途中の出来事")
    }

    func testOneResultDoesNotEraseOtherRunningTasks() {
        let store = GenieStateStore.shared
        let a = UUID(), b = UUID()
        store.apply(store.event(a, .started(title: "要約", step: "読む")))
        store.apply(store.event(b, .started(title: "英訳", step: "訳す")))
        XCTAssertEqual(store.dock, .agent)
        store.apply(store.event(a, .succeeded(artifact)))
        guard case .result(let r) = store.dock else { return XCTFail("\(store.dock)") }
        XCTAssertEqual(r.title, "移行ガイドの要約")
        XCTAssertEqual(store.state.board.active.map(\.id), [b], "結果で他の仕事が消えた")
        store.dismissResult()
        XCTAssertEqual(store.dock, .agent, "結果を閉じたら、動いている仕事の面へ戻る")
        store.apply(store.event(b, .failed("接続できませんでした")))
        guard case .result(let failed) = store.dock else { return XCTFail() }
        XCTAssertTrue(failed.failed)
        XCTAssertEqual(failed.actions, [.retry])
    }

    // MARK: 合成（優先順）

    func testCompositionOrder() {
        let card = ActionConfirmation(title: "作成します", details: [], risk: .r2, confirmLabel: "作成する")
        let ack = DockAck(id: UUID(), title: "要約")
        var done = DockTask(id: UUID(), rev: 2, title: "要約", step: "", status: .succeeded(artifact), startedAt: Date())
        done.endedAt = Date()
        func c(_ r: DockPresentation, card: ActionConfirmation? = nil, ack: DockAck? = nil, result: DockTask? = nil,
               active: Int = 0, conversation: Bool = false) -> DockPresentation {
            DockComposer.compose(requested: r, confirmation: card, ack: ack, focusedResult: result,
                                 activeCount: active, conversationActive: conversation)
        }
        XCTAssertEqual(c(.listening(partial: "") , card: card, active: 2), .listening(partial: ""), "本人の聞き取りが先")
        XCTAssertEqual(c(.listening(partial: ""), card: card, conversation: true), .confirmation(card), "会話の聞き直しはカードを隠さない")
        XCTAssertEqual(c(.answer("a"), card: card, ack: ack), .confirmation(card))
        XCTAssertEqual(c(.idle, ack: ack, result: done, active: 1), .ack(ack))
        XCTAssertEqual(c(.quickActions, result: done, active: 1), .quickActions, "本人が開いた面が結果より先")
        guard case .result = c(.idle, result: done, active: 1) else { return XCTFail() }
        XCTAssertEqual(c(.idle, active: 1), .agent)
        XCTAssertEqual(c(.agent), .idle, "仕事が無いのに作業中にしない")
    }

    func testSucceededWithoutArtifactIsNotShownAsComplete() {
        // 成果物を確かめられない完了は、完了にしない（`taskReply` が needsInput にする → 失敗の結果）。
        let reply = VoiceHUDState.taskReply(status: "COMPLETED", artifactID: "") { "" }
        XCTAssertNotEqual(reply.phase, .complete)
        let id = UUID()
        let store = GenieStateStore.shared
        store.apply(store.event(id, .started(title: "下書き", step: "作業中")))
        VoiceHUDState.shared.finishOnDock(id, reply: reply, title: "下書き")
        guard case .result(let r) = store.dock else { return XCTFail() }
        XCTAssertTrue(r.failed, "成果物の無い完了を ✓ にした")
    }

    // MARK: 受付・結果の保持

    func testAckAndRejection() {
        let store = GenieStateStore.shared
        store.showAck(DockAck(id: UUID(), title: "要約", rejected: "下書きの保存先が設定されていません。"))
        guard case .ack(let a) = store.dock else { return XCTFail() }
        XCTAssertNotNil(a.rejected)
        store.dismissResult()
        XCTAssertEqual(store.dock, .idle)
    }

    func testResultHoldPolicy() {
        XCTAssertEqual(DockResultPolicy.holdSeconds(for: .succeeded(artifact)), 8)
        XCTAssertEqual(DockResultPolicy.holdSeconds(for: .cancelled("x")), 3)
        XCTAssertNil(DockResultPolicy.holdSeconds(for: .failed("x")), "失敗は閉じるまで残す")
    }

    func testCancelledResultShrinksAfterItsHoldButNotWhileHovered() async throws {
        let store = GenieStateStore.shared
        let id = UUID()
        store.setHovering(true)
        store.apply(store.event(id, .started(title: "英訳", step: "訳す")))
        store.stopTask(id)
        guard case .result(let r) = store.dock else { return XCTFail() }
        XCTAssertTrue(r.cancelled)
        try await Task.sleep(nanoseconds: 3_300_000_000)
        guard case .result = store.dock else { return XCTFail("ホバー中に縮めた") }
        store.setHovering(false)
        try await Task.sleep(nanoseconds: 3_300_000_000)
        XCTAssertEqual(store.dock, .idle)
    }
}
