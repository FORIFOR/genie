import GenieApproval
import GenieCore
import SwiftUI

/// backend の仕事の状態を、待ち方の 3 つに分ける（`VoiceHUDState.waitForTask`）。
enum TaskWaitState: Equatable {
    /// COMPLETED / FAILED / CANCELLED。もう変わらない。
    case terminal
    /// 人の確認を待っている。**ここから先は読むだけで、答えるのは確認カードだけ。**
    case approvalPending
    /// それ以外（実行中・端末待ちなど）。期限まで待ち続ける。
    case running

    init(status: String) {
        switch status {
        case "COMPLETED", "FAILED", "CANCELLED": self = .terminal
        case "WAITING_APPROVAL", "AWAITING_APPROVAL": self = .approvalPending
        default: self = .running
        }
    }
}

/// `VoiceHUDState.follow` の結果。承認待ちなら、カードに出す承認を持って帰る（ここでは答えない）。
struct TaskFollowUp {
    var reply: TaskReply
    var pendingApprovals: [BackendApproval] = []
    /// カードに答えが無かった（時間切れ・見えなかった）ので、承認を PENDING のまま残した。
    /// 裏で待ち続けて同じカードを自動で出し直すことはしない（出し直すのは「状況を確認」）。
    var leftPending = false
}

/// `VoiceHUDState.follow` が backend の仕事を読む先。本物は `live`（GenieCoreBridge）で、検査では差し替える。
struct TaskReader {
    var wait: (UInt64) throws -> TaskStatus
    var content: (String) throws -> String
    var approvals: () throws -> [BackendApproval]
    var now: () -> Date = Date.init
    var pause: (UInt64) -> Void = { Thread.sleep(forTimeInterval: Double($0) / 1000) }

    /// 本物の読み先。**待つのは `VoiceHUDState.waitForTask` の区切りだけ**で、ここは 1 区切りを読む。
    static func live(base: String, token: String, taskId: String) -> TaskReader {
        TaskReader(
            wait: { try GenieCoreBridge.waitTask(base, accessToken: token, taskId: taskId, timeoutMs: $0) },
            content: { try GenieCoreBridge.artifactContent(base, accessToken: token, artifactId: $0) },
            approvals: { try GenieCoreBridge.pendingApprovals(base, accessToken: token, taskId: taskId) })
    }
}

