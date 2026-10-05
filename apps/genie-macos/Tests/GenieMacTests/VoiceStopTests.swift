import XCTest
@testable import GenieMac

/// U105「ちょっと待って、止めて」: 声で、動いている仕事を止める（取り消し＝元に戻す、ではない）。
@MainActor
final class VoiceStopTests: XCTestCase {
    override func setUp() { super.setUp(); GenieStateStore.shared.reset() }
    override func tearDown() { GenieStateStore.shared.reset(); super.tearDown() }

    func testSayingStopHaltsEveryRunningTaskAndSaysWhatStopped() {
        let store = GenieStateStore.shared
        let a = UUID(), b = UUID()
        var backendCancelled: [UUID] = []
        store.apply(store.event(a, .started(title: "提案書の修正", step: "書く")))
        store.apply(store.event(b, .started(title: "競合の調査", step: "調べる")))
        store.setStopHandler(a) { backendCancelled.append(a) }
        store.setStopHandler(b) { backendCancelled.append(b) }

        let said = VoiceHUDState.shared.stopWorkFromVoice()

        XCTAssertTrue(store.state.board.active.isEmpty, "every running task stops")
        XCTAssertEqual(Set(backendCancelled), [a, b], "the backend is asked to cancel each one")
        XCTAssertTrue(said.contains("2 件"))
        XCTAssertTrue(said.contains("元に戻してはいません"), "stopping is not undoing")
    }

    func testWithNothingRunningItSaysSo() {
        XCTAssertEqual(VoiceHUDState.shared.stopWorkFromVoice(), "いま動いている仕事はありません。")
    }
}
