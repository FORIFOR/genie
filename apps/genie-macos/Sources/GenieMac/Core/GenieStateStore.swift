import SwiftUI

/// §5 / §31 Genie の状態はここ **1 箇所** にしか無い。
///
/// 仕様書の最重要ルール:「Chat UI / Voice UI / Agent UI / Meeting UI / Context UI という
/// 別々の製品を作らない。すべて GenieState → Genie Surface から描画する」。
///
/// そのため各 Surface は自前の mode を**持たない**。`VoiceHUDState` などは残っているが、
/// 状態の置き場ではなく、この Store への窓口（façade）にしてある。二重に持って
/// 「同期し忘れ」を作らないため —— 宣言だけして繋がっていない作りが一番静かに壊れる。
@MainActor
final class GenieStateStore: ObservableObject {
    static let shared = GenieStateStore()

    @Published private(set) var state = GenieState()

    private var bus: GenieEventBus { GenieEventBus.shared }

    // MARK: - 活動状態（§5）

    func setMode(_ mode: GenieMode) {
        guard state.mode != mode else { return }
        state.mode = mode
        bus.publish(.modeChanged(mode))
    }

    // MARK: - Dock の見せ方

    var dock: DockPresentation { state.dock }

    /// Dock の表示を変える。**活動状態も合わせて動かす**ので、両者がずれない。
    func setDock(_ presentation: DockPresentation) {
        guard state.dock != presentation else { return }
        state.dock = presentation
        setMode(Self.mode(for: presentation, current: state.mode))
        // 見た目の大きさは状態から導く。ここで必ず合わせる。
        WindowCoordinator.shared.syncDockPanels()
    }

    /// 表示 → 活動状態の対応。App Context や Quick Actions は「活動」ではないので idle のまま。
    static func mode(for dock: DockPresentation, current: GenieMode) -> GenieMode {
        switch dock {
        case .listening(let partial): return partial.isEmpty ? .listening : .transcribing
        case .thinking: return .thinking
        case .agent: return .acting
        case .confirmation: return .awaitingConfirmation
        case .meeting, .enteringRecording: return .meeting
        case .answer: return .completed
        case .result: return .completed
        case .idle, .appContext, .appContextExpanded, .contextDetail, .quickActions:
            // 会議中や workspace 表示中は、Dock が idle でも活動は続いている。
            return (current == .meeting || current == .workspace) ? current : .idle
        }
    }

    // MARK: - 文脈（§7 / §25）

    func updateContext(_ raw: [ContextFact], now: Date = Date()) {
        let resolved = ContextBundle.resolved(raw, now: now)
        guard state.context != resolved else { return }
        state.context = resolved
        // §25 残すのは metadata だけ。本文はディスクに書かない。
        for fact in resolved.items { LocalStore.shared.saveContextMetadata(fact) }
        bus.publish(.contextUpdated(sources: resolved.visibleSources))
    }

    // MARK: - Agent（§15）

    func trackExecution(_ task: AgentTask) {
        guard state.activeTask?.id == task.id else { return }
        state.activeTask = task
        LocalStore.shared.save(task)
        WindowCoordinator.shared.syncDockPanels()
    }

    func startTask(_ task: AgentTask) {
        state.activeTask = task
        // §23 UI lifecycle ≠ Task lifecycle。Dock を閉じても task は消えない。
        LocalStore.shared.save(task)
        setDock(.agent)
        setMode(.acting)
        bus.publish(.agentStarted(taskId: task.id))
    }

    func updateStep(_ stepId: UUID, to newState: AgentRunState) {
        guard var task = state.activeTask,
              let index = task.steps.firstIndex(where: { $0.id == stepId }) else { return }
        task.steps[index].state = newState
        let title = task.steps[index].title
        state.activeTask = task
        LocalStore.shared.save(task)
        // 段が増減すると Dock の高さも変わる。
        WindowCoordinator.shared.syncDockPanels()
        switch newState {
        case .running: bus.publish(.agentStepStarted(taskId: task.id, step: title))
        case .success, .failed:
            bus.publish(.agentStepCompleted(taskId: task.id, step: title, ok: newState == .success))
        case .pending: break
        }
    }