/// 聞き取りの世代。開くたび・閉じるたびに進み、コールバックは開いたときの世代でだけ動く。
struct VoiceGeneration: Equatable {
    private(set) var value = 0
    /// マイクを開く。この世代を返す。
    mutating func open() -> Int { value += 1; return value }
    /// 閉じる。それまでに開いた世代はすべて古くなる。
    mutating func close() { value += 1 }
    func isCurrent(_ generation: Int) -> Bool { generation == value }
}

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
        // 会話で聞いている間は、面が答えのカードでもオーブへ大きさを渡す（オーブが声に反応する）。
        let conversationListening = conversation.isActive && conversation.phase == .listening
        if !conversationListening { guard case .listening = mode else { return } }
        guard !listeningAwaitingAudio else { return }
        inputLevel = LiquidOrbMotion.clampedLevel(level)
    }

    /// 検査・golden 用。実マイクを開けない撮影で「取り込めている姿」を作る
    /// （録音側の `markListening` と同じ役割）。
    func markVoiceCaptureLive() { listeningAwaitingAudio = false }

    /// 検査・golden 用。「まだ取り込めていない姿（準備中…）」を作る。
    func beginPreparingForShot() { listeningAwaitingAudio = true; inputLevel = 0 }

    @Published private(set) var latestRequestID: UUID?
    @Published private(set) var refreshingRequests: Set<UUID> = []
    /// ask の裏の待ち（受付の後も最大 120 秒）が続いている依頼。「状況を確認」が同じ仕事を二重に追わないため
    /// （送信中の requestInFlight は受付で解けるので、それだけでは防げない）。
    private(set) var followingRequests: Set<UUID> = []
    /// Keep failed writes available for export/retry; never pretend they survived a restart.
    @Published private(set) var unsavedRequests: [UUID: AgentTask] = [:]
    @Published var isListeningMuted = false
    /// 前の依頼に答えている間に届いた発話。**黙って捨てない。**考え中の面に「まだ送っていない」と出し、
    /// 次に Listening を開いたとき入力欄へ戻す（送るのは本人）。送れたら消える。
    /// 次の Listening の入力欄に入れておく文（預かっていた発話）。**面は読むだけ**で、動かすのは状態の側。
    /// 以前は ListeningDock の onAppear で預かりを取り出していたが、面の高さを測るために画面の外で
    /// 組み立てるたびに onAppear が走り、預かった発話が測った瞬間に消えていた。
    @Published private(set) var listeningPrefill: String?
    @Published private(set) var heldUtterance: String? {
        // 行が増減すると考え中の面の高さも変わる（高さは中身で決まる。DS-01）。
        didSet { if heldUtterance != oldValue { WindowCoordinator.shared.syncDockPanels() } }
    }
    /// 聞き取りの世代。マイクを開くたび・閉じるたびに進める。コールバックは開いたときの世代を持ち、
    /// 世代が進んでいたら何もしない —— 閉じた後に遅れて届いた確定文で依頼が送られないように。
    private(set) var voice = VoiceGeneration()
    /// 「Genie と会話」。一回の音声入力とは別の入口で、明示的に始めて 5 分で終わる。
    @Published private(set) var conversation = ConversationLoop() {
        // 会話の 1 行が出る・消えると面の高さが変わる（DS-01）。
        didSet { if conversation.isActive != oldValue.isActive || conversation.canExtend != oldValue.canExtend { WindowCoordinator.shared.syncDockPanels() } }
    }
    /// 終わる 30 秒前の知らせを出しているか（表示だけ）。
    @Published private(set) var conversationEnding = false {
        didSet { if conversationEnding != oldValue { WindowCoordinator.shared.syncDockPanels() } }
    }
    @Published private(set) var conversationRemaining: TimeInterval = 0
    private var conversationClock: Task<Void, Never>?
    private var sleepObservers: [NSObjectProtocol] = []
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
    /// 一回の音声入力の使い道。Genie に話しかけるのは「会話」（`beginConversation`）。
    enum ListenPurpose { case dictation, meetingAsk }
    private(set) var listenPurpose: ListenPurpose = .dictation

    /// 音声入力（一回）。言い終えた文を前面のアプリの入力欄へ入れる。**Genie には送らない**。
    /// 入力欄が無ければ「会話」を案内する（推測で質問にしない）。
    func beginDictation() {
        // 他のアプリの欄へ文字を入れるにはアクセシビリティの許可が要る。無いまま聞き始めると、
        // 話し終えてから「欄が見つからない」と本当の理由と違うことを言うことになる。使う直前に求める。
        guard Permissions.accessibility == .granted || Dictation.dryRun != nil else {
            PermissionGuideCoordinator.shared.explain(.accessibility) { [weak self] in self?.beginDictation() }
            return
        }
        listenPurpose = .dictation
        beginListening()
    }

    /// 録音の作業画面の問いの欄のマイク。言い終えた文を、そのまま Genie への問いにする（従来どおり）。
    func beginMeetingAsk() {
        listenPurpose = .meetingAsk
        beginListening()
    }

    private func beginListening() {
        // 確認カードに答えを待っている間は聞き始めない。**Listening でカードを隠さない**
        // （隠すと見えないカードが待ち続け、声を始めただけで承認が宙に浮く）。声でカードには答えない。
        guard GenieStateStore.shared.state.confirmation == nil else { return }
        GenieSpeechOutput.shared.stop()
        inputLevel = 0
        isListeningMuted = false
        guard Permissions.microphone == .granted else {
            PermissionGuideCoordinator.shared.explain(.microphone) { [weak self] in self?.beginListening() }
            return
        }
        if Permissions.speechRecognition == .notDetermined {
            Permissions.requestSpeechRecognition { _ in }
        }
        listeningAwaitingAudio = true
        // 預かっていた発話は、この Listening の入力欄へ（送るのは本人）。
        listeningPrefill = takeHeldUtterance()
        mode = .listening(partial: "")
        WindowCoordinator.shared.focusListeningDock()
        GenieEventBus.shared.publish(.voiceStarted)
        openMicrophone()
    }

    /// マイクを開く。コールバックは**この世代のものだけ**受け付ける。
    /// 戻り値は「取り込みを始められたか」（会議の録音中は録音側の STT を使うので true 扱い）。
    @discardableResult
    private func openMicrophone(echoCancellation: Bool = false, onFirstFrame: (() -> Void)? = nil, onFinal: ((String) -> Void)? = nil) -> Bool {
        let generation = voice.open()
        let started = RecordingRuntime.shared.beginVoiceListening(
            echoCancellation: echoCancellation,
            onFirstFrame: { [weak self] in
                guard let self, self.voice.isCurrent(generation) else { return }
                self.listeningAwaitingAudio = false
                onFirstFrame?()
            },
            onPartial: { [weak self] text in
                guard let self, self.voice.isCurrent(generation), !self.isListeningMuted else { return }
                self.updatePartial(text)
            },
            onFinal: { [weak self] text in
                guard let self, self.voice.isCurrent(generation), !text.isEmpty, !self.isListeningMuted else { return }
                if let onFinal { onFinal(text) } else { self.speak(text) }
            })
        // 会議の録音中は録音側の STT から partial が流れてくるので、そちらを正とする。
        if !started, RecordingWorkspaceState.shared.isRecording { listeningAwaitingAudio = false; return true }
        return started
    }

    /// マイクを閉じる。**先に世代を進めて**から止める（止める途中に届いたものも古い世代になる）。
    private func closeMicrophone() {
        voice.close()
        RecordingRuntime.shared.endVoiceListening()
    }

    /// マイクの聞き取りを一時停止/再開する（ミュート切り替え）。
    func toggleListeningMute() {
        isListeningMuted.toggle()
        if isListeningMuted {
            // 会話では、音を運んでいるのは提供元（Gemini は自前のマイクで送る）。そちらを止める。
            if conversation.isActive { conversationProvider.closeInput() } else { closeMicrophone() }
            inputLevel = 0
        } else {
            listeningAwaitingAudio = true
            if conversation.isActive { openConversationMicrophone() } else { openMicrophone() }
        }
    }

    /// テキストを直接送信してタスクを実行する。
    func submitText(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        closeMicrophone()
        listeningAwaitingAudio = true
        isListeningMuted = false
        ask(trimmed)
    }

    /// 追加指示として扱う言い方。先頭の言葉だけで決める（推測で既存の仕事に混ぜない）。
    nonisolated static func isFollowUp(_ text: String) -> Bool {
        text.range(of: #"^(あと|それと|それから|ついでに|追加で)[、,，\s]"#, options: .regularExpression) != nil
    }

    /// 追加指示を渡す先。直前の依頼の仕事が、まだ動いているとき（作業中・続行待ち）だけ。
    private func followUpTarget(for text: String) -> (id: UUID, taskId: String)? {
        guard Self.isFollowUp(text), let id = latestRequestID,
              let record = (unsavedRequests[id] ?? LocalStore.shared.loadTasks().first(where: { $0.id == id }))?.requestRecord,
              !record.backendTaskID.isEmpty, record.phase == .working || record.phase == .waiting else { return nil }
        return (id, record.backendTaskID)
    }

    /// 追加指示を送る。返すのは「受け取った」まで。反映したかは仕事の側（Work）で分かる。
    private func sendInstruction(_ text: String, to target: (id: UUID, taskId: String), base: String, token: String) {
        let requestId = UUID().uuidString.lowercased()
        requestInFlight = true
        mode = .thinking; answer = ""
        Task.detached { [weak self] in
            let message: String
            let accepted: Bool
            do {
                _ = try GenieCoreBridge.addTaskInstruction(base, accessToken: token, taskId: target.taskId,
                                                           requestId: requestId, text: text)
                message = "追加の指示を受け取りました。次の段で反映します。間に合わなかったときは Work に出ます。"
                accepted = true
            } catch ApiError.Server(let status, _) where status == 409 {
                message = "前の仕事はもう終わっていました。追加の内容は送っていません。続きは新しい依頼として話してください。"
                accepted = false
            } catch {
                message = "追加の指示を送れませんでした。接続を確認してください。"
                accepted = false
            }
            await MainActor.run {
                guard let self else { return }
                self.requestInFlight = false
                if accepted { self.updateRequest(target.id) { $0.message = "追加の指示を受け取りました: \(text)" } }
                self.answer = message
                if !self.conversation.isActive { self.mode = .answer(message) }
                self.conversationReply(TaskReply(text: message, phase: accepted ? .complete : .failed))
            }
        }
    }

    /// 送れなかった発話を預かる。考え中の面に出し、`answer` にも理由を残す（Home など Dock 以外の入口用）。
    func hold(_ text: String) {
        heldUtterance = text
        answer = "前の依頼に答えている途中です。「\(text)」はまだ送っていません。"
        if case .listening = mode { mode = .thinking }
    }

    /// 預かった発話を入力欄へ戻したら呼ぶ（戻したものは本人が送る）。
    func takeHeldUtterance() -> String? {
        defer { heldUtterance = nil }
        return heldUtterance
    }

    /// 聞くのをやめる（Esc）。マイクが開いている面に逃げ道の鍵が無いのは危ない。
    func cancelListening() {
        inputLevel = 0
        // 会話中の Esc は会話を終える（仕事は取り消さない）。
        if conversation.isActive { endConversation(.user); return }
        // 表示が何であっても、開いているマイクは閉じる（遅れて届く確定文も捨てる）。
        closeMicrophone()
        listeningPrefill = nil
        guard case .listening = mode else { return }
        listeningAwaitingAudio = true
        isListeningMuted = false
        mode = .idle
    }

    /// 認識の途中経過。**確定を待たずに** Dock へ出す（§Listening）。
    func updatePartial(_ text: String) {
        // 会話で答えのカードを残したまま次を聞いているとき、話し始めたら聞いている面へ移る。
        if conversation.isActive, !text.isEmpty {
            switch mode {
            case .answer, .info: mode = .listening(partial: "")
            default: break
            }
        }
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

    // MARK: - Genie と会話（段階 2）

    /// 会話を始める。一回の音声入力（`beginListening`）とは別の入口。
    func beginConversation() {
        guard GenieStateStore.shared.state.confirmation == nil, !conversation.isActive else { return }
        guard Permissions.microphone == .granted else {
            PermissionGuideCoordinator.shared.explain(.microphone) { [weak self] in self?.beginConversation() }
            return
        }
        if Permissions.speechRecognition == .notDetermined { Permissions.requestSpeechRecognition { _ in } }
        GenieSpeechOutput.shared.stop()
        // 本人が Gemini Live を有効にし、キーと月の上限を置いていればそれを使う。欠けていれば既存の経路。
        // 上限に達していたら始めない（**既存の経路へも黙って切り替えない**。何が起きたかを言う）。
        let gemini = GeminiLiveSettings.shared
        let provider: ConversationProvider
        if gemini.enabled, gemini.hasKey {
            let check = gemini.budget.canStart(at: Date())
            guard check.ok, let key = gemini.apiKey() else {
                answer = check.reason ?? "Gemini Live のキーを読めませんでした。"
                mode = .answer(answer)
                return
            }
            provider = GeminiLiveProvider(
                apiKey: key, settings: gemini,
                delegate: { [weak self] request in await self?.delegateFromConversation(request) ?? "not_accepted" },
                onLost: { [weak self] reason in
                    guard let self else { return }
                    self.answer = reason
                    self.endConversation(.providerLost)
                    self.mode = .answer(reason)
                })
        } else {
            provider = pipelineProvider
        }
        startConversation(using: provider)
        WindowCoordinator.shared.focusListeningDock()
        conversationClock?.cancel()
        conversationClock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, !Task.isCancelled else { return }
                self.tickConversation(now: Date())
            }
        }
    }

    /// 時計を進める（1 秒ごと。検査では時刻を渡す）。
    func tickConversation(now: Date) {
        run(conversation.tick(now: now))
        conversationRemaining = conversation.remaining(at: now)
    }

    /// 許可を確かめた後の本体。提供元を差し替えられる（検査では偽の提供元を渡す）。
    func startConversation(using provider: ConversationProvider, now: Date = Date()) {
        guard !conversation.isActive else { return }
        // 会議の録音中は、マイクを録音が使っている（会話は何も聞けないまま 5 分待つことになる）。始めずに言う。
        if RecordingWorkspaceState.shared.isRecording {
            answer = Facts.conversationDuringRecording
            mode = .answer(answer)
            return
        }
        // 音声入力で聞いている途中なら、そのマイクを閉じてから始める（開いたままだと会話のマイクが開けない）。
        closeMicrophone()
        conversationProvider = provider
        isListeningMuted = false
        observeSleep()
        run(conversation.start(now: now))
        GenieEventBus.shared.publish(.voiceSessionStarted(source: "dock"))
    }

    /// 検査・golden 用。マイクを開かずに会話中（聞いている）の姿を作る。`ending` は終わる前の知らせ。
    func presentConversationForShot(ending: Bool) {
        let now = Date()
        _ = conversation.start(now: now)
        _ = conversation.firstFrame(generation: conversation.generation)
        conversationRemaining = ending ? 24 : ConversationLoop.duration - 12
        conversationEnding = ending
        listeningAwaitingAudio = false
        mode = .listening(partial: "")
    }

    /// 検査・golden 用。会話の姿を片付ける（マイク・読み上げには触れない）。
    func clearConversationForShot() {
        conversation = ConversationLoop()
        conversationEnding = false
        conversationRemaining = 0
    }

    /// 会話を終える。**仕事は取り消さない**（止めるのは声だけ）。
    func endConversation(_ reason: ConversationLoop.EndReason = .user) {
        run(conversation.end(reason))
    }

    /// 読み上げだけを止める。会話は続き、次を聞く（会話を終えるのは `endConversation`）。
    func stopConversationSpeech() {
        run(conversation.stopSpeaking())
    }

    /// 本人の操作で 5 分延ばす（合計 15 分まで）。
    func extendConversation() {
        guard conversation.extend(now: Date()) else { return }
        conversationEnding = conversation.warned
        conversationRemaining = conversation.remaining(at: Date())
    }

    /// 会話の中身を運ぶ先。いまは既存の経路（Apple の認識 → gateway → macOS の読み上げ）。
    /// Gemini Live などは、この型を満たすものを足し、本人の明示の同意で切り替える。
    private(set) lazy var conversationProvider: ConversationProvider = pipelineProvider
    private lazy var pipelineProvider: ConversationProvider = PipelineConversationProvider(
        openMic: { [weak self] echo, first, utterance in
            self?.openMicrophone(echoCancellation: echo, onFirstFrame: first, onFinal: utterance) ?? false
        },
        closeMic: { [weak self] in self?.closeMicrophone() },
        submit: { [weak self] text, reply in
            self?.pendingConversationReply = reply
            self?.sendConversationTurn(text)
        })
    /// いま送ったターンの答えの受け口（1 回だけ呼ぶ）。
    private var pendingConversationReply: ((ConversationLoop.Reply) -> Void)?

    /// 会話の「やること」を実行する。状態は `ConversationLoop` だけが決め、実行は提供元に任せる。
    private func run(_ effects: [ConversationLoop.Effect]) {
        conversationRemaining = conversation.remaining(at: Date())
        for effect in effects {
            switch effect {
            case .openMicrophone(let g):
                inputLevel = 0
                listeningAwaitingAudio = true
                // 答えのカードは残したまま次を聞く（読み上げを聞き逃しても見返せる）。話し始めたら聞く面へ。
                let showingAnswer: Bool = switch mode { case .answer, .info: true; default: false }
                if GenieStateStore.shared.state.confirmation == nil, !showingAnswer { mode = .listening(partial: "") }
                if !openConversationMicrophone(generation: g) { run(conversation.end(.microphoneLost)) }
            case .closeMicrophone:
                conversationProvider.closeInput()
                inputLevel = 0
            case .send(let text):
                conversationProvider.send(text) { [weak self] reply in
                    guard let self else { return }
                    self.run(self.conversation.reply(reply))
                }
            case .speak(let text, let g):
                conversationProvider.speak(text) { [weak self] in
                    guard let self else { return }
                    self.run(self.conversation.speechFinished(generation: g))
                }
            case .stopSpeaking:
                conversationProvider.stopSpeaking()
            case .warnEnding:
                conversationEnding = true
            case .readyCue:
                // macOS 同梱の短い音。生成も通信もしない。
                NSSound(named: NSSound.Name("Pop"))?.play()
            case .ended(let reason):
                conversationProvider.endSession()
                conversationClock?.cancel(); conversationClock = nil
                pendingConversationReply = nil
                conversationEnding = false
                conversationRemaining = 0
                isListeningMuted = false
                listeningAwaitingAudio = true
                stopObservingSleep()
                // 聞いている姿だけを片付ける。回答・確認・仕事の表示はそのまま（仕事は続く）。
                if case .listening = mode { mode = .idle }
                GenieEventBus.shared.publish(.voiceSessionEnded(reason: reason.rawValue))
            }
        }
    }

    @discardableResult
    private func openConversationMicrophone(generation g: Int? = nil) -> Bool {
        let g = g ?? conversation.generation
        // エコー除去（voice processing）は使わない。この Mac で測ると、有効にしたマイクは完全な無音（最大振幅 0.000、
        // 除去なしは 0.206）で、会話で話しても文字にならなかった（--selftest micprobe）。半二重なので、
        // 読み上げの間はマイクを閉じていて、Genie の声は入らない。
        return conversationProvider.openInput(
            echoCancellation: false,
            onFirstFrame: { [weak self] in
                guard let self else { return }
                self.run(self.conversation.firstFrame(generation: g))
            },
            onUtterance: { [weak self] text in
                guard let self else { return }
                self.run(self.conversation.utterance(text, generation: g))
            })
    }

    /// 会話の提供元（Gemini Live）から仕事を頼まれた。Genie の既存の経路に渡し、受け付けたかだけを返す。
    /// 仕事の中身・結果の本文は提供元に返さない。
    func delegateFromConversation(_ request: String) async -> String {
        let text = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "empty_request" }
        return ask(text) ? "accepted" : (heldUtterance == text ? "busy_with_previous_request" : "not_accepted")
    }

    /// 会話の 1 ターンを送る。答えは `ask` の結果から `conversationReply` で返る。
    private func sendConversationTurn(_ text: String) {
        mode = .thinking
        if !ask(text) {
            deliverConversationReply(heldUtterance == text ? .held : .failed(answer.isEmpty ? "送れませんでした。" : answer))
        }
    }

    private func deliverConversationReply(_ reply: ConversationLoop.Reply) {
        guard let deliver = pendingConversationReply else { return }
        pendingConversationReply = nil
        deliver(reply)
    }

    /// `ask` の結果を会話へ返す（会話中で、答えを待っているときだけ）。
    private func conversationReply(_ reply: TaskReply?, draft: Bool = false, failed: String? = nil) {
        guard conversation.isActive, conversation.phase == .waiting else { return }
        if let failed { deliverConversationReply(.failed(failed)); return }
        guard let reply else { return }
        // 返信案の本文は読み上げない（宛先のある下書きを声で流さない）。確認カードを見てもらう。
        if draft, reply.settled { deliverConversationReply(.settled("返信案を用意しました。確認カードで内容を確かめてください。")); return }
        switch reply.phase {
        case .working, .waiting: deliverConversationReply(.working)
        case .failed, .cancelled: deliverConversationReply(.failed(reply.text))
        default: deliverConversationReply(.settled(reply.text))
        }
    }

    /// スリープ・画面ロックでは会話を終える（マイクを開いたまま離れない）。再開はしない。
    private func observeSleep() {
        guard sleepObservers.isEmpty else { return }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            sleepObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in VoiceHUDState.shared.endConversation(.sleep) }
            })
        }
    }

    private func stopObservingSleep() {
        sleepObservers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        sleepObservers.removeAll()
    }

    /// 認識した発話の行き先を決める（UI/UX テスト仕様 HUD-004 / P1 Context-aware Voice Routing）。
    ///
    /// 前面アプリにテキスト入力欄があれば**そこへ入れて終わり**。Agent 会話は始めない。
    /// 入力欄が無いときだけ Ask Genie に回す。推測で会話を始めないのが PASS 条件。
    ///
    /// ただし Listening の Dock がキー入力を受けている（入力欄が Dock にある）ときは、
    /// 話しかけた先は Genie なので、言い終えたらそのまま送る。以前はこの場合も前面アプリの
    /// 欄へ入れてしまい、「明日の天気は？」が別アプリに書き込まれて答えが返らなかった。
    /// 戻り値は「dictation として入れたか」。
    @discardableResult
    func speak(_ text: String) -> Bool {
        // 聞き終えたらマイクを閉じる（開きっぱなしにしない）。
        closeMicrophone()
        listeningAwaitingAudio = true
        switch listenPurpose {
        case .dictation:
            // 音声入力は文章を入れるだけ。入れる先が無ければ、送らずに「会話」を案内する。
            if Dictation.insert(text, excludingOwnProcess: true) {
                mode = .idle
                answer = ""
                return true
            }
            answer = (AXIsProcessTrusted() || Dictation.dryRun != nil) ? Facts.dictationNoField : Facts.dictationNeedsAccessibility
            mode = .answer(answer)
            return false
        case .meetingAsk:
            if Dictation.insert(text, excludingOwnProcess: true) {
                mode = .idle
                answer = ""
                return true
            }
            ask(text)
            return false
        }
    }

    /// 声/テキストの依頼を Agent に投げる。listening→thinking→answer→idle と状態を進める。
    @discardableResult
    func ask(_ text: String, newConversation: Bool = false, visualContext: [VisualContextArtifact]? = nil, consumerPlanning: ConsumerPlanningMode? = nil) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        // 前の依頼に答えている途中。**黙って捨てない**（以前は false を返すだけで、Dock は
        // マイクの閉じた Listening のまま残り、話した内容が消えていた）。預かって、考え中の面へ戻す。
        guard !requestInFlight else {
            hold(text)
            return false
        }
        GenieSpeechOutput.shared.stop()
        // Personal booking requests open an editable local preparation flow.
        // No gateway, model, address lookup, or paid operation happens here.
        // Explicit images keep their normal visual-question route.
        if consumerPlanning == nil, visualContext?.isEmpty != false,
           let kind = ConsumerJourneyKind.detect(text) {
            latestRequestID = nil; answer = ""; mode = .idle
            ConsumerJourneyStore.shared.present(kind, request: text)
            MainWindowController.shared.showSection(.home)
            conversationReply(TaskReply(text: "準備の画面を開きました。内容を確かめてください。", phase: .complete))
            return true
        }
        guard let base = apiBase, let token = apiToken else {
            answer = "接続を確認してください。入力した内容は残しています。"; mode = .idle; return false
        }
        // 「あと、テストも追加して」: 直前の仕事がまだ動いていれば、新しい依頼ではなくその仕事への追加指示。
        if consumerPlanning == nil, visualContext == nil, let target = followUpTarget(for: text) {
            sendInstruction(text, to: target, base: base, token: token)
            return true
        }
        // An explicit selection pins the image even if the user captures another one
        // or asks without a reference word. An explicitly empty array means no image.
        let attached = visualContext ?? VisualReferenceResolver.resolve(text: text, recent: VisualContextStore.shared.recent).images
        let attachments = VisualContextStore.shared.attach(attached)
        guard attachments.count == attached.count else {
            answer = "画像を読み込めませんでした。撮り直すか、画像を外して送信してください。質問は残しています。"
            return false
        }
        let receiptID = UUID().uuidString.lowercased()
        var requestRecord = TaskRequestRecord(request: text, base: base)
        if consumerPlanning == nil { requestRecord.turnRequestID = receiptID }
        let task = AgentTask(requestRecord: requestRecord,
            id: UUID(), title: TaskRequestRecord.title(for: text),
            status: .running, steps: [], startedAt: Date(), context: ContextBundle())
        guard LocalStore.shared.save(task) else {
            answer = "依頼を保存できませんでした。空き容量を確認してください。入力した内容は残しています。"
            return false
        }
        latestRequestID = task.id
        requestInFlight = true
        followingRequests.insert(task.id)
        if heldUtterance == text { heldUtterance = nil }
        listeningPrefill = nil
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
                    let saved = await MainActor.run {
                        VisualContextStore.shared.bind(conversationID: conv, preserving: Set(attached.map(\.id)))
                        return self?.updateRequest(task.id) { $0.conversationID = conv } ?? false
                    }
                    guard saved else { throw NSError(domain: "Genie", code: 1, userInfo: [NSLocalizedDescriptionKey: "受付IDを保存できませんでした。依頼は送信していません。"] ) }
                    outcome = try GenieCoreBridge.sendRecoverableTurn(base, accessToken: token, conversationId: conv,
                        requestId: receiptID, text: text, attachments: attachments, replyCandidatesJson: replyCandidates)

                }
                await MainActor.run {
                    self?.updateRequest(task.id) { $0.backendTaskID = outcome.taskId; $0.phase = .working }
                }
                // 承認待ちで止まったら、この依頼をいま出した本人に確認カードで聞く。
                // 押されたカードの承認だけを中継する。「やめる」なら REJECTED で、実行しない。
                // 答えが無い（時間切れ・カードが見えない）なら何も送らず、承認を待ったまま残す。
                let first = try await Self.settleApprovals(
                    Self.follow(outcome, base: base, token: token, waitMs: 12_000),
                    taskId: outcome.taskId, base: base, token: token, waitMs: 12_000)
                let reply = first.reply
                let draft: ReplyFlow.Draft? = await MainActor.run {
                    self?.applyReply(reply, to: task.id)
                    self?.answer = reply.text
                    // 短い確定回答や聞き返しは、その場で確認できるよう Dock に残す。
                    // 作業中・待機中は従来どおり静かな入口へ戻し、Work で追える状態にする。
                    // 会話が次のターンを聞いている間は、聞いている面を消さない（Gemini に頼んだ仕事の答えが後から来る）。
                    let conversationListening = (self?.conversation.isActive ?? false) && self?.conversation.phase != .waiting
                    if !conversationListening {
                        let hasText = !reply.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        if reply.settled && hasText {
                            self?.mode = Self.presentation(for: reply)
                        } else if self?.conversation.isActive == true, hasText {
                            // 会話中は静かな入口へ戻さない（会話の行＝状態と「会話を終了」が消え、マイクが開いたまま
                            // 何をしているか見えなくなる）。受け付けたことを面に出したまま次を聞く。
                            self?.mode = .answer(reply.text)
                        } else {
                            self?.mode = .idle
                        }
                    }
                    if reply.settled { VisualContextStore.shared.markRecent(attached) }
                    // 受け付けた（または答えた）。以降の待ちは記録の更新だけで、次の依頼を塞がない。
                    // 同じ依頼の二重送信は、ここまで（送信〜受付）を塞げば防げる。
                    self?.requestInFlight = false
                    self?.conversationReply(reply, draft: !outcome.replyJson.isEmpty)
                    guard reply.settled, !outcome.replyJson.isEmpty else { return nil }
                    return ReplyFlow.draft(replyJson: outcome.replyJson, body: reply.text)
                }
                // 返信案なら、答えとしてではなく確認カードとして出す（送るのは押されたときだけ）。
                if let draft { await ReplyFlow.shared.present(draft) }
                // 12 秒で終わらない仕事は、裏で待ち続けて届いたら差し替える（Dock は idle に戻す）。
                // カードに答えが無かったときは待ち続けない（同じカードを自動で出し直さない）。
                if !reply.settled, !first.leftPending, !outcome.taskId.isEmpty {
                    let later = try await Self.settleApprovals(
                        Self.follow(outcome, base: base, token: token, waitMs: 120_000),
                        taskId: outcome.taskId, base: base, token: token, waitMs: 120_000).reply
                    let laterDraft: ReplyFlow.Draft? = await MainActor.run {
                        self?.applyReply(later, to: task.id)
                        guard later.settled else { return nil }
                        // 後から届いた結果は Work に残る。Dock に出すのは、これがいちばん新しい依頼で、
                        // 会話が次のターンを聞いていないときだけ（聞いている面・新しい答えを上書きしない）。
                        if let self, self.latestRequestID == task.id, !self.conversation.isActive {
                            self.answer = later.text
                            if !later.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                self.mode = Self.presentation(for: later)
                            }
                        }
                        VisualContextStore.shared.markRecent(attached)
                        guard !outcome.replyJson.isEmpty else { return nil }
                        return ReplyFlow.draft(replyJson: outcome.replyJson, body: later.text)
                    }
                    if let laterDraft { await ReplyFlow.shared.present(laterDraft) }
                }
                await MainActor.run { _ = self?.followingRequests.remove(task.id) }
            } catch {
                await MainActor.run {
                    self?.updateRequest(task.id) {
                        $0.phase = .unknown
                        $0.message = $0.backendTaskID.isEmpty
                            ? ($0.canRefresh ? "受付を確認できませんでした。「状況を確認」で照会できます。依頼は再送しません。" : "受付を確認できませんでした。二重実行を防ぐため、自動では再送しません。")
                            : "通信が切れました。状況を確認すると、同じ仕事の続きが読み込まれます。"
                    }
                    // 解くのは、この依頼がまだ「いまの依頼」のときだけ。受付の後に後追いで失敗しても、
                    // その間に始まった新しい依頼の送信中を解かない（二重送信を防げなくなる）。
                    if let self, self.latestRequestID == task.id {
                        self.answer = "接続を確認してください。依頼と現在の状況は Work に保存されています。"
                        if !self.conversation.isActive { self.mode = .idle }
                        self.requestInFlight = false
                    }
                    // 会話へ返すのは、この依頼がまだいまの依頼のとき（後から始まったターンの答えにしない）。
                    if self?.latestRequestID == task.id {
                        self?.conversationReply(nil, failed: "接続できませんでした。依頼は Work に残っています。")
                    }
                    self?.followingRequests.remove(task.id)
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
    /// **読むだけで、承認には答えない**（承認待ちは `.waiting` で返る）。
    nonisolated static func followUp(_ outcome: TurnOutcome, base: String, token: String, waitMs: UInt64) throws -> TaskReply {
        try follow(outcome, base: base, token: token, waitMs: waitMs).reply
    }

    /// `followUp` の中身。承認待ちで止まっていたら、カードに出す承認（`pendingApprovals`）を持って帰る。
    ///
    /// **ここは読むだけ。** 以前はここで WAITING_APPROVAL を見るとカードを出さずに APPROVED を中継し、
    /// しかも待つ時間を `min(waitMs, 2000)` に縮めていた。いまは waitMs の期限まで待ち、
    /// 承認待ちを早く見つけるためだけに 2 秒以下の区切りで状態を読み直す。
    nonisolated static func follow(_ outcome: TurnOutcome, base: String, token: String, waitMs: UInt64) throws -> TaskFollowUp {
        try follow(outcome, waitMs: waitMs, reader: .live(base: base, token: token, taskId: outcome.taskId))
    }

    /// 上の本体。読む先（`TaskReader`）を差し替えられる —— 待つ時間の合計を検査で数えるため
    /// （`min(waitMs, 2000)` の書き戻しは、ここを通る検査で落ちる）。
    nonisolated static func follow(_ outcome: TurnOutcome, waitMs: UInt64, reader: TaskReader) throws -> TaskFollowUp {
        if outcome.needsClarification {
            return TaskFollowUp(reply: TaskReply(text: outcome.answer.isEmpty ? "目的や条件をもう少し詳しく教えてください。" : outcome.answer, phase: .needsInput))
        }
        if !outcome.answer.isEmpty { return TaskFollowUp(reply: TaskReply(text: outcome.answer, phase: .complete)) }
        if !outcome.taskId.isEmpty {
            // WAITING_APPROVAL でも PENDING の承認が 1 件も無いのは、答え（承認）を届けた直後で、
            // backend が状態を RUNNING に戻すのを待っているところ（decideApproval は行を先に APPROVED にし、
            // 状態を戻すのは後で動く activity）。ここで返すと「まだ実行していません」と出して追うのをやめ、
            // 動いている computer.run の結果が届かない。**期限までは実行中と同じに待ち続ける。**
            let deadline = reader.now().addingTimeInterval(Double(waitMs) / 1000)
            while true {
                let remaining = UInt64(max(0, deadline.timeIntervalSince(reader.now())) * 1000)
                let done = try waitForTask(waitMs: remaining, now: reader.now, pause: reader.pause, wait: reader.wait)
                let reply = try taskReply(status: done.status, artifactID: done.resultArtifactId) {
                    try reader.content(done.resultArtifactId)
                }
                guard TaskWaitState(status: done.status) == .approvalPending else { return TaskFollowUp(reply: reply) }
                // 読めなければ空のまま返す（カードは出さない＝承認しない）。
                guard let pending = try? reader.approvals() else { return TaskFollowUp(reply: reply) }
                if !pending.isEmpty { return TaskFollowUp(reply: reply, pendingApprovals: pending) }
                guard reader.now() < deadline else {
                    return TaskFollowUp(reply: TaskReply(text: "確認を待っている承認はありません。仕事が次に進むのを待っています。「状況を確認」で現在の状態を確かめられます。", phase: .waiting))
                }
                reader.pause(min(1_000, UInt64(max(0, deadline.timeIntervalSince(reader.now())) * 1000)))
            }
        }
        return TaskFollowUp(reply: TaskReply(text: outcome.notice.isEmpty ? "結果を確認できませんでした。依頼は自動で再送されません。" : outcome.notice, phase: .needsInput))
    }

    /// waitMs の期限まで待つ。終わる（COMPLETED / FAILED / CANCELLED）か承認待ちになったら、そこで返す。
    ///
    /// core の `waitTask` は終わるまでしか返らないので、承認待ちに気づけるよう `slice` 以下に区切って呼ぶ。
    /// 区切っても**待つ時間の合計は waitMs のまま**（区切りで諦めない）。`now` / `pause` は検査で差し替える。
    ///
    /// **区切りの終わりの一時的な失敗で諦めない。**core は経過が timeout に達した読み取りの失敗を
    /// 再試行せずに返すので、2 秒の区切りでは各区切りの最後の読み取りが必ずそれに当たる。
    /// 一時的な失敗（通信・502/503/504）は区切りをまたいで数え、続けて `transientLimit` 回までは
    /// 少し置いて読み直す。認証・権限・429 などは読み直さない（core と同じ線引き）。
    nonisolated static func waitForTask(waitMs: UInt64, slice: UInt64 = 2_000, transientLimit: Int = 3,
                                        now: () -> Date = Date.init,
                                        pause: (UInt64) -> Void = { Thread.sleep(forTimeInterval: Double($0) / 1000) },
                                        wait: (UInt64) throws -> TaskStatus) rethrows -> TaskStatus {
        let deadline = now().addingTimeInterval(Double(waitMs) / 1000)
        var transient = 0
        while true {
            let remaining = UInt64(max(0, deadline.timeIntervalSince(now())) * 1000)
            let status: TaskStatus
            do {
                status = try wait(min(max(remaining, 1), slice))
                transient = 0
            } catch where isTransient(error) {
                transient += 1
                if transient >= transientLimit || now() >= deadline { throw error }
                pause(min(1_000, UInt64(max(0, deadline.timeIntervalSince(now())) * 1000)))
                continue
            }
            if TaskWaitState(status: status.status) != .running || now() >= deadline { return status }
        }
    }

    /// 読み直してよい失敗か。既存の仕事を読み直すだけで、仕事を作り直したり認証をやり直したりはしない。
    nonisolated static func isTransient(_ error: Error) -> Bool {
        switch error as? ApiError {
        case .Network?: return true
        case .Server(let status, _)?: return [502, 503, 504].contains(status)
        default: return false
        }
    }

    /// 承認待ちで止まった仕事を、本人の確認カードに 1 件ずつ通す。呼ぶのは `ask`（いま依頼した人）と
    /// 「状況を確認」を押したときだけ。Work を開いた（onAppear）だけでは呼ばない。
    ///
    /// 中継するのは**カードに出した承認の id だけ**で、`Confirm.approve` が返した証拠を添える。
    /// REJECTED を送るのは人が「やめる」/ Escape を押したときだけ。時間切れ・カードが見えない・
    /// 窓を出せないときは**何も送らず**、承認は PENDING のまま残す（「状況を確認」で出し直せる）。
    nonisolated static func settleApprovals(_ first: TaskFollowUp, taskId: String, base: String, token: String,
                                            waitMs: UInt64) async throws -> TaskFollowUp {
        let outcome = TurnOutcome(needsClarification: false, answer: "", taskId: taskId, notice: "", replyJson: "")
        return try await settleApprovals(first, waitMs: waitMs,
            approve: { id, proof in try GenieCoreBridge.taskApprove(base, accessToken: token, taskId: taskId, approvalId: id, approval: proof) },
            reject: { id in try GenieCoreBridge.taskReject(base, accessToken: token, taskId: taskId, approvalId: id) },
            follow: { ms in try follow(outcome, base: base, token: token, waitMs: ms) })
    }

    /// 上の本体。送る先・聞く面を差し替えられる（検査用。証拠は `Confirm` でしか作れないので、
    /// 差し替えても「押されていないのに APPROVED」は作れない）。
    nonisolated static func settleApprovals(
        _ first: TaskFollowUp, waitMs: UInt64,
        ask: @escaping @MainActor (ActionConfirmation) async -> ApprovalAnswer = { await Confirm.approve($0) },
        approve: (String, consuming UserApproval) throws -> Void,
        reject: (String) throws -> Void,
        follow: (UInt64) throws -> TaskFollowUp
    ) async throws -> TaskFollowUp {
        var current = first
        var shown: Set<String> = []
        while let approval = current.pendingApprovals.first(where: { !shown.contains($0.id) }) {
            shown.insert(approval.id)
            let card = ActionConfirmation(backendApproval: approval)
            let answer = await ask(card)
            switch consume answer {
            case .approved(let proof):
                do { try approve(approval.id, proof) } catch {
                    return TaskFollowUp(reply: TaskReply(text: "承認を届けられませんでした。「状況を確認」で現在の状態を確かめられます。", phase: .unknown))
                }
            case .declined:
                let rejected = (try? reject(approval.id)) != nil
                return TaskFollowUp(reply: rejected
                    ? TaskReply(text: "確認で承認されなかったため、この操作は実行していません。", phase: .cancelled)
                    : TaskReply(text: "確認で承認されなかったため、この操作は実行していません。取り消しを届けられなかったので、「状況を確認」で現在の状態を確かめてください。", phase: .unknown))
            case .unanswered:
                // 答えが無いのは「やめた」ではない。取り消さずに、承認を待ったまま返す。
                return TaskFollowUp(reply: TaskReply(text: "承認待ちです。この操作はまだ実行していません。「状況を確認」で確認カードを出し直せます。", phase: .waiting),
                                    leftPending: true)
            }
            current = try follow(waitMs)
        }
        return current
    }

    /// 答えの見せ方。天気・ニュースでカードに描くものがあればカード、無ければ文。
    nonisolated static func presentation(for reply: TaskReply) -> DockPresentation {
        if let card = reply.info, card.hasContent { return .info(card) }
        return .answer(reply.text)
    }

    nonisolated static func taskReply(status: String, artifactID: String, content: () throws -> String) rethrows -> TaskReply {
        switch status {
        case "COMPLETED":
            guard !artifactID.isEmpty else { return TaskReply(text: "処理は終了しましたが、成果物は返されませんでした。", phase: .needsInput) }
            let body = try content()
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return TaskReply(text: "成果物の内容が空でした。状況を確認してください。", phase: .needsInput, artifactID: artifactID)
            }
            // 天気・ニュースは JSON の成果物。カードと、そのまま読める文に分ける。
            if let card = InfoCard.decode(body) {
                return TaskReply(text: card.text, phase: .complete, artifactID: artifactID, info: card)
            }
            return TaskReply(text: body, phase: .complete, artifactID: artifactID)
        case "FAILED": return TaskReply(text: "処理を完了できませんでした。依頼を見直すか、接続を確認してください。", phase: .failed)
        case "CANCELLED": return TaskReply(text: "この仕事は取り消されました。", phase: .cancelled)
        case "PAUSED_HOST_OFFLINE":
            return TaskReply(text: "実行する端末に接続できません。Genie の実行サービスが起動すると続行できます。", phase: .waiting)
        case "WAITING_APPROVAL", "AWAITING_APPROVAL":
            return TaskReply(text: "実行の前に確認が必要です。「状況を確認」を押すと確認カードが開きます。この操作はまだ実行していません。", phase: .waiting)
        case "WAITING_USER", "BLOCKED", "HANDED_OFF":
            return TaskReply(text: "続行に必要な確認や接続を待っています。承認は Genie の確認画面から行ってください。", phase: .waiting)
        default: return TaskReply(text: "作成を続けています。この画面を離れても、Work から結果を確認できます。", phase: .working)
        }
    }

    @discardableResult
    func updateRequest(_ id: UUID, store: LocalStore = .shared, change: (inout TaskRequestRecord) -> Void) -> Bool {
        guard var task = unsavedRequests[id] ?? store.loadTasks().first(where: { $0.id == id }),
              var record = task.requestRecord else { return false }
        change(&record); record.updatedAt = Date()
        task.requestRecord = record; task.status = record.phase.runState
        if store.save(task) { unsavedRequests.removeValue(forKey: id); return true }
        unsavedRequests[id] = task
        return false
    }

    func savePendingRequest(_ id: UUID, store: LocalStore = .shared) {
        guard let task = unsavedRequests[id], store.save(task) else { return }
        unsavedRequests.removeValue(forKey: id)
    }

    private func applyReply(_ reply: TaskReply, to id: UUID) {
        updateRequest(id) {
            $0.phase = reply.phase; $0.artifactID = reply.artifactID
            if reply.phase == .complete { $0.result = reply.text; $0.message = "" }
            else { $0.message = reply.text }
        }
    }

    /// Read the existing backend job only. Never create a conversation or resend a turn.
    /// By default (`interactive: false` — opening the task in Work, self-tests) this writes nothing, even when the job
    /// waits for approval. Only `interactive` (the user pressed 状況を確認) may show the confirmation card for a
    /// pending approval; then the one write is that card's answer (APPROVED with the card's proof, or REJECTED).
    func refreshRequest(_ id: UUID, interactive: Bool = false) {
        guard !refreshingRequests.contains(id),
              let record = (unsavedRequests[id] ?? LocalStore.shared.loadTasks().first(where: { $0.id == id }))?.requestRecord,
              record.canRefresh else { return }
        guard let base = apiBase, let token = apiToken, base == record.base else {
            updateRequest(id) { $0.message = "この仕事を依頼した接続が見つかりません。接続を確認してください。" }
            return
        }
        // The initial submit is already waiting for this job; don't start another poll.
        guard !(requestInFlight && latestRequestID == id), !followingRequests.contains(id) else { return }
        refreshingRequests.insert(id)
        Task.detached { [weak self] in
            do {
                let outcome: TurnOutcome
                if record.backendTaskID.isEmpty {
                    guard let receipt = record.turnRequestID,
                          let recovered = try GenieCoreBridge.recoverTurn(base, accessToken: token, conversationId: record.conversationID, requestId: receipt) else {
                        await MainActor.run {
                            self?.updateRequest(id) { $0.phase = .unknown; $0.message = "受付の処理結果はまだ確認できません。時間をおいて状況を確認してください。依頼は再送しません。" }
                            self?.refreshingRequests.remove(id)
                        }
                        return
                    }
                    outcome = recovered
                    await MainActor.run { self?.updateRequest(id) { $0.backendTaskID = recovered.taskId } }
                } else {
                    outcome = TurnOutcome(needsClarification: false, answer: "", taskId: record.backendTaskID, notice: "", replyJson: "")
                }
                let first = try Self.follow(outcome, base: base, token: token, waitMs: 12_000)
                let reply = interactive
                    ? try await Self.settleApprovals(first, taskId: outcome.taskId, base: base, token: token, waitMs: 12_000).reply
                    : first.reply
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
