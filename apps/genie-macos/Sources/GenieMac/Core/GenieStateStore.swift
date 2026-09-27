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
    ///
    /// **確認カードが出ている間は、ほかの表示でカードを隠さない。**以前は Listening・回答・
    /// 会議の開始がカードを上書きし、見えないカードが 120 秒待って「承認しない」になっていた。
    /// 頼まれた表示は覚えておき、カードに答えが済んだらそこへ戻す。
    func setDock(_ presentation: DockPresentation) {
        if let shown = state.confirmation, presentation != .confirmation(shown) {
            dockBehindConfirmation = presentation
            return
        }
        applyDock(presentation)
    }

    private func applyDock(_ presentation: DockPresentation) {
        guard state.dock != presentation else { return }
        state.dock = presentation
        // マイクが開いたまま、止める手の無い面にしない（会話を終える / 音声入力のマイクを閉じる）。
        VoiceHUDState.shared.dockChanged(to: presentation)
        setMode(activity(showing: presentation))
        // 見た目の大きさは状態から導く。ここで必ず合わせる。
        WindowCoordinator.shared.syncDockPanels()
    }

    /// 何が起きているか。**表示ではなく出来事から決める。**
    ///
    /// 以前は表示から活動状態を決めていたので、仕事が動いている間に短い回答を出すと
    /// 「完了」になり、会話と仕事と表示が互いに上書きしていた。いまは出来事の強い順に見る:
    /// 確認待ち → 会議 → 聞き取り・考え中（いまの会話）→ 動いている仕事 → 表示から導けるもの。
    func activity(showing dock: DockPresentation) -> GenieMode {
        if state.confirmation != nil { return .awaitingConfirmation }
        if state.meeting.isRecording { return .meeting }
        switch dock {
        case .listening, .thinking: return Self.mode(for: dock, current: state.mode)
        default: break
        }
        if state.activeTask?.status == .running { return .acting }
        return Self.mode(for: dock, current: state.mode)
    }

    /// 表示 → 活動状態の対応。App Context や Quick Actions は「活動」ではないので idle のまま。
    static func mode(for dock: DockPresentation, current: GenieMode) -> GenieMode {
        switch dock {
        case .listening(let partial): return partial.isEmpty ? .listening : .transcribing
        case .thinking: return .thinking
        case .agent: return .acting
        case .confirmation: return .awaitingConfirmation
        case .meeting, .enteringRecording: return .meeting
        case .answer, .info: return .completed
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

    /// 仕事を動かしている側の「止める」。Dock の止めるボタンは、表示を変えるだけでなくこれを呼ぶ。
    private var stopHandlers: [UUID: () -> Void] = [:]

    /// `onStop`: 本人が「止める」を押したときに、実際に仕事を止める処理（待ちの取り消し・backend の取り消し）。
    func startTask(_ task: AgentTask, onStop: (() -> Void)? = nil) {
        stopHandlers[task.id] = onStop
        state.activeTask = task
        // §23 UI lifecycle ≠ Task lifecycle。Dock を閉じても task は消えない。
        LocalStore.shared.save(task)
        setDock(.agent)
        setMode(.acting)
        bus.publish(.agentStarted(taskId: task.id))
    }

    func updateStep(_ stepId: UUID, to newState: AgentRunState) {
        // 終わった（止めた）仕事の段は動かさない。後から届いた更新で止めた仕事が進んで見えていた。
        guard var task = state.activeTask, !task.status.isTerminal,
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

    /// 本人が Dock の「止める」を押した。仕事を動かしている側に止めさせ（backend の取り消しを含む）、
    /// 動いていた段に「取り消しました」と書いて、できなかった結果として残す。音声の停止とは別の操作。
    func stopTask() {
        guard var task = state.activeTask, !task.status.isTerminal else { return }
        stopHandlers.removeValue(forKey: task.id)?()
        if let i = task.steps.firstIndex(where: { $0.state == .running }) ?? task.steps.firstIndex(where: { $0.state == .pending }) {
            task.steps[i].state = .failed
            task.steps[i].detail = Facts.taskCancelled
        }
        state.activeTask = task
        finishTask(.failed)
    }

    func finishTask(_ status: AgentRunState) {
        // 一度終わった仕事の結果は変えない（止めた後に届いた成功で ✓ にしない）。
        guard var task = state.activeTask, !task.status.isTerminal else { return }
        stopHandlers[task.id] = nil
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

    /// 面に出ているカード（`state.confirmation`）の後ろで、出た順に待っているカード。
    ///
    /// **表示中のカードを別のカードで置き換えない。**以前は新しいカードが無条件に上書きし、
    /// Dock のボタンは描いたカードではなく store の現在値に答えていた。読んでいたカードへの
    /// 「実行する」が、押す直前に差し替わった別の承認に付き得た。いまは 1 枚ずつ、出た順に出す。
    private var confirmationQueue: [ActionConfirmation] = []
    /// カードが出ている間に頼まれた Dock の表示（`setDock`）。最後のカードに答えが済んだら戻す。
    private var dockBehindConfirmation: DockPresentation?

    /// R2/R3 のときだけカードを出す。R0/R1 は黙って通す（毎回聞くと確認が意味を失う）。
    /// 戻り値は「カードを出したか」（ほかのカードの後ろで順番を待つ場合も true）。
    @discardableResult
    func requireConfirmation(_ confirmation: ActionConfirmation) -> Bool {
        guard confirmation.risk.needsConfirmation else { return false }
        if let shown = state.confirmation {
            if shown.id != confirmation.id, !confirmationQueue.contains(where: { $0.id == confirmation.id }) {
                confirmationQueue.append(confirmation)
            }
            return true
        }
        showConfirmation(confirmation)
        return true
    }

    private func showConfirmation(_ confirmation: ActionConfirmation) {
        if dockBehindConfirmation == nil { dockBehindConfirmation = state.dock }
        state.confirmation = confirmation
        // §Confirmation Dock 自身が下へ伸びて聞く。
        applyDock(.confirmation(confirmation))
        bus.publish(.confirmationRequired(confirmation))
    }

    /// 確認カードで直した値（param の label → 値、本文は "__preview"）。カードの id ごとに持つ。
    /// これまで「直す」は面の中で閉じていて、押した先には元の値が渡っていた（宣言だけの編集）。
    private var confirmationEdits: [UUID: [String: String]] = [:]

    /// そのカードで直した値を受け取る（1 回だけ。読んだら消す）。
    func takeConfirmationEdits(_ id: UUID) -> [String: String] {
        confirmationEdits.removeValue(forKey: id) ?? [:]
    }

    /// **描いたカード**への答え。Dock / 確認の面のボタンは、描いたカードの id を渡す。
    /// id が面に出ている（または順番を待っている）カードと合わなければ何もしない
    /// —— 押した瞬間に差し替わったカードへ答えを付けない。
    func resolveConfirmation(id: UUID, approved: Bool, edits: [String: String] = [:]) {
        guard removeConfirmation(id) else { return }
        if approved, !edits.isEmpty { confirmationEdits[id] = edits }
        bus.publish(.confirmationResolved(id: id, approved: approved))
        if state.confirmation == nil { setMode(approved ? .acting : state.mode) }
    }

    /// いま面に出ているカードに答える。**検査の自動操作用**（`--selftest` と単体テスト）。
    /// 人が押す面は `resolveConfirmation(id:approved:)` を使う（`scripts/verify-approval-boundary.sh`）。
    func resolveConfirmation(approved: Bool, edits: [String: String] = [:]) {
        guard let shown = state.confirmation else { return }
        resolveConfirmation(id: shown.id, approved: approved, edits: edits)
    }

    /// 答えが無いまま引っ込める（時間切れ・面を出せなかった）。**「やめた」とは扱わない**ので、
    /// 答えの知らせ（`.confirmationResolved`）は流さない。
    func withdrawConfirmation(_ id: UUID) {
        _ = removeConfirmation(id)
    }

    /// 面に出ているカードなら外して次を出す（無ければ、カードの間に頼まれた表示へ戻す）。
    /// 順番待ちのカードなら列から外す。どちらでもなければ false。
    private func removeConfirmation(_ id: UUID) -> Bool {
        if let i = confirmationQueue.firstIndex(where: { $0.id == id }) {
            confirmationQueue.remove(at: i)
            return true
        }
        guard state.confirmation?.id == id else { return false }
        state.confirmation = nil
        if !confirmationQueue.isEmpty {
            showConfirmation(confirmationQueue.removeFirst())
            return true
        }
        let behind = dockBehindConfirmation
        dockBehindConfirmation = nil
        switch behind {
        case nil, .confirmation?: applyDock(state.meeting.isRecording ? .meeting(expanded: nil) : .idle)
        case let dock?: applyDock(dock)
        }
        return true
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
        // 声・文字の依頼の記録（requestRecord）は、段で進む仕事ではない。戻すと誰も終わらせないので、
        // 活動状態がずっと「実行中」のままになる（Work で追える）。段で進む仕事だけを戻す。
        guard state.activeTask == nil,
              let task = LocalStore.shared.loadTasks(status: .running).first(where: { $0.requestRecord == nil }) else { return }
        state.activeTask = task
        setMode(.acting)
    }

    /// 結果面を閉じる。
    func dismissResult() {
        switch state.dock {
        case .answer, .info, .result:
            // 会話の途中なら、カードを閉じても会話は続いている。マイクが開いている姿を隠さない。
            setDock(VoiceHUDState.shared.conversation.isActive ? .listening(partial: "") : .idle)
        default: break
        }
    }

    /// テスト用に初期化する。
    func reset() {
        state = GenieState()
        bus.reset()
    }
}
