import XCTest
@testable import GenieMac

/// Task Dock のやめ方（2026-09-28）。止めるは仕事を止め、音声の停止とは別。
/// 面を差し替えたら、止める手の無い面の裏でマイクや会話を続けない。
@MainActor
final class TaskDockCancelTests: XCTestCase {
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

    private func runningTask() -> AgentTask {
        AgentTask(id: UUID(), title: "要約", status: .running,
                  steps: [AgentStep(title: "読む", tool: "agent", state: .success),
                          AgentStep(title: "まとめる", tool: "agent", state: .running)],
                  startedAt: Date(), context: ContextBundle())
    }

    func testStopAsksTheOwnerOnceAndShowsCancelledNotSuccess() {
        let store = GenieStateStore.shared
        var stops = 0
        store.startTask(runningTask(), onStop: { stops += 1 })
        store.stopTask()
        store.stopTask()
        XCTAssertEqual(stops, 1, "止める処理は一度だけ")
        XCTAssertEqual(store.state.activeTask?.status, .failed)
        XCTAssertEqual(store.state.activeTask?.steps.last?.detail, Facts.taskCancelled)
        guard case .result(let result) = store.dock else { return XCTFail("結果の面にならない: \(store.dock)") }
        XCTAssertTrue(result.failed, "止めた仕事に ✓ を付けない")
        XCTAssertTrue(result.detail?.contains(Facts.taskCancelled) == true)
    }

    func testLateSuccessAfterStopDoesNotRewriteTheResult() {
        let store = GenieStateStore.shared
        let task = runningTask()
        store.startTask(task)
        store.stopTask()
        store.updateStep(task.steps[1].id, to: .success)
        store.finishTask(.success)
        XCTAssertEqual(store.state.activeTask?.status, .failed)
        XCTAssertEqual(store.state.activeTask?.steps.last?.state, .failed)
        guard case .result(let result) = store.dock else { return XCTFail() }
        XCTAssertTrue(result.failed)
    }

    func testReplacingTheSurfaceEndsTheConversation() {
        let hud = VoiceHUDState.shared
        for surface: DockPresentation in [.quickActions, .idle, .agent, .contextDetail] {
            hud.presentConversationForShot(ending: false)
            XCTAssertTrue(hud.conversation.isActive)
            hud.mode = surface
            XCTAssertFalse(hud.conversation.isActive, "\(surface) には会話の行が無い。裏で会話を続けない")
        }
    }

    func testConversationSurfacesKeepTheConversation() {
        let hud = VoiceHUDState.shared
        hud.presentConversationForShot(ending: false)
        for surface: DockPresentation in [.thinking, .answer("はい"), .listening(partial: "")] {
            hud.mode = surface
            XCTAssertTrue(hud.conversation.isActive, "\(surface) は会話の行を出す")
        }
    }

    func testQuickActionsAndEscapeFromThinkingEndTheConversation() {
        let hud = VoiceHUDState.shared
        hud.presentConversationForShot(ending: false)
        hud.mode = .idle   // 待機に落ちた面から Dock を押す
        hud.presentConversationForShot(ending: false)
        hud.toggleQuickActions()
        XCTAssertFalse(hud.conversation.isActive)
        XCTAssertEqual(hud.mode, .quickActions)

        hud.presentConversationForShot(ending: false)
        hud.mode = .thinking
        hud.leaveThinking()
        XCTAssertFalse(hud.conversation.isActive)
        XCTAssertEqual(hud.mode, .idle)
    }

    func testListeningSurfaceIsReportedForLateAnswers() {
        let hud = VoiceHUDState.shared
        hud.mode = .listening(partial: "")
        XCTAssertTrue(hud.isListeningSurface)
        hud.mode = .idle
        XCTAssertFalse(hud.isListeningSurface)
    }
}
