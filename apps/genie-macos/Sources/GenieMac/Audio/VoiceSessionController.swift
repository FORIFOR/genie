import Foundation
import SwiftUI

/// A bounded, explicit hands-free conversation window.
///
/// Voice sessions are deliberately different from meeting recording:
/// - the user explicitly enters the session from the Dock / shortcut / future wake word;
/// - silence does not become an action by itself;
/// - background tasks may outlive the voice session;
/// - the microphone is not a permanent authority to control the computer.
///
/// The first shipping policy is intentionally conservative: five minutes maximum,
/// 90 seconds of inactivity, and a short grace period after recent speech.
struct VoiceSessionPolicy: Equatable {
    var maximumDuration: TimeInterval = 5 * 60
    var idleTimeout: TimeInterval = 90
    var recentSpeechGrace: TimeInterval = 12

    func expiry(startedAt: Date, lastActivityAt: Date) -> Date {
        min(startedAt.addingTimeInterval(maximumDuration),
            lastActivityAt.addingTimeInterval(idleTimeout))
    }

    func remaining(startedAt: Date, lastActivityAt: Date, now: Date) -> TimeInterval {
        max(0, expiry(startedAt: startedAt, lastActivityAt: lastActivityAt).timeIntervalSince(now))
    }

    func shouldRemainActive(startedAt: Date, lastActivityAt: Date, now: Date) -> Bool {
        remaining(startedAt: startedAt, lastActivityAt: lastActivityAt, now: now) > 0
    }
}

@MainActor
final class VoiceSessionController: ObservableObject {
    static let shared = VoiceSessionController()

    enum Phase: String, Equatable {
        case inactive
        case preparing
        case listening
        case processing
        case speaking
        case backgroundWork
    }

    @Published private(set) var phase: Phase = .inactive
    @Published private(set) var startedAt: Date?
    @Published private(set) var lastActivityAt: Date?
    @Published private(set) var remainingSeconds: Int = 0

    let policy: VoiceSessionPolicy
    private var ticker: Task<Void, Never>?

    init(policy: VoiceSessionPolicy = VoiceSessionPolicy()) {
        self.policy = policy
    }

    var isActive: Bool { phase != .inactive }

    var remainingText: String {
        let seconds = max(0, remainingSeconds)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// All entry points (Dock, shortcut, future wake word) converge here.
    func start(source: String = "dock", now: Date = Date()) {
        if isActive {
            touch(now: now)
            return
        }
        startedAt = now
        lastActivityAt = now
        phase = .preparing
        recalculate(now: now)
        GenieEventBus.shared.publish(.voiceSessionStarted(source: source))
        startTicker()
    }

    func markListening(now: Date = Date()) {
        guard isActive else { return }
        phase = .listening
        touch(now: now)
    }

    func markProcessing(now: Date = Date()) {
        guard isActive else { return }
        phase = .processing
        touch(now: now)
    }

    func markSpeaking(now: Date = Date()) {
        guard isActive else { return }
        phase = .speaking
        touch(now: now)
    }

    /// Agent work is allowed to continue after the microphone session ends.
    func markBackgroundWork(now: Date = Date()) {
        guard isActive else { return }
        phase = .backgroundWork
        touch(now: now)
    }

    func touch(now: Date = Date()) {
        guard let startedAt else { return }
        lastActivityAt = now
        remainingSeconds = Int(ceil(policy.remaining(
            startedAt: startedAt,
            lastActivityAt: now,
            now: now
        )))
    }

    func stop(reason: String = "user") {
        guard isActive else { return }
        ticker?.cancel()
        ticker = nil
        phase = .inactive
        startedAt = nil
        lastActivityAt = nil
        remainingSeconds = 0
        GenieEventBus.shared.publish(.voiceSessionEnded(reason: reason))
    }

    private func startTicker() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled, let self else { return }
                self.recalculate(now: Date())
            }
        }
    }

    private func recalculate(now: Date) {
        guard let startedAt, let lastActivityAt else { return }
        let remaining = policy.remaining(
            startedAt: startedAt,
            lastActivityAt: lastActivityAt,
            now: now
        )
        remainingSeconds = Int(ceil(remaining))
        if remaining <= 0 {
            RecordingRuntime.shared.endVoiceListening()
            stop(reason: "timeout")
        }
    }
}
