import Foundation

/// §28 Module 間を直接依存させないための一本道。
///
/// これが無いと「Presence が Dock を直接触る」「Meeting が Workspace を直接開く」が増え、
/// どこが状態を変えたのか追えなくなる。状態を変えるのは `GenieStateStore` だけ、
/// 変わったことを知らせるのはここだけ、という分担にする。
enum GenieEvent: Equatable {
    case appChanged(bundleId: String?, name: String)
    case focusChanged(role: String?)
    case selectionChanged(hasText: Bool)

    case voiceStarted
    case voicePartial(String)
    case voiceFinal(String)
    case voiceSessionStarted(source: String)
    case voiceSessionEnded(reason: String)

    case contextUpdated(sources: [String])

    case agentStarted(taskId: UUID)
    case agentStepStarted(taskId: UUID, step: String)
    case agentStepCompleted(taskId: UUID, step: String, ok: Bool)

    case confirmationRequired(ActionConfirmation)
    case confirmationResolved(id: UUID, approved: Bool)

    case meetingDetected(app: String)
    case meetingStarted(id: String)
    case meetingTranscriptUpdated(lines: Int)
    case meetingEnded(id: String)

    case workspaceOpened
    case modeChanged(GenieMode)

    /// ログ用の短い名前（§28 のイベント名に合わせる）。
    var name: String {
        switch self {
        case .appChanged: return "app.changed"
        case .focusChanged: return "focus.changed"
        case .selectionChanged: return "selection.changed"
        case .voiceStarted: return "voice.started"
        case .voicePartial: return "voice.partial"
        case .voiceFinal: return "voice.final"
        case .voiceSessionStarted: return "voice.session.started"
        case .voiceSessionEnded: return "voice.session.ended"
        case .contextUpdated: return "context.updated"
        case .agentStarted: return "agent.started"
        case .agentStepStarted: return "agent.step.started"
        case .agentStepCompleted: return "agent.step.completed"
        case .confirmationRequired: return "confirmation.required"
        case .confirmationResolved: return "confirmation.resolved"
        case .meetingDetected: return "meeting.detected"
        case .meetingStarted: return "meeting.started"
        case .meetingTranscriptUpdated: return "meeting.transcript.updated"
        case .meetingEnded: return "meeting.ended"
        case .workspaceOpened: return "workspace.opened"
        case .modeChanged: return "mode.changed"
        }
    }
}

@MainActor
final class GenieEventBus {
    static let shared = GenieEventBus()

    private var handlers: [UUID: (GenieEvent) -> Void] = [:]
    /// 直近のイベント。検証と Timeline 表示に使う（無制限には貯めない）。
    private(set) var recent: [GenieEvent] = []
    private let recentLimit = 200

    @discardableResult
    func subscribe(_ handler: @escaping (GenieEvent) -> Void) -> UUID {
        let token = UUID()
        handlers[token] = handler
        return token
    }

    func unsubscribe(_ token: UUID) { handlers[token] = nil }

    func publish(_ event: GenieEvent) {
        recent.append(event)
        if recent.count > recentLimit { recent.removeFirst(recent.count - recentLimit) }
        for handler in handlers.values { handler(event) }
    }

    /// テスト用。
    func reset() { recent.removeAll() }
}
