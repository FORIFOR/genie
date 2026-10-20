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

    func testWhatFollowsTheCallIsCollectedForTheSpeakerCheck() throws {
        let hub = VoiceInputHub(mic: nil)
        try hub.startStandby(detector: FakeDetector()) {}
        hub.inject(frame(1))
        hub.inject(frame(9))           // 「ジーニー」で検出
        let got = expectation(description: "collected")
        var collected: [Float] = []
        hub.collectAfterWake(seconds: 0.2) { collected = $0; got.fulfill() }
        hub.inject(frame(2))           // 接続を待つ間
        try hub.attach { _ in }
        hub.inject(frame(3))           // つながった後
        hub.inject(frame(4))           // 足りた後は集めない
        wait(for: [got], timeout: 1)
        // 呼びかけの前の音は入らず、後の 0.2 秒だけ
        XCTAssertEqual(collected.count, 3_200)
        XCTAssertEqual([collected[0], collected[1_600]], [2, 3])
    }

    /// 会話で送った音は、時刻つきで手元に残る（Gemini が文字にしなかった続きを文字にし直すため）。会話を外せば消える。
    func testStreamedAudioIsKeptWithItsTime() throws {
        let hub = VoiceInputHub(mic: nil)
        try hub.startStandby(detector: FakeDetector()) {}
        hub.inject(frame(9))
        try hub.attach { _ in }
        hub.inject(frame(1))
        usleep(5_000)   // 時刻で分けるので、前後の音の時刻を離す
        let mark = Date()
        usleep(5_000)
        hub.inject(frame(2))
        hub.inject(frame(3))
        let after = hub.streamed(since: mark)
        XCTAssertEqual(after.count, 3_200)
        XCTAssertEqual([after[0], after[1_600]], [2, 3])
        hub.detach()
        XCTAssertTrue(hub.streamed(since: .distantPast).isEmpty)
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

    func testItTellsANameOnlyCallFromOneThatKeepsTalking() throws {
        let quiet = VoiceInputHub(mic: nil)
        try quiet.startStandby(detector: FakeDetector()) {}
        quiet.inject(frame(9))                                  // 検出
        for _ in 0..<9 { quiet.inject(Array(repeating: 0.001, count: 1600)) }   // 0.9 秒の静けさ
        XCTAssertLessThan(quiet.speechSinceWake().speech, 0.25)

        let talking = VoiceInputHub(mic: nil)
        try talking.startStandby(detector: FakeDetector()) {}
        talking.inject(frame(9))
        for _ in 0..<9 { talking.inject(Array(repeating: 0.2, count: 1600)) }   // 続けて話している
        XCTAssertGreaterThan(talking.speechSinceWake().speech, 0.25)
    }

    func testWithoutADetectorTheMicrophoneIsNotKeptOpen() throws {
        let hub = VoiceInputHub(mic: nil)
        try hub.attach { _ in }
        hub.detach()
        XCTAssertEqual(hub.state, .off)
    }

    /// 会話の後の開き直しで音が来なくなったマイクを見つける（genie.log 2026-10-16 05:20Z から 1.5 時間無音）。
    func testStalledMicIsDetectedOnlyWhileOpenAndNotSpeaking() {
        let t = Date()
        let late = t.addingTimeInterval(VoiceInputHub.stallSeconds + 0.1)
        XCTAssertTrue(VoiceInputHub.micStalled(state: .standby, running: true, lastFrame: t, now: late))
        XCTAssertTrue(VoiceInputHub.micStalled(state: .streaming, running: true, lastFrame: t, now: late))
        XCTAssertFalse(VoiceInputHub.micStalled(state: .standby, running: true, lastFrame: t, now: t.addingTimeInterval(1)))
        XCTAssertFalse(VoiceInputHub.micStalled(state: .paused, running: true, lastFrame: t, now: late))
        XCTAssertFalse(VoiceInputHub.micStalled(state: .off, running: false, lastFrame: t, now: late))
        // 開き直しに失敗して閉じたままの待ち受けも、開き直す対象（genie.log 2026-10-16 07:27Z -10875 のあと翌日まで無反応）。
        XCTAssertTrue(VoiceInputHub.micStalled(state: .standby, running: false, lastFrame: t, now: late))
        XCTAssertFalse(VoiceInputHub.micStalled(state: .standby, running: false, lastFrame: t, now: t.addingTimeInterval(1)))
    }

    /// 会話が終わった後に届いた声で、待ち受けにエコー除去を入れない（genie.log 2026-10-18 16:28Z）。
    func testEchoCancellationOnlyDuringAConversation() {
        XCTAssertTrue(VoiceInputHub.echoCancellationAllowed(state: .streaming))
        XCTAssertTrue(VoiceInputHub.echoCancellationAllowed(state: .paused))
        XCTAssertTrue(VoiceInputHub.echoCancellationAllowed(state: .holding))
        XCTAssertFalse(VoiceInputHub.echoCancellationAllowed(state: .standby))
        XCTAssertFalse(VoiceInputHub.echoCancellationAllowed(state: .off))
    }
}
