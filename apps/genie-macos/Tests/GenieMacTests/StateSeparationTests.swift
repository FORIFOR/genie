import XCTest
@testable import GenieMac

/// 段階 1: 会話・仕事・表示を分ける。表示は活動状態を決めない。発話は黙って消えない。
/// 閉じた後に遅れて届いた確定文で、依頼は送られない。
@MainActor
final class StateSeparationTests: XCTestCase {
    private var headless = false

    override func setUp() {
        super.setUp()
        headless = WindowCoordinator.headless
        WindowCoordinator.headless = true
        GenieStateStore.shared.reset()
    }

    override func tearDown() {
        GenieStateStore.shared.reset()
        WindowCoordinator.headless = headless
        super.tearDown()
    }

    private func runningTask() -> AgentTask {
        AgentTask(id: UUID(), title: "見出しの修正", status: .running,
                  steps: [AgentStep(title: "修正", tool: "agent", detail: "変更を検証中", state: .running)],
                  startedAt: Date(), context: ContextBundle())
    }

    func testAnAnswerShownWhileWorkRunsDoesNotMarkTheWorkComplete() {
        let store = GenieStateStore.shared
        store.startTask(runningTask())
        XCTAssertEqual(store.state.mode, .acting)
        store.setDock(.answer("金曜日の15時です。"))
        XCTAssertEqual(store.dock, .answer("金曜日の15時です。"))
        XCTAssertEqual(store.state.mode, .acting, "回答を出しても、動いている仕事は完了にならない")
        store.finishTask(.success)
        store.setDock(.answer("金曜日の15時です。"))
        XCTAssertEqual(store.state.mode, .completed)
    }

    func testEventsOutrankThePresentation() {
        let store = GenieStateStore.shared
        store.meetingStarted(id: "m1")
        store.setDock(.answer("要点です"))
        XCTAssertEqual(store.state.mode, .meeting, "会議中は回答を出しても会議のまま")
        store.meetingEnded()

        store.startTask(runningTask())
        store.setDock(.listening(partial: ""))
        XCTAssertEqual(store.state.mode, .listening, "いまの会話は仕事の進捗より前")

        let card = ActionConfirmation(title: "送信します", details: [], risk: .r3, confirmLabel: "送信")
        XCTAssertTrue(store.requireConfirmation(card))
        store.setDock(.answer("別の回答"))
        XCTAssertEqual(store.dock, .confirmation(card), "確認カードを上書きしない")
        XCTAssertEqual(store.state.mode, .awaitingConfirmation)
        store.resolveConfirmation(id: card.id, approved: false)
        XCTAssertEqual(store.dock, .answer("別の回答"), "答えが済んだら頼まれていた表示へ戻る")
        XCTAssertEqual(store.state.mode, .acting, "仕事はまだ動いている")
    }

    func testAnUtteranceDuringABusyRequestIsHeldNotDropped() {
        let hud = VoiceHUDState.shared
        _ = hud.takeHeldUtterance()
        hud.mode = .listening(partial: "明日の天気は")
        hud.hold("明日の天気は？")
        XCTAssertEqual(hud.heldUtterance, "明日の天気は？")
        XCTAssertEqual(hud.mode, .thinking, "マイクの閉じた Listening に取り残さない")
        XCTAssertTrue(hud.answer.contains("まだ送っていません"))
        XCTAssertEqual(hud.takeHeldUtterance(), "明日の天気は？", "次の Listening で入力欄へ戻す")
        XCTAssertNil(hud.heldUtterance)
    }

    func testLateCallbacksFromAClosedMicrophoneAreIgnored() {
        var voice = VoiceGeneration()
        let first = voice.open()
        XCTAssertTrue(voice.isCurrent(first))
        voice.close()
        XCTAssertFalse(voice.isCurrent(first), "閉じた後に届いた確定文は古い世代")
        let second = voice.open()
        XCTAssertFalse(voice.isCurrent(first), "開き直しても前の世代は生き返らない")
        XCTAssertTrue(voice.isCurrent(second))
    }

    func testCancellingListeningClosesTheMicrophoneEvenWhenTheDockMovedOn() {
        let hud = VoiceHUDState.shared
        let before = hud.voice
        hud.mode = .thinking
        hud.cancelListening()
        XCTAssertNotEqual(hud.voice, before, "表示が Listening でなくてもマイクの世代は進む")
        XCTAssertEqual(hud.mode, .thinking, "Listening でない表示は変えない")
    }
}
