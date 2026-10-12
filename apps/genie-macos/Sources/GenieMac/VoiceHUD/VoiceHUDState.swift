import GenieCore
import SwiftUI

/// 上部 Voice OS ピルの状態。idle は静か、listening は声を拾っている、thinking は Agent に問い合わせ中。
/// 実フロー: ショートカット→声/テキストの依頼→`ask()`→thinking→Agent 応答→回答面（または idle）。
@MainActor
final class VoiceHUDState: ObservableObject {
    static let shared = VoiceHUDState()
    /// Dock の表示。**ここには持たない** —— 実体は `GenieStateStore` にある。
    ///
    /// 仕様書 §31「UI ごとに勝手に状態を持たせない」。以前はここが真の置き場だったので、
    /// 全体の活動状態（会議中か / 確認待ちか）と Dock の見た目が別々に動き得た。
    /// いまは読み書きとも Store を通るので、ずれようがない。
    typealias Mode = DockPresentation
    var mode: Mode {
        get { GenieStateStore.shared.dock }
        set {
            objectWillChange.send()
            GenieStateStore.shared.setDock(newValue)
        }
    }
    /// 直近の Agent 応答（HUD 下や通知に出す）。
    @Published var answer = ""
    /// Independent of Dock presentation: collapsing the Dock must not permit duplicate requests.
    @Published private(set) var requestInFlight = false

    /// Listening と名乗る前の「まだ 1 サンプルも取り込めていない」状態。
    ///
    /// 以前はここが無く、`beginListening()` が**マイクを開かないまま**「聞いています…」と
    /// 名乗っていた（取り込みも文字起こしも起きない＝宣言だけ）。いまは実際に取り込み、
    /// 最初の音声フレームが届いてから名乗る。タイマーでは切り替えない。
    @Published private(set) var listeningAwaitingAudio = true
    @Published private(set) var inputLevel: Float = 0

    func receiveInputLevel(_ level: Float) {
        guard case .listening = mode, !listeningAwaitingAudio else { return }
        inputLevel = LiquidOrbMotion.clampedLevel(level)
    }

    /// 検査・golden 用。実マイクを開けない撮影で「取り込めている姿」を作る
    /// （録音側の `markListening` と同じ役割）。
    func markVoiceCaptureLive() { listeningAwaitingAudio = false }

    /// 検査・golden 用。「まだ取り込めていない姿（準備中…）」を作る。
    func beginPreparingForShot() { listeningAwaitingAudio = true; inputLevel = 0 }

    @Published private(set) var latestRequestID: UUID?
    @Published private(set) var refreshingRequests: Set<UUID> = []
    private var apiBase: String?
    private var apiToken: String?
    private var conversationId: String?

    func configureBackend(base: String, token: String, renewal: Bool = false) {
        if !renewal || apiBase != base { conversationId = nil }
        apiBase = base; apiToken = token
    }

    /// 声を使い始める。§26 マイクだけを、この瞬間に要求する。
    ///
    /// **実際に取り込む。**面は先に出すが、見出しは最初の音声フレームが届くまで「準備中…」で、
    /// 「聞いています…」と名乗るのはそれからにする（UI の意味と実装状態を一致させる）。
    func beginListening() {
        GenieSpeechOutput.shared.stop()
        inputLevel = 0
        guard Permissions.microphone == .granted else {
            PermissionGuideCoordinator.shared.explain(.microphone) { [weak self] in self?.beginListening() }
            return
        }
        listeningAwaitingAudio = true
        mode = .listening(partial: "")
        GenieEventBus.shared.publish(.voiceStarted)
        let started = RecordingRuntime.shared.beginVoiceListening(
            onFirstFrame: { [weak self] in self?.listeningAwaitingAudio = false },
            onPartial: { [weak self] text in self?.updatePartial(text) },
            onFinal: { [weak self] text in
                guard let self, !text.isEmpty else { return }
                self.speak(text)
            })
        // 会議の録音中は録音側の STT から partial が流れてくるので、そちらを正とする。
        if !started, RecordingWorkspaceState.shared.isRecording { listeningAwaitingAudio = false }
    }

