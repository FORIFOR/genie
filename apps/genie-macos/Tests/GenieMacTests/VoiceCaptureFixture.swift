@testable import GenieMac

/// Device-free capture with real open/close state; no microphone or Speech API calls.
@MainActor
final class VoiceCaptureFixture {
    private(set) var opens = 0
    private(set) var closes = 0
    private(set) var listening = false

    var input: VoiceCaptureInput {
        VoiceCaptureInput(begin: { [self] _, firstFrame, _, _ in
            opens += 1
            listening = true
            firstFrame()
            return true
        }, end: { [self] in
            if listening { closes += 1 }
            listening = false
        }, isListening: { [self] in listening })
    }
}
