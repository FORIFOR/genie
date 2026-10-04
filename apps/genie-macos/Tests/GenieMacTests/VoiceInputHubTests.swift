import XCTest
@testable import GenieMac

private final class FakeDetector: WakeDetector {
    var fireOn: Float = 9
    var seen = 0
    func process(_ frame: [Float]) -> Bool { seen += 1; return frame.first == fireOn }
    func reset() {}
}

final class VoiceInputHubTests: XCTestCase {
    private func frame(_ marker: Float, seconds: Double = 0.1) -> [Float] {
        [marker] + Array(repeating: 0, count: Int(seconds * VoiceInputHub.sampleRate) - 1)
    }

    func testTheWordsAroundTheCallReachTheConversationInOrder() throws {
        let hub = VoiceInputHub(mic: nil)
        let detector = FakeDetector()
        var woke = false
        try hub.startStandby(detector: detector) { woke = true }
        hub.inject(frame(1))
        hub.inject(frame(9))           // 「ジーニー」で検出
        XCTAssertEqual(hub.state, .holding)
        hub.inject(frame(2))           // 接続を待つ間に「ブラウザを開いて」
        var sent: [Float] = []
        try hub.attach { sent.append($0[0]) }
        hub.inject(frame(3))           // つながった後
        XCTAssertEqual(sent, [1, 9, 2, 3], "nothing said around the call may be lost or reordered")
        let exp = expectation(description: "wake is reported on main")
        DispatchQueue.main.async { exp.fulfill() }
        wait(for: [exp], timeout: 1)
        XCTAssertTrue(woke)
    }

    func testOnlyAShortStretchBeforeTheCallIsKept() throws {
        let hub = VoiceInputHub(mic: nil)
        try hub.startStandby(detector: FakeDetector()) {}
        for _ in 0..<50 { hub.inject(frame(5)) }   // 5 秒の待機音
        hub.inject(frame(9))
        var seconds = 0.0
        try hub.attach { seconds += Double($0.count) / VoiceInputHub.sampleRate }
        XCTAssertLessThanOrEqual(seconds, VoiceInputHub.prerollSeconds + 0.001,
                                 "standby audio older than the pre-roll is never sent")
    }

    func testDuringTheConversationTheDetectorRestsAndGeniesOwnVoiceIsNotSent() throws {
        let hub = VoiceInputHub(mic: nil)
        let detector = FakeDetector()
        try hub.startStandby(detector: detector) {}
        hub.simulateWake()
        var sent = 0
        try hub.attach { _ in sent += 1 }
        let before = detector.seen
        hub.inject(frame(9))
        XCTAssertEqual(detector.seen, before, "no wake detection while talking")
        hub.pause()                     // Genie が話している間
        hub.inject(frame(4))
        XCTAssertEqual(sent, 1)
        hub.detach()                    // 会話が終わったら待機へ
        XCTAssertEqual(hub.state, .standby)
    }

    func testWithoutADetectorTheMicrophoneIsNotKeptOpen() throws {
        let hub = VoiceInputHub(mic: nil)
        try hub.attach { _ in }
        hub.detach()
        XCTAssertEqual(hub.state, .off)
    }
}