    /// 聞くのをやめる（Esc）。マイクが開いている面に逃げ道の鍵が無いのは危ない。
    func cancelListening() {
        inputLevel = 0
        guard case .listening = mode else { return }
        RecordingRuntime.shared.endVoiceListening()
        listeningAwaitingAudio = true
        mode = .idle
    }

    /// 認識の途中経過。**確定を待たずに** Dock へ出す（§Listening）。
    func updatePartial(_ text: String) {
        guard case .listening = mode else { return }
        mode = .listening(partial: text)
        GenieEventBus.shared.publish(.voicePartial(text))
    }

    /// Dock 本体のクリック。窓は増やさず、Dock 自身が Quick Actions の姿になる。
    func toggleQuickActions() {
        mode = mode == .quickActions ? .idle : .quickActions
    }

    /// App Context の開閉。閉じているときは 1 行、開くと頼めることを出す。
    func toggleContextExpanded() {
        switch mode {
        case .appContext(let s) where !s.suggestions.isEmpty: mode = .appContextExpanded(s)
        case .appContextExpanded(let s): mode = .appContext(s)
        default: break
        }
    }

    /// 提案を押した。Agent へ渡し、Dock は実行中の姿になる。
    func runSuggestion(_ title: String) {
        RecordingWorkspaceState.shared.runAIAction(title)
    }

    /// 会議 Dock の面を開閉する。**常時 5 枚は並べない**ので、開くのは 1 枚だけ。
    func toggleMeetingPanel(_ panel: DockPresentation.MeetingPanel) {
        guard case .meeting(let open) = mode else { return }
        mode = .meeting(expanded: open == panel ? nil : panel)
    }

    /// 前面アプリを見て、Presence を静かに変える。**巨大な popup は出さない。**
    func refreshContextualApp() {
        // App switches must not replace recording controls with an app-name-only dead end.
        // Context stays available through explicit Quick Actions.
        switch mode {
        case .appContext: mode = .idle
        case .appContextExpanded(let current):
            guard let summary = AppContextResolver.current(), current.app == summary.app else {
                mode = .idle; return
            }
            mode = .appContextExpanded(summary)
        default: break
        }
    }

    /// 認識した発話の行き先を決める（UI/UX テスト仕様 HUD-004 / P1 Context-aware Voice Routing）。
    ///
    /// 前面アプリにテキスト入力欄があれば**そこへ入れて終わり**。Agent 会話は始めない。
    /// 入力欄が無いときだけ Ask Genie に回す。推測で会話を始めないのが PASS 条件。
    /// 戻り値は「dictation として入れたか」。
    @discardableResult
    func speak(_ text: String) -> Bool {
        // 聞き終えたらマイクを閉じる（開きっぱなしにしない）。
        RecordingRuntime.shared.endVoiceListening()
        listeningAwaitingAudio = true
        if Dictation.insert(text) {
            mode = .idle
            answer = ""
            return true
        }
        ask(text)
        return false
    }

