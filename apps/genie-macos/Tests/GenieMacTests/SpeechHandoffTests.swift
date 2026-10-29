import XCTest
@testable import GenieMac

/// 会議の文字起こしは、オンデバイスの認識 1 本に「話している方」の声を流す（2026-10-27: この Mac では
/// 2 本目を開くと 1 本目が `1110 No speech detected` で切れ、3 回で「使えません」と出ていた）。
final class SpeechHandoffTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    func testFirstVoiceTakesTheRecognizer() {
        XCTAssertTrue(RecordingRuntime.takesSpeech(.remoteAudio, owner: nil, ownerVoiceAt: .distantPast, now: t0))
    }

    func testTheSameSpeakerKeepsIt() {
        XCTAssertTrue(RecordingRuntime.takesSpeech(.localUser, owner: .localUser, ownerVoiceAt: t0, now: t0.addingTimeInterval(0.1)))
    }

    func testTheOtherSpeakerWaitsUntilTheCurrentOneFallsSilent() {
        XCTAssertFalse(RecordingRuntime.takesSpeech(.remoteAudio, owner: .localUser, ownerVoiceAt: t0, now: t0.addingTimeInterval(0.5)))
        XCTAssertTrue(RecordingRuntime.takesSpeech(
            .remoteAudio, owner: .localUser, ownerVoiceAt: t0,
            now: t0.addingTimeInterval(RecordingRuntime.speakerHandoff + 0.1)))
    }

    func testInterruptedMessageIsNotTheUnavailableOne() {
        XCTAssertNotEqual(Facts.transcriptionInterrupted, Facts.transcriptionOnDeviceUnavailable)
        XCTAssertTrue(Facts.transcriptionInterrupted.contains("音声は保存されています"))
    }
}