    func finishTask(_ status: AgentRunState) {
        guard var task = state.activeTask else { return }
        task.status = status
        state.activeTask = task
        LocalStore.shared.save(task)
        setMode(status == .success ? .completed : .failed)
        // 会議中は会議へ戻す。そうでなければ、消さずに**後始末を出したまま**残す。
        if state.meeting.isRecording {
            setDock(.meeting(expanded: nil))
        } else if status == .success {
            // 題は仕事の名前そのまま。語尾を足すと題によって日本語が崩れる。
            setDock(.result(AgentResult(title: task.title, actions: [.openWorkspace, .copy],
                                        sourceCount: task.steps.filter { $0.state == .success }.count)))
        } else {
            // できなかったときも黙って消えない。どこで止まったかと、やり直す道を出す（Atlas dock.result-failed）。
            setDock(.result(AgentResult(title: task.title, actions: [.retry],
                                        detail: task.failureReason ?? "途中で止まりました", failed: true)))
        }
    }

    // MARK: - 確認（§16 / §17）

    /// R2/R3 のときだけカードを出す。R0/R1 は黙って通す（毎回聞くと確認が意味を失う）。
    /// 戻り値は「カードを出したか」。
    @discardableResult
    func requireConfirmation(_ confirmation: ActionConfirmation) -> Bool {
        guard confirmation.risk.needsConfirmation else { return false }
        state.confirmation = confirmation
        // §Confirmation Dock 自身が下へ伸びて聞く。
        setDock(.confirmation(confirmation))
        bus.publish(.confirmationRequired(confirmation))
        return true
    }

    /// 確認カードで直した値（param の label → 値、本文は "__preview"）。**答えた直後だけ意味を持つ。**
    /// これまで「直す」は面の中で閉じていて、押した先には元の値が渡っていた（宣言だけの編集）。
    var lastConfirmationEdits: [String: String] = [:]

    func resolveConfirmation(approved: Bool, edits: [String: String] = [:]) {
        guard let pending = state.confirmation else { return }
        lastConfirmationEdits = approved ? edits : [:]
        state.confirmation = nil
        bus.publish(.confirmationResolved(id: pending.id, approved: approved))
        setDock(state.meeting.isRecording ? .meeting(expanded: nil) : .idle)
        setMode(approved ? .acting : .idle)
    }

    // MARK: - 会議（§18 / §21）

    /// 検出しただけ。**録音は始めない**（§18: Meeting 検出 = 録音開始 にはしない）。
    func meetingDetected(app: String?) {
        guard state.meeting.detectedApp != app else { return }
        state.meeting.detectedApp = app
        if let app { bus.publish(.meetingDetected(app: app)) }
    }

    func meetingStarted(id: String) {
        state.meeting.meetingId = id
        state.meeting.isRecording = true
        setMode(.meeting)
        // 録音を始めた瞬間に窓を増やさない。Dock が録音コントローラになるだけで、
        // Notes / Captions / Ask は**押されたときだけ**開く。
        setDock(.meeting(expanded: nil))
        bus.publish(.meetingStarted(id: id))
    }

    func meetingEnded() {
        let id = state.meeting.meetingId
        state.meeting.isRecording = false
        state.meeting.meetingId = nil
        setMode(.idle)
        // 大きな面を開いていたら閉じる（開いていなければ何も起きない）。
        WindowCoordinator.shared.leaveRecordingMode()
        // 停止しても巨大な modal は出さない。Dock が結果へ morph する。
        // 中身は Session を見る（Home のカードと同じもの）。
        if let id, let session = MeetingSessionStore.shared.session(id: id) {
            setDock(.result(AgentResult(title: session.title, actions: [.openNotes, .ask], sessionId: id)))
        } else {
            setDock(.idle)
        }
        if let id { bus.publish(.meetingEnded(id: id)) }
    }

    func updateCanvas(_ canvas: MeetingCanvas) {
        state.meeting.canvas = canvas
        // 拾うたびに会議 id で残す。止めたあとに件数だけ残るのでは、
        // Library から「決まったこと [1] → 誰が・いつ → 原文」へ戻れない。
        if let id = state.meeting.meetingId { LocalStore.shared.saveNotes(meetingId: id, canvas) }
    }

    // MARK: - Workspace

    func workspaceOpened() {
        setMode(.workspace)
        bus.publish(.workspaceOpened)
    }

    /// §23 起動時に、走っていた task を読み戻す（Dock を開き直したら状態が戻る）。
    func restoreRunningTask() {
        guard state.activeTask == nil,
              let task = LocalStore.shared.loadTasks(status: .running).first else { return }
        state.activeTask = task
        setMode(.acting)
    }

    /// 結果面を閉じる。
    func dismissResult() {
        switch state.dock {
        case .answer, .result: setDock(.idle)
        default: break
        }
    }

    /// テスト用に初期化する。
    func reset() {
        state = GenieState()
        bus.reset()
    }
}