    /// 声/テキストの依頼を Agent に投げる。listening→thinking→answer→idle と状態を進める。
    @discardableResult
    func ask(_ text: String, newConversation: Bool = false, visualContext: [VisualContextArtifact]? = nil, consumerPlanning: ConsumerPlanningMode? = nil) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !requestInFlight else { return false }
        GenieSpeechOutput.shared.stop()
        // Personal booking requests open an editable local preparation flow.
        // No gateway, model, address lookup, or paid operation happens here.
        // Explicit images keep their normal visual-question route.
        if consumerPlanning == nil, visualContext?.isEmpty != false,
           let kind = ConsumerJourneyKind.detect(text) {
            latestRequestID = nil; answer = ""; mode = .idle
            ConsumerJourneyStore.shared.present(kind, request: text)
            MainWindowController.shared.showSection(.home)
            return true
        }
        guard let base = apiBase, let token = apiToken else {
            answer = "接続を確認してください。入力した内容は残しています。"; mode = .idle; return false
        }
        // An explicit selection pins the image even if the user captures another one
        // or asks without a reference word. An explicitly empty array means no image.
        let attached = visualContext ?? VisualReferenceResolver.resolve(text: text, recent: VisualContextStore.shared.recent).images
        let attachments = VisualContextStore.shared.attach(attached)
        guard attachments.count == attached.count else {
            answer = "画像を読み込めませんでした。撮り直すか、画像を外して送信してください。質問は残しています。"
            return false
        }
        let task = AgentTask(requestRecord: TaskRequestRecord(request: text, base: base),
            id: UUID(), title: TaskRequestRecord.title(for: text),
            status: .running, steps: [], startedAt: Date(), context: ContextBundle())
        guard LocalStore.shared.save(task) else {
            answer = "依頼を保存できませんでした。空き容量を確認してください。入力した内容は残しています。"
            return false
        }
        latestRequestID = task.id
        requestInFlight = true
        // 「これ返して」: 開いているメール → 選択 → 前面の窓 を、この順で候補として添える（題名だけ）。
        let replyCandidates = ReplyContextResolver.isReplyUtterance(text)
            ? ReplyContextResolver.json(ReplyContextResolver.candidates()) : ""
        mode = .thinking; answer = ""
        Task.detached { [weak self] in
            do {
                let outcome: TurnOutcome
                if let consumerPlanning {
                    let id = try GenieCoreBridge.createTask(base, accessToken: token,
                        kind: consumerPlanning.taskKind, inputJson: consumerPlanning.inputJSON(text))
                    outcome = TurnOutcome(needsClarification: false, answer: "", taskId: id, notice: "", replyJson: "")
                } else {
                    let conv: String
                    if !newConversation, let existing = await self?.conversationId { conv = existing }
                    else {
                        conv = try GenieCoreBridge.startConversation(base, accessToken: token)
                        await MainActor.run { self?.conversationId = conv }
                    }
                    await MainActor.run {
                        VisualContextStore.shared.bind(conversationID: conv, preserving: Set(attached.map(\.id)))
                        self?.updateRequest(task.id) { $0.conversationID = conv }
                    }
                    outcome = replyCandidates.isEmpty
                        ? try GenieCoreBridge.sendTurn(base, accessToken: token, conversationId: conv,
                                                       text: text, attachments: attachments)
                        : try GenieCoreBridge.sendTurn(base, accessToken: token, conversationId: conv,
                                                       text: text, attachments: attachments, replyCandidatesJson: replyCandidates)
                }
                await MainActor.run {
                    self?.updateRequest(task.id) { $0.backendTaskID = outcome.taskId; $0.phase = .working }
                }
                let reply = try await ExecutionTaskMonitor.follow(outcome, localID: task.id, base: base, token: token, waitMs: 12_000)
                await MainActor.run {
                    self?.applyReply(reply, to: task.id)
                    self?.answer = reply.text
                    // 短い確定回答や聞き返しは、その場で確認できるよう Dock に残す。
                    // 作業中・待機中は従来どおり静かな入口へ戻し、Work で追える状態にする。
                    self?.mode = reply.settled && !reply.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? .answer(reply.text) : .idle
                    if reply.settled { VisualContextStore.shared.markRecent(attached) }
                    // 返信案なら、答えとしてではなく確認カードとして出す（送るのは押されたときだけ）。
                    if reply.settled, !outcome.replyJson.isEmpty, let draft = ReplyFlow.draft(replyJson: outcome.replyJson, body: reply.text) {
                        ReplyFlow.shared.present(draft)
                    }
                }
                // 12 秒で終わらない仕事は、裏で待ち続けて届いたら差し替える（Dock は idle に戻す）。
                let isExecution = await MainActor.run {
                    LocalStore.shared.loadTasks().first(where: { $0.id == task.id })?.requestRecord?.backendKind == "execution.run"
                }
                if !reply.settled, !outcome.taskId.isEmpty, !isExecution {
                    let later = try await ExecutionTaskMonitor.follow(outcome, localID: task.id, base: base, token: token, waitMs: 120_000)
                    await MainActor.run {
                        self?.applyReply(later, to: task.id)
                        if later.settled {
                            self?.answer = later.text
                            if !later.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                self?.mode = .answer(later.text)
                            }
                            VisualContextStore.shared.markRecent(attached)
                            if !outcome.replyJson.isEmpty, let draft = ReplyFlow.draft(replyJson: outcome.replyJson, body: later.text) {
                                ReplyFlow.shared.present(draft)
                            }
                        }
                    }
                }
                await MainActor.run { self?.requestInFlight = false }
            } catch {
                await MainActor.run {
                    self?.updateRequest(task.id) {
                        $0.phase = .unknown
                        $0.message = $0.backendTaskID.isEmpty
                            ? "受付を確認できませんでした。二重実行を防ぐため、自動では再送しません。"
                            : "通信が切れました。状況を確認すると、同じ仕事の続きが読み込まれます。"
                    }
                    self?.answer = "接続を確認してください。依頼と現在の状況は Work に保存されています。"; self?.mode = .idle
                    self?.requestInFlight = false
                }
            }
        }
        return true
    }

    /// turn の結果を、人に見せる文にする。
    ///
    /// gateway は chat lane を **仕事（task）として始める**ので、202 の時点では答えが無い。
    /// 以前はここで「(応答なし)」と出していた —— 仕事は動いているのに、答えが Dock に届かなかった。
    /// task_id があれば完了を待ち、成果物の本文を答えとして返す。`settled` は「もう変わらない」。
    nonisolated static func followUp(_ outcome: TurnOutcome, base: String, token: String, waitMs: UInt64) throws -> TaskReply {
        if outcome.needsClarification {
            return TaskReply(text: outcome.answer.isEmpty ? "目的や条件をもう少し詳しく教えてください。" : outcome.answer, phase: .needsInput)
        }
        if !outcome.answer.isEmpty { return TaskReply(text: outcome.answer, phase: .complete) }
        if !outcome.taskId.isEmpty {
            let done = try GenieCoreBridge.waitTask(base, accessToken: token, taskId: outcome.taskId, timeoutMs: waitMs)
            return try taskReply(status: done.status, artifactID: done.resultArtifactId) {
                try GenieCoreBridge.artifactContent(base, accessToken: token, artifactId: done.resultArtifactId)
            }
        }
        return TaskReply(text: outcome.notice.isEmpty ? "結果を確認できませんでした。依頼は自動で再送されません。" : outcome.notice, phase: .needsInput)
    }

    nonisolated static func taskReply(status: String, artifactID: String, content: () throws -> String) rethrows -> TaskReply {
        switch status {
        case "COMPLETED":
            guard !artifactID.isEmpty else { return TaskReply(text: "処理は終了しましたが、成果物は返されませんでした。", phase: .needsInput) }
            let body = try content()
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return TaskReply(text: "成果物の内容が空でした。状況を確認してください。", phase: .needsInput, artifactID: artifactID)
            }
            return TaskReply(text: body, phase: .complete, artifactID: artifactID)
        case "FAILED": return TaskReply(text: "処理を完了できませんでした。依頼を見直すか、接続を確認してください。", phase: .failed)
        case "CANCELLED": return TaskReply(text: "この仕事は取り消されました。", phase: .cancelled)
        case "PAUSED_HOST_OFFLINE":
            return TaskReply(text: "実行する端末に接続できません。Genie の実行サービスが起動すると続行できます。", phase: .waiting)
        case "WAITING_APPROVAL", "WAITING_USER", "AWAITING_APPROVAL", "BLOCKED", "HANDED_OFF":
            return TaskReply(text: "続行に必要な確認や接続を待っています。承認は Genie の確認画面から行ってください。", phase: .waiting)
        default: return TaskReply(text: "作成を続けています。この画面を離れても、Work から結果を確認できます。", phase: .working)
        }
    }

    private func updateRequest(_ id: UUID, change: (inout TaskRequestRecord) -> Void) {
        guard var task = LocalStore.shared.loadTasks().first(where: { $0.id == id }), var record = task.requestRecord else { return }
        change(&record); record.updatedAt = Date()
        task.requestRecord = record; task.status = record.phase.runState
        LocalStore.shared.save(task)
        if record.backendKind == "execution.run" {
            if record.phase != .working && record.phase != .submitting {
                for i in task.steps.indices where task.steps[i].state == .running {
                    task.steps[i].state = record.phase == .complete ? .success : .pending
                }
                if record.phase == .complete { for i in task.steps.indices { task.steps[i].state = .success } }
            }
            GenieStateStore.shared.trackExecution(task)
        }
    }

    private func applyReply(_ reply: TaskReply, to id: UUID) {
        updateRequest(id) {
            $0.phase = reply.phase; $0.artifactID = reply.artifactID
            $0.verificationLabel = reply.verificationLabel
            if reply.phase == .complete { $0.result = reply.text; $0.message = "" }
            else { $0.message = reply.text }
        }
    }

    /// A stop is a backend cancellation, not a local failed badge. Already-applied effects are not undone.
    func cancelExecution(_ id: UUID) {
        guard let record = LocalStore.shared.loadTasks().first(where: { $0.id == id })?.requestRecord,
              record.backendKind == "execution.run", !record.backendTaskID.isEmpty,
              let base = apiBase, let token = apiToken, record.base == base else { return }
        ExecutionTaskMonitor.shared.cancelling(id)
        Task { [weak self] in
            do {
                try await ExecutionTaskMonitor.cancel(base: base, token: token, taskID: record.backendTaskID)
                self?.updateRequest(id) { $0.message = "停止を要求しました。実行ホストの応答を確認しています。" }
            } catch {
                ExecutionTaskMonitor.shared.cancelFailed(id)
                self?.updateRequest(id) { $0.message = "停止の受付を確認できません。実行先の状態を確認してください。" }
            }
        }
    }

    /// Read the existing backend job only. Never create a conversation or resend a turn.
    func refreshRequest(_ id: UUID) {
        guard !refreshingRequests.contains(id),
              let record = LocalStore.shared.loadTasks().first(where: { $0.id == id })?.requestRecord,
              record.canRefresh else { return }
        guard let base = apiBase, let token = apiToken, base == record.base else {
            updateRequest(id) { $0.message = "この仕事を依頼した接続が見つかりません。接続を確認してください。" }
            return
        }
        // The initial submit is already waiting for this job; don't start another poll.
        guard !(requestInFlight && latestRequestID == id) else { return }
        refreshingRequests.insert(id)
        Task.detached { [weak self] in
            do {
                let outcome = TurnOutcome(needsClarification: false, answer: "", taskId: record.backendTaskID, notice: "", replyJson: "")
                let reply = try await ExecutionTaskMonitor.follow(outcome, localID: id, base: base, token: token, waitMs: 12_000)
                await MainActor.run { self?.applyReply(reply, to: id); self?.refreshingRequests.remove(id) }
            } catch {
                await MainActor.run {
                    self?.updateRequest(id) { $0.message = "状況を取得できませんでした。接続を確認してから、もう一度状況を確認できます。" }
                    self?.refreshingRequests.remove(id)
                }
            }
        }
    }
}
