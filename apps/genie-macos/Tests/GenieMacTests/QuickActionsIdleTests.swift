import XCTest
@testable import GenieMac

@MainActor
final class QuickActionsIdleTests: XCTestCase {
    private var headless = false
    private let store = GenieStateStore.shared

    override func setUp() {
        super.setUp()
        headless = WindowCoordinator.headless
        WindowCoordinator.headless = true
        store.reset()
    }

    override func tearDown() {
        VoiceHUDState.shared.clearConversationForShot()
        store.reset()
        WindowCoordinator.headless = headless
        super.tearDown()
    }

    private func open(at now: TimeInterval = 100) -> Int {
        store.setDock(.quickActions)
        store.noteQuickActionsInteraction(now: now)
        return store.quickActionsGeneration
    }

    func testOnlyCollapsesAfterThirtySeconds() {
        let generation = open()
        XCTAssertEqual(GenieStateStore.quickActionsIdleInterval, 30)
        store.expireQuickActions(generation: generation, now: 129.999)
        XCTAssertEqual(store.dock, .quickActions)
        store.expireQuickActions(generation: generation, now: 130)
        XCTAssertEqual(store.dock, .idle)
        XCTAssertEqual(store.state.requested, .idle)
    }

    func testInputRenewsDeadlineAndRejectsAlreadyQueuedTimeout() {
        let old = open()
        store.noteQuickActionsInteraction(now: 120)
        let current = store.quickActionsGeneration
        store.expireQuickActions(generation: old, now: 140)
        store.expireQuickActions(generation: current, now: 149.999)
        XCTAssertEqual(store.dock, .quickActions)
        store.expireQuickActions(generation: current, now: 150)
        XCTAssertEqual(store.dock, .idle)
    }

    func testCloseAndReopenCannotBeClosedByOldTimer() {
        let old = open()
        store.setDock(.idle)
        let current = open(at: 200)
        store.expireQuickActions(generation: old, now: 1000)
        XCTAssertEqual(store.dock, .quickActions)
        store.expireQuickActions(generation: current, now: 230)
        XCTAssertEqual(store.dock, .idle)
    }

    func testOtherSurfacesAndTheirInputDoNotUseQuickActionsTimeout() {
        for surface: DockPresentation in [.listening(partial: ""), .thinking,
                                          .meeting(expanded: nil), .enteringRecording,
                                          .answer("回答"), .contextDetail] {
            let old = open()
            store.setDock(surface)
            let generation = store.quickActionsGeneration
            store.noteQuickActionsInteraction(now: 200)
            XCTAssertEqual(store.quickActionsGeneration, generation)
            store.expireQuickActions(generation: old, now: 1000)
            XCTAssertEqual(store.dock, surface)
        }
    }

    func testConversationSurvivesAnOldQuickActionsTimeout() {
        let old = open()
        VoiceHUDState.shared.presentConversationForShot(ending: false)
        store.setDock(.listening(partial: ""))
        store.expireQuickActions(generation: old, now: 1000)
        XCTAssertTrue(VoiceHUDState.shared.conversation.isActive)
        XCTAssertEqual(store.dock, .listening(partial: ""))
    }

    func testConfirmationIsNotDismissedAndRestoredMenuGetsNewTimeout() {
        let old = open()
        let confirmation = ActionConfirmation(title: "確認", details: [], risk: .r2, confirmLabel: "確認する")
        XCTAssertTrue(store.requireConfirmation(confirmation))
        store.expireQuickActions(generation: old, now: 1000)
        XCTAssertEqual(store.state.confirmation?.id, confirmation.id)
        XCTAssertEqual(store.dock, .confirmation(confirmation))
        store.resolveConfirmation(id: confirmation.id, approved: false)
        XCTAssertEqual(store.dock, .quickActions)
        XCTAssertNotEqual(store.quickActionsGeneration, old)
        store.expireQuickActions(generation: old, now: 2000)
        XCTAssertEqual(store.dock, .quickActions)
    }

    func testTimeoutRevealsRunningWorkWithoutCancellingIt() {
        let task = AgentTask(id: UUID(), title: "確認中", status: .running,
                             steps: [], startedAt: Date(), context: ContextBundle())
        var stops = 0
        store.startTask(task, onStop: { stops += 1 })
        let generation = open()
        store.expireQuickActions(generation: generation, now: 130)
        XCTAssertEqual(store.dock, .agent)
        XCTAssertEqual(store.state.activeTask?.status, .running)
        XCTAssertEqual(stops, 0)
    }

    func testResetInvalidatesTimeoutBeforeANewMenu() {
        let old = open()
        store.reset()
        _ = open(at: 200)
        store.expireQuickActions(generation: old, now: 1000)
        XCTAssertEqual(store.dock, .quickActions)
    }
}
