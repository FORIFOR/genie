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
    var outcomeContext: () throws -> TaskOutcomeContext? = { nil }
    var now: () -> Date = Date.init
    var pause: (UInt64) -> Void = { Thread.sleep(forTimeInterval: Double($0) / 1000) }

    /// 本物の読み先。**待つのは `VoiceHUDState.waitForTask` の区切りだけ**で、ここは 1 区切りを読む。
    static func live(base: String, token: String, taskId: String) -> TaskReader {
        TaskReader(
            wait: { try GenieCoreBridge.waitTask(base, accessToken: token, taskId: taskId, timeoutMs: $0) },
            content: { try GenieCoreBridge.artifactContent(base, accessToken: token, artifactId: $0) },
            approvals: { try GenieCoreBridge.pendingApprovals(base, accessToken: token, taskId: taskId) },
            outcomeContext: {
                let json = try GenieCoreBridge.taskGet(base, accessToken: token, taskId: taskId)
                guard let context = TaskOutcomeContext.decode(json) else { throw ApiError.Decode(message: "仕事の結果を読み取れませんでした。") }
                return context
            })
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

/// Voice state tests replace device I/O while exercising the same entry and stop paths.
/// Production always uses RecordingRuntime, including its permission and generation gates.
@MainActor
struct VoiceCaptureInput {
    var begin: (Bool, @escaping () -> Void, @escaping (String) -> Void, @escaping (String) -> Void) -> Bool
    var end: () -> Void
    var isListening: () -> Bool

    static var live: Self {
        Self(begin: { echoCancellation, firstFrame, partial, final in
            RecordingRuntime.shared.beginVoiceListening(echoCancellation: echoCancellation,
                onFirstFrame: firstFrame, onPartial: partial, onFinal: final)
        }, end: { RecordingRuntime.shared.endVoiceListening() },
             isListening: { RecordingRuntime.shared.voiceListening })
    }
}

/// 上部 Voice OS ピルの状態。idle は静か、listening は声を拾っている、thinking は Agent に問い合わせ中。
/// 実フロー: ショートカット→声/テキストの依頼→`ask()`→thinking→Agent 応答→回答面（または idle）。
@MainActor
final class VoiceHUDState: ObservableObject {
    static let shared = VoiceHUDState()
    var voiceCapture: VoiceCaptureInput = .live
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
    /// 会話で聞いている間の波形。届いた音量の新しい順に最大 `inputLevelHistory` 個（古いものから捨てる）。
    @Published private(set) var inputLevels: [CGFloat] = []
    static let inputLevelHistory = 14

    func receiveInputLevel(_ level: Float) {
        // 会話で聞いている間は、面が答えのカードでもオーブへ大きさを渡す（オーブが声に反応する）。
        let conversationListening = conversation.isActive && conversation.phase == .listening
        if !conversationListening { guard case .listening = mode else { return } }
        guard !listeningAwaitingAudio else { return }
        inputLevel = LiquidOrbMotion.clampedLevel(level)
        inputLevels = Array((inputLevels + [CGFloat(inputLevel)]).suffix(Self.inputLevelHistory))
    }

    /// 検査・golden 用。実マイクを開けない撮影で「取り込めている姿」を作る
    /// （録音側の `markListening` と同じ役割）。
    func markVoiceCaptureLive() { listeningAwaitingAudio = false }

    /// 検査・golden 用。「まだ取り込めていない姿（準備中…）」を作る。
    func beginPreparingForShot() { listeningAwaitingAudio = true; inputLevel = 0; inputLevels = [] }

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
        TransactionAuthorizationState.shared.configure(base: base, token: token)
    }

    /// 声を使い始める。§26 マイクだけを、この瞬間に要求する。
    ///
    /// **実際に取り込む。**面は先に出すが、見出しは最初の音声フレームが届くまで「準備中…」で、
    /// 「聞いています…」と名乗るのはそれからにする（UI の意味と実装状態を一致させる）。
    /// 一回の音声入力の使い道。Genie に話しかけるのは「会話」（`beginConversation`）。
    enum ListenPurpose { case dictation, meetingAsk }
    private(set) var listenPurpose: ListenPurpose = .dictation
    /// 音声入力で文字を入れる先のアプリ（始めたときの前面）。
    private(set) var dictationTargetPID: pid_t?

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
        // 入れる先は、始めたときに前面にあったアプリ（Dock を押しても前面のアプリは変わらない）。
        dictationTargetPID = Dictation.frontmostOtherAppPID()
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
        // 確認カードに答えを待っている間も、本人が始めた聞き取りは前に出る。終われば同じカードへ戻る
        // （`DockComposer`。カードは 120 秒待ち、答えが無ければ承認しないまま残す＝勝手に承認・却下しない）。
        // 声でカードには答えない。
        // 会話の途中で音声入力を始めたら、会話を先に終える。持ち主の無い stop() は会話の読み上げの
        // 終わりの合図を鳴らし、会話がマイクを開き直して音声入力とぶつかっていた。
        if conversation.isActive { endConversation(.replaced) }
        GenieSpeechOutput.shared.stop()
        inputLevel = 0
        inputLevels = []
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
        // 音声入力では Dock にキーを取らない（入れる先は前面のアプリの欄。キーを奪うと、そのアプリの
        // 入力中の状態を崩し、欄の判定も Genie 自身を指していた）。会議の問いは Dock の欄で受ける。
        if listenPurpose != .dictation { WindowCoordinator.shared.focusListeningDock() }
        GenieEventBus.shared.publish(.voiceStarted)
        if listenPurpose == .dictation {
            // 音声入力は続けて聞く。区切り（息継ぎの間）ごとに、いま見ている画面の欄へ入れる。
            dictationStatus = nil
            lastDictated = nil
            dictatedSegments = 0
            dictationInsertedPID = nil
            openMicrophone(onFinal: { [weak self] text in self?.dictateSegment(text) })
            armDictationIdle()
        } else {
            openMicrophone()
        }
    }

    // MARK: - 音声入力（続けて聞き、区切りごとに入れる）

    /// 直前の区切りの結果（「<アプリ> に入れました」/ 入れられなかった理由）。聞く面に出す。
    @Published private(set) var dictationStatus: String?
    /// 直前に入れた区切り（「元に戻す」用）。
    @Published private(set) var lastDictated: DictatedText?
    /// この音声入力で入れた区切りの数（検査・表示用）。
    @Published private(set) var dictatedSegments = 0
    /// この音声入力で文を入れたアプリ（送信の Return はここにだけ押す）。
    private var dictationInsertedPID: pid_t?
    private var dictationIdleGeneration = 0

    /// 区切りの文を、いま見ている画面のフォーカス中の欄へ入れる。マイクは開いたまま次を聞く。
    func dictateSegment(_ text: String) {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, listenPurpose == .dictation else { return }
        let cleaned = DictationCleanup.terminated(DictationCleanup.clean(raw))
        let pid = Dictation.targetPID()
        let report = Dictation.insertReporting(cleaned, appPID: pid)
        if report.ok {
            dictationInsertedPID = pid
            lastDictated = DictatedText(inserted: cleaned, original: DictationCleanup.terminated(raw), appPID: pid)
            dictatedSegments += 1
            dictationStatus = Facts.dictationInserted(report.app, cleaned: cleaned != DictationCleanup.terminated(raw))
        } else {
            lastDictated = nil
            dictationStatus = Facts.dictationNotInserted(report.app, reason: report.method)
        }
        // 次の区切りに備えて、聞く面の途中の文を空にする。結果の行が出るので面の高さを合わせる。
        if case .listening = mode { mode = .listening(partial: "") }
        WindowCoordinator.shared.syncDockPanels()
        armDictationIdle()
    }

    /// 音声入力の「送信」: まだ入れていない文を入れ、入れた先のアプリで Return を押し、聞くのを終える。
    /// 先にマイクを閉じる（後から同じ文の確定が届いて二重に入らないように）。
    func sendDictation(pending: String) {
        guard listenPurpose == .dictation else { return }
        closeMicrophone()
        let rest = pending.trimmingCharacters(in: .whitespacesAndNewlines)
        // Return を押すのは、この音声入力で文を入れたアプリだけ。そのアプリが前面で、欄にカーソルがあるときだけ。
        // 以前は前面のアプリならどこでも押した（文を入れていないアプリで Return が押され得た）。
        var pid = dictationInsertedPID
        if !rest.isEmpty {
            let target = pid ?? Dictation.targetPID()
            let report = Dictation.insertReporting(DictationCleanup.terminated(DictationCleanup.clean(rest)), appPID: target)
            guard report.ok else {
                answer = Facts.dictationNotInserted(report.app, reason: report.method)
                mode = .answer(answer)
                return
            }
            pid = target
        }
        guard let pid, Dictation.frontmostOtherAppPID() == pid, Dictation.acceptsTyping(appPID: pid),
              Dictation.pressReturn(in: pid) else {
            answer = Facts.dictationSendFailed
            mode = .answer(answer)
            return
        }
        listeningAwaitingAudio = true
        dictationStatus = nil
        lastDictated = nil
        mode = .idle
    }

    /// 30 秒話さなければ音声入力を終える（マイクを開いたままにしない）。
    private func armDictationIdle() {
        dictationIdleGeneration += 1
        let generation = dictationIdleGeneration
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            // 会話のマイクはこの音声入力用の見張りの対象外（会話には会話の時間切れがある）。
            // 以前は会話中にこれが働き、黙って 30 秒で会話が終わっていた（genie.log 2026-10-04）。
            guard let self, self.dictationIdleGeneration == generation, self.listenPurpose == .dictation,
                  !self.conversation.isActive,
                  case .listening(let partial) = self.mode, partial.isEmpty else { return }
            self.cancelListening()
        }
    }

    /// マイクを開く。コールバックは**この世代のものだけ**受け付ける。
    /// 戻り値は「取り込みを始められたか」（会議の録音中は録音側の STT を使うので true 扱い）。
    @discardableResult
    private func openMicrophone(echoCancellation: Bool = false, onFirstFrame: (() -> Void)? = nil, onFinal: ((String) -> Void)? = nil) -> Bool {
        // 「ジーニー」の待ち受けがマイクを持っていれば返してもらう（二重に開かない）。
        WakeWordListener.shared.suspend()
        let generation = voice.open()
        let started = voiceCapture.begin(
            echoCancellation,
            { [weak self] in
                guard let self, self.voice.isCurrent(generation) else { return }
                self.listeningAwaitingAudio = false
                onFirstFrame?()
            },
            { [weak self] text in
                guard let self, self.voice.isCurrent(generation), !self.isListeningMuted else { return }
                self.updatePartial(text)
            },
            { [weak self] text in
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
        voiceCapture.end()
    }

    /// マイクの聞き取りを一時停止/再開する（ミュート切り替え）。
    func toggleListeningMute() {
        isListeningMuted.toggle()
        if isListeningMuted {
            // 会話では、音を運んでいるのは提供元（Gemini は自前のマイクで送る）。そちらを止める。
            if conversation.isActive { conversationProvider.closeInput() } else { closeMicrophone() }
            inputLevel = 0
            inputLevels = []
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
    func cancelListening(caller: String? = nil, file: String = #fileID, line: Int = #line) {
        let caller = caller ?? "\(file):\(line)"
        inputLevel = 0
        inputLevels = []
        // 会話中の Esc は会話を終える（仕事は取り消さない）。
        if conversation.isActive { endConversation(.user, caller: "cancelListening ← \(caller)"); return }
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
        if listenPurpose == .dictation, !text.isEmpty { armDictationIdle() }
        // 会話で答えのカードを残したまま次を聞いているとき、話し始めたら聞いている面へ移る。
        if conversation.isActive, !text.isEmpty {
            switch mode {
            case .answer, .card: mode = .listening(partial: "")
            default: break
            }
        }
        guard case .listening = mode else { return }
        mode = .listening(partial: text)
        GenieEventBus.shared.publish(.voicePartial(text))
    }

    // MARK: - Dock の仕事の一覧（声・文字の依頼）

    /// backend に仕事ができた依頼を、Dock の一覧の 1 行にする。止めるは backend の取り消し。
    func trackOnDock(_ id: UUID, title: String, backendTaskId: String, base: String, token: String,
                     taskKind: String? = nil) {
        let store = GenieStateStore.shared
        store.apply(store.event(id, .started(title: title, step: Facts.taskWorking)))
        let transaction = taskKind?.hasPrefix("transaction.") == true
        let uncertain = transaction || taskKind == nil
        let detail = transaction ? TaskOutcomeContext.stoppingTransaction
            : (taskKind == nil ? TaskOutcomeContext.stoppingUnidentifiedTask : Facts.taskStoppedDetail)
        store.setStopHandler(id, detail: detail) { [weak self] in
            self?.updateRequest(id) {
                $0.stopRequested = true
                $0.phase = uncertain ? .unknown : .cancelled
                $0.transactionResultUnknown = transaction
                $0.message = detail
            }
            Task.detached {
                do { _ = try GenieCoreBridge.cancelTask(base, accessToken: token, taskId: backendTaskId) }
                catch { NSLog("dock: cancel not delivered: \(error)") }
            }
        }
    }

    func dockEvent(_ id: UUID, _ kind: DockTaskEvent.Kind) {
        let store = GenieStateStore.shared
        store.apply(store.event(id, kind))
    }

    /// すぐ答えが出た・追うのをやめた依頼を一覧から外す（Work には残る）。
    func dropFromDock(_ id: UUID) { GenieStateStore.shared.discardTask(id) }

    /// 依頼の結果を一覧の結果にする。**成果物を確かめられた完了だけが完了**（`taskReply` が本文を読んでいる）。
    func finishOnDock(_ id: UUID, reply: TaskReply, title: String) {
        if reply.transactionResultUnknown {
            // A repeated submission is unsafe; retain the explanation without a retry action.
            dockEvent(id, .unconfirmed(reply.text))
            return
        }
        switch reply.phase {
        case .complete where !reply.artifactID.isEmpty:
            dockEvent(id, .succeeded(DockArtifact(kind: Facts.resultKindAnswer, title: title,
                                                  detail: Facts.resultLength(reply.text.count),
                                                  actions: [.openWorkspace, .copy])))
        case .cancelled: dockEvent(id, .cancelled(reply.text))
        case .working, .submitting: break
        case .waiting: dockEvent(id, .awaitingApproval)
        default: dockEvent(id, .failed(reply.text))
        }
    }

    /// 「元の文に戻す」。入れた欄の中で、整えた文を元の文へ差し替える。
    func restoreDictated(_ notice: DictatedText) {
        if Dictation.replaceInserted(notice.inserted, with: notice.original, appPID: notice.appPID) {
            // 続けて聞いている間は聞く面のまま（戻したことだけ書く）。
            if case .listening = mode { dictationStatus = Facts.dictationRestored; lastDictated = nil } else { mode = .idle }
        } else {
            answer = Facts.dictationRestoreFailed
            mode = .answer(answer)
        }
    }

    private var lastDock: DockPresentation = .idle

    /// 一時的な面（Quick Actions・文脈の棚・提案を開いた面）が出ている間だけ、**ほかのアプリにキーがあっても**
    /// Esc で閉じる。開いた後に別のアプリを触る・スクリーンショットを撮ると、キーはそちらへ移り、
    /// Dock の Esc（`escapeKey`）が届かなかった（2026-09-29 実機）。Esc は元のアプリにも届く（奪わない）。
    /// ほかのアプリのキーを見るにはアクセシビリティの許可が要る（無ければ Dock がキーのときの Esc だけ）。
    private var escapeMonitor: Any?

    private func updateEscapeMonitor(for dock: DockPresentation) {
        let transient: Bool = switch dock {
        case .quickActions, .contextDetail, .appContextExpanded: true
        default: false
        }
        if transient, escapeMonitor == nil, !WindowCoordinator.headless {
            escapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
                guard event.keyCode == 53 else { return }
                Task { @MainActor in VoiceHUDState.shared.closeTransientSurface() }
            }
        } else if !transient, let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
            escapeMonitor = nil
        }
    }

    /// 一時的な面を閉じる（Esc）。聞いている・考えている・結果の面には触らない。
    func closeTransientSurface() {
        switch mode {
        case .quickActions, .contextDetail: mode = .idle
        case .appContextExpanded(let s): mode = .appContext(s)
        default: break
        }
    }

    /// 会話を終わらせた面（診断用）。
    private(set) var lastConversationReplacedBy = ""

    /// いま聞く面を出しているか（遅れて届いた答えで、聞いている途中を消さないため）。
    var isListeningSurface: Bool { if case .listening = mode { return true }; return false }

    /// Dock の面が変わったとき（`GenieStateStore.applyDock` から）。
    ///
    /// マイクを開いている間は、それを示して止められる面（会話なら会話の行がある面、音声入力なら聞く面）
    /// だけにする。以前は遅れて届いた答え・メニューの「操作を出す」・Dock のクリックが面だけを差し替え、
    /// 面は待機なのにマイクが回り続けた（2026-09-28 実機。メニューバーのマイクの印が消えない）。
    /// 面の方が変わったら、声の側を合わせて閉じる。仕事は取り消さない。
    func dockChanged(to dock: DockPresentation) {
        // Quick Actions を離れたら、借りていたキー入力を元のアプリへ返す。
        // 会話・会議の問いは、このあと自分で Dock にキーを取り直す（音声入力は取らない）。
        if lastDock == .quickActions, dock != .quickActions { WindowCoordinator.shared.releaseDockKey() }
        lastDock = dock
        updateEscapeMonitor(for: dock)
        if conversation.isActive {
            switch dock {
            case .listening, .thinking, .answer, .card, .ack: return
            default:
                // どの面に替わって会話が終わったかを控える（呼んでも続かないときの調べ）。
                lastConversationReplacedBy = String(String(describing: dock).prefix(60))
                endConversation(.replaced, caller: "dock → \(lastConversationReplacedBy)")
            }
            return
        }
        if case .listening = dock { return }
        guard voiceCapture.isListening() else { return }
        closeMicrophone()
        inputLevel = 0
        inputLevels = []
        listeningAwaitingAudio = true
        isListeningMuted = false
        listeningPrefill = nil
    }

    /// 考え中の面で Esc。声（会話）は止め、面は静かな入口へ戻す。依頼は取り消さない
    /// （答えは届けば Dock と Work に出る。二重送信を防ぐため送信中の印はそのまま）。
    func leaveThinking(caller: String? = nil, file: String = #fileID, line: Int = #line) {
        let caller = caller ?? "\(file):\(line)"
        if conversation.isActive { endConversation(.user, caller: "leaveThinking ← \(caller)") }
        if case .thinking = mode { mode = .idle }
    }

    /// Dock 本体のクリック。窓は増やさず、Dock 自身が Quick Actions の姿になる。
    func toggleQuickActions() {
        // Quick Actions の面には「聞いています」も止める手も無い。マイクや会話を開いたまま
        // 面だけ差し替えると、メニューバーにマイクの印が出たまま止め方が消える（2026-09-28 実機）。
        // 先に閉じてから開く（`--selftest micrelease`）。
        if conversation.isActive || voiceCapture.isListening() { cancelListening(caller: "Dock click (Quick Actions)") }
        mode = mode == .quickActions ? .idle : .quickActions
        // 開いた間は Esc で閉じられるよう、Dock がキー入力を受ける（閉じたら元のアプリへ返す）。
        if mode == .quickActions { WindowCoordinator.shared.focusDockForQuickActions() }
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
    func beginConversation(geminiSettings: GeminiLiveSettings? = nil) {
        guard !DesktopConnectionBootstrap.isInvalid else {
            GenieLog.write("conversation", "not started: desktop connection invalid")
            answer = DesktopConnectionBootstrap.issueMessage; mode = .answer(answer); return
        }
        guard GenieStateStore.shared.state.confirmation == nil, !conversation.isActive else {
            GenieLog.write("conversation", "not started: \(conversation.isActive ? "already active" : "a confirmation is open")")
            return
        }
        guard Permissions.microphone == .granted else {
            PermissionGuideCoordinator.shared.explain(.microphone) { [weak self] in self?.beginConversation(geminiSettings: geminiSettings) }
            return
        }
        if Permissions.speechRecognition == .notDetermined { Permissions.requestSpeechRecognition { _ in } }
        GenieSpeechOutput.shared.stop()
        // 本人が Gemini Live を有効にし、キーと月の上限を置いていればそれを使う。欠けていれば既存の経路。
        // 上限に達していたら始めない（**既存の経路へも黙って切り替えない**。何が起きたかを言う）。
        let gemini = geminiSettings ?? GeminiLiveSettings.shared
        let provider: ConversationProvider
        // キーの確認が終わっていなければ、終わるのを待ってから始める（「もう一度」と言わせない）。
        if gemini.enabled, gemini.checkingKey {
            Task { [weak self] in
                await gemini.refreshKeyPresence()
                guard !gemini.checkingKey else { return }
                self?.beginConversation(geminiSettings: geminiSettings)
            }
            return
        }
        // クレジット切れ・利用枠の上限の後は、しばらく標準の会話で話す。
        if gemini.usableForConversation() {
            let check = gemini.budget.canStart(at: Date())
            guard check.ok, let key = gemini.apiKey() else {
                answer = check.reason ?? gemini.keyAccessIssue ?? "Gemini Live のキーを読めませんでした。"
                mode = .answer(answer)
                return
            }
            provider = GeminiLiveProvider(
                apiKey: key, settings: gemini,
                delegate: { [weak self] request in await self?.delegateFromConversation(request) ?? "not_accepted" },
                onLost: { [weak self] reason in
                    guard let self else { return }
                    GenieLog.write("conversation", "Gemini Live lost: \(GenieLog.clip(reason, 120))")
                    if GeminiLive.isBillingUnavailable(reason) {
                        // 支払いで切れた。止めずに、標準の会話に切り替えて続ける。
                        gemini.pauseForBilling()
                        self.endConversation(.providerLost)
                        self.startConversation(using: self.pipelineProvider)
                        // 声で言うとマイクが拾うので、聞いている面の文字で知らせる（最初の言葉で置き換わる）。
                        if self.conversation.isActive { self.mode = .listening(partial: Facts.conversationSwitchedFromGemini) }
                        return
                    }
                    self.answer = reason
                    self.endConversation(.providerLost)
                    self.mode = .answer(reason)
                })
        } else {
            provider = pipelineProvider
            if gemini.enabled {
                let why = !gemini.hasKey ? "no key" : gemini.keyAccessIssue != nil ? "key unreadable (Keychain)"
                    : gemini.billingPaused() ? "paused after a billing failure" : "unknown"
                GenieLog.write("conversation", "Gemini Live not used: \(why)")
            }
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
        WakeWordListener.shared.suspend()
        closeMicrophone()
        conversationProvider = provider
        isListeningMuted = false
        observeSleep()
        GenieLog.write("conversation", "start: \(provider is GeminiLiveProvider ? "Gemini Live" : "standard")")
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
    func endConversation(_ reason: ConversationLoop.EndReason = .user, caller: String? = nil, file: String = #fileID, line: Int = #line) {
        let caller = caller ?? "\(file):\(line)"
        if conversation.isActive { GenieLog.write("conversation", "end requested: \(reason.rawValue) by \(caller)") }
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
                inputLevels = []
                listeningAwaitingAudio = true
                // 答えのカードは残したまま次を聞く（読み上げを聞き逃しても見返せる）。話し始めたら聞く面へ。
                let showingAnswer: Bool = switch mode { case .answer, .card: true; default: false }
                if GenieStateStore.shared.state.confirmation == nil, !showingAnswer { mode = .listening(partial: "") }
                // 消音中は開かない（面は「消音中」なのにマイクが開き、Gemini では声が送られていた）。
                // 消音を解いた時に `toggleListeningMute` が開く。
                if isListeningMuted { break }
                if !openConversationMicrophone(generation: g) { run(conversation.end(.microphoneLost)) }
            case .closeMicrophone:
                conversationProvider.closeInput()
                inputLevel = 0
                inputLevels = []
            case .send(let text):
                GenieLog.write("conversation", "heard: \(GenieLog.clip(text))")
                conversationProvider.send(text) { [weak self] reply in
                    guard let self else { return }
                    self.run(self.conversation.reply(reply))
                }
            case .speak(let text, let g):
                GenieLog.write("conversation", "speak: \(GenieLog.clip(text, 80))")
                conversationProvider.speak(text) { [weak self] in
                    guard let self else { return }
                    self.run(self.conversation.speechFinished(generation: g))
                }
            case .stopSpeaking:
                conversationProvider.stopSpeaking()
            case .warnEnding:
                conversationEnding = true
            case .readyCue:
                // 聞き始めた合図（その場で合成する短い音。通信しない）。
                GenieEarcon.play(.start)
            case .ended(let reason):
                GenieLog.write("conversation", "ended: \(reason.rawValue)")
                conversationProvider.endSession()
                GenieEarcon.play(.end)
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
            GenieLog.write("conversation", "not sent (held: \(heldUtterance == text)) \(GenieLog.clip(answer, 80))")
            deliverConversationReply(heldUtterance == text ? .held : .failed("申し訳ありません。ご依頼を送れませんでした。" + answer))
        }
    }

    private func deliverConversationReply(_ reply: ConversationLoop.Reply) {
        guard let deliver = pendingConversationReply else { return }
        pendingConversationReply = nil
        deliver(reply)
    }

    /// 近くの店を探して地図のカードを出す。会話へは件数だけを返す（店名・住所・位置は Gemini に返さない）。
    /// 探せないとき（キー・上限・位置の許可が無い）は、できないことと次の一手を回答面に出す。
    private func showNearby(_ intent: NearbyPlaceIntent) {
        latestRequestID = nil; answer = ""
        requestInFlight = true
        mode = .thinking
        Task { @MainActor [weak self] in
            let result = await NearbyPlaces.search(intent)
            guard let self else { return }
            self.requestInFlight = false
            let conversationListening = self.conversation.isActive && self.conversation.phase != .waiting
            let reply: TaskReply
            switch result {
            case .success(let card):
                self.answer = card.text
                reply = TaskReply(text: card.conversationText, phase: .complete, card: .places(card))
                if !conversationListening, !self.isListeningSurface {
                    self.mode = card.hasContent ? .card(.places(card)) : .answer(card.text)
                }
            case .failure(let failure):
                self.answer = failure.message
                reply = TaskReply(text: failure.message, phase: .needsInput)
                if !conversationListening, !self.isListeningSurface { self.mode = .answer(failure.message) }
            }
            self.conversationReply(reply)
        }
    }

    /// `ask` の結果を会話へ返す（会話中で、答えを待っているときだけ）。
    private func conversationReply(_ reply: TaskReply?, draft: Bool = false, failed: String? = nil) {
        guard conversation.isActive, conversation.phase == .waiting else {
            if reply != nil || failed != nil { GenieLog.write("conversation", "reply arrived after the conversation moved on") }
            return
        }
        if let failed { GenieLog.write("conversation", "reply failed: \(GenieLog.clip(failed, 80))"); deliverConversationReply(.failed(failed)); return }
        guard let reply else { return }
        GenieLog.write("conversation", "reply \(reply.phase): \(GenieLog.clip(reply.text, 80))")
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
            // 整える（言い淀みだけを消す。言葉は変えない）。消したときだけ、数秒「元の文に戻す」を出す。
            let cleaned = DictationCleanup.clean(text)
            if Dictation.insert(cleaned, excludingOwnProcess: true, appPID: dictationTargetPID) {
                answer = ""
                if cleaned != text {
                    let notice = DictatedText(inserted: cleaned, original: text, appPID: dictationTargetPID)
                    mode = .dictated(notice)
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 5_000_000_000)
                        guard let self, case .dictated(let shown) = self.mode, shown.id == notice.id else { return }
                        self.mode = .idle
                    }
                } else {
                    mode = .idle
                }
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

    /// Nearby places keep their existing offline entry path.
    static func homeIntentNeedsGateway(_ text: String, visualContext: [VisualContextArtifact]?) -> Bool {
        guard visualContext?.isEmpty != false else { return true }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return NearbyPlaceIntent.detect(text) == nil
    }

    /// 声/テキストの依頼を Agent に投げる。listening→thinking→answer→idle と状態を進める。
    @discardableResult
    func ask(_ text: String, newConversation: Bool = false, visualContext: [VisualContextArtifact]? = nil) -> Bool {
        guard !DesktopConnectionBootstrap.isInvalid else {
            answer = DesktopConnectionBootstrap.issueMessage; mode = .idle; return false
        }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        // 前の依頼に答えている途中。**黙って捨てない**（以前は false を返すだけで、Dock は
        // マイクの閉じた Listening のまま残り、話した内容が消えていた）。預かって、考え中の面へ戻す。
        guard !requestInFlight else {
            hold(text)
            return false
        }
        GenieSpeechOutput.shared.stop()
        // 「近くのスタバ」: 端末で現在地と Google マップを引き、地図つきのカードにする（gateway・モデルは通さない）。
        if visualContext?.isEmpty != false,
           let nearby = NearbyPlaceIntent.detect(text) {
            showNearby(nearby)
            return true
        }
        guard let base = apiBase, let token = apiToken else {
            answer = MainData.shared.connectionIssue?.message
                ?? "接続を確認してください。入力した内容は残しています。"
            GenieLog.write("request", "no connection: \(MainData.shared.connectionIssue?.diagnosticCode ?? "not configured")")
            // 会話中は面を待機に戻さない（戻すと会話が「置き換え」で終わり、理由も言えなかった。実機 2026-10-04）。
            // 理由は会話の返事として声で言い、次を聞く。
            if !conversation.isActive { mode = .idle }
            return false
        }
        // 「あと、テストも追加して」: 直前の仕事がまだ動いていれば、新しい依頼ではなくその仕事への追加指示。
        if visualContext == nil, let target = followUpTarget(for: text) {
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
        requestRecord.turnRequestID = receiptID
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
                let outcome = try GenieCoreBridge.sendRecoverableTurn(base, accessToken: token, conversationId: conv,
                    requestId: receiptID, text: text, attachments: attachments, replyCandidatesJson: replyCandidates)
                let taskContext = outcome.taskId.isEmpty ? nil
                    : (try? GenieCoreBridge.taskGet(base, accessToken: token, taskId: outcome.taskId)).flatMap(TaskOutcomeContext.decode)
                await MainActor.run {
                    self?.updateRequest(task.id) {
                        $0.backendTaskID = outcome.taskId; $0.backendTaskKind = taskContext?.kind; $0.phase = .working
                    }
                    // backend に仕事ができた。Dock の一覧の 1 行になる（止めるは backend の取り消し）。
                    if !outcome.taskId.isEmpty {
                        self?.trackOnDock(task.id, title: task.title, backendTaskId: outcome.taskId,
                                          base: base, token: token, taskKind: taskContext?.kind)
                    }
                }
                // 承認待ちで止まったら、この依頼をいま出した本人に確認カードで聞く。
                // 押されたカードの承認だけを中継する。「やめる」なら REJECTED で、実行しない。
                // 答えが無い（時間切れ・カードが見えない）なら何も送らず、承認を待ったまま残す。
                let followed = try Self.follow(outcome, base: base, token: token, waitMs: 12_000)
                let first = try await Self.settleApprovals(followed,
                    taskId: outcome.taskId, base: base, token: token, waitMs: 12_000,
                    onPending: { self?.recordApprovalWait(task.id) })
                let reply = first.reply
                // 受け付けられなかった（仕事ができず、答えも無く、知らせだけが返った）。
                let rejected = outcome.taskId.isEmpty && outcome.answer.isEmpty && !outcome.needsClarification
                let draft: ReplyFlow.Draft? = await MainActor.run {
                    self?.applyReply(reply, to: task.id)
                    self?.answer = reply.text
                    // 短い確定回答や聞き返しは、その場で確認できるよう Dock に残す。
                    // 作業中・待機中は従来どおり静かな入口へ戻し、Work で追える状態にする。
                    // 会話が次のターンを聞いている間は、聞いている面を消さない（Gemini に頼んだ仕事の答えが後から来る）。
                    let conversationListening = (self?.conversation.isActive ?? false) && self?.conversation.phase != .waiting
                    // 音声入力で聞いている間も面を差し替えない（差し替えるとマイクを閉じ、話している途中が消える）。
                    // 答えは `answer` と Work に残る。
                    let inConversation = self?.conversation.isActive == true
                    if reply.settled {
                        // すぐ答えが出た依頼は、答えの面で見せる（一覧の行にはしない）。
                        self?.dropFromDock(task.id)
                    } else if !rejected {
                        // 受け付けた（仕事ができて動いている）ときだけ「かしこまりました」。
                        GenieStateStore.shared.showAck(DockAck(id: task.id, title: task.title))
                        if first.leftPending { self?.dockEvent(task.id, .awaitingApproval) }
                        else if !followed.pendingApprovals.isEmpty { self?.dockEvent(task.id, .step(Facts.taskWorking)) }
                    }
                    if !conversationListening, self?.isListeningSurface != true {
                        let hasText = !reply.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        if rejected, !inConversation, hasText {
                            // 受け付けたようには見せない。同じ面で理由と「閉じる」（会話では声で理由を言う）。
                            self?.mode = .idle
                            GenieStateStore.shared.showAck(DockAck(id: task.id, title: task.title, rejected: reply.text))
                        } else if reply.settled && hasText {
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
                    // 終わるまで追う（2 分ずつ、合計 30 分まで）。Dock の行を止めたら追うのもやめる。
                    var later = reply
                    var waited: UInt64 = 0
                    while !later.settled, waited < 1_800_000 {
                        let stillShown = await MainActor.run { GenieStateStore.shared.state.board.task(task.id)?.isActive ?? false }
                        guard stillShown else { break }
                        later = try await Self.settleApprovals(
                            Self.follow(outcome, base: base, token: token, waitMs: 120_000),
                            taskId: outcome.taskId, base: base, token: token, waitMs: 120_000,
                            onPending: { self?.recordApprovalWait(task.id) }).reply
                        waited += 120_000
                    }
                    let laterDraft: ReplyFlow.Draft? = await MainActor.run {
                        self?.applyReply(later, to: task.id)
                        guard later.settled else {
                            // 30 分で追うのをやめる。終わったとは言わない（状況は Work で確かめられる）。
                            self?.dropFromDock(task.id)
                            return nil
                        }
                        // 後から届いた結果は Work に残る。例外のカード（天気・ニュース…）は、これがいちばん新しい依頼で、
                        // 会話が次のターンを聞いていないときだけ出す（聞いている面・新しい答えを上書きしない）。
                        // それ以外は Dock の結果（何ができたかと、開く・コピー）になる。
                        if let card = later.card, card.hasContent {
                            self?.dropFromDock(task.id)
                            if let self, self.latestRequestID == task.id, !self.conversation.isActive, !self.isListeningSurface {
                                self.answer = later.text
                                self.mode = .card(card)
                            }
                        } else {
                            self?.finishOnDock(task.id, reply: later, title: task.title)
                            if let self, self.latestRequestID == task.id { self.answer = later.text }
                        }
                        VisualContextStore.shared.markRecent(attached)
                        guard !outcome.replyJson.isEmpty else { return nil }
                        return ReplyFlow.draft(replyJson: outcome.replyJson, body: later.text)
                    }
                    if let laterDraft { await ReplyFlow.shared.present(laterDraft) }
                }
                await MainActor.run { _ = self?.followingRequests.remove(task.id) }
            } catch {
                GenieLog.write("request", "failed to reach the service: \(GenieLog.clip(String(describing: error), 160))")
                await MainActor.run {
                    self?.updateRequest(task.id) {
                        if !$0.canReuse { return }
                        $0.phase = .unknown
                        if $0.backendTaskKind?.hasPrefix("transaction.") == true {
                            $0.transactionResultUnknown = true
                            $0.message = TaskOutcomeContext.transactionUnknown
                            return
                        }
                        $0.message = $0.backendTaskID.isEmpty
                            ? ($0.canRefresh ? "受付を確認できませんでした。「状況を確認」で照会できます。依頼は再送しません。" : "受付を確認できませんでした。二重実行を防ぐため、自動では再送しません。")
                            : "通信が切れました。状況を確認すると、同じ仕事の続きが読み込まれます。"
                    }
                    // 解くのは、この依頼がまだ「いまの依頼」のときだけ。受付の後に後追いで失敗しても、
                    // その間に始まった新しい依頼の送信中を解かない（二重送信を防げなくなる）。
                    // 行は外す（仕事が失敗したとは言えない。状況は Work で確かめられる）。
                    self?.dropFromDock(task.id)
                    if let self, self.latestRequestID == task.id {
                        self.answer = "接続を確認してください。依頼と現在の状況は Work に保存されています。"
                        if !self.conversation.isActive, !self.isListeningSurface { self.mode = .idle }
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
                let context = ["FAILED", "CANCELLED"].contains(done.status) ? try reader.outcomeContext() : nil
                let reply = try taskReply(status: done.status, artifactID: done.resultArtifactId, context: context) {
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
                                            waitMs: UInt64,
                                            onPending: (@MainActor () -> Void)? = nil) async throws -> TaskFollowUp {
        let outcome = TurnOutcome(needsClarification: false, answer: "", taskId: taskId, notice: "", replyJson: "")
        return try await settleApprovals(first, waitMs: waitMs, onPending: onPending,
            prepareCard: { card, approval in
                await TransactionAuthorizationState.shared.prepare(card, approval: approval,
                    api: TransactionAuthorizationAPI(base: base, token: token))
            },
            approve: { id, proof in try GenieCoreBridge.taskApprove(base, accessToken: token, taskId: taskId, approvalId: id, approval: proof) },
            reject: { id in try GenieCoreBridge.taskReject(base, accessToken: token, taskId: taskId, approvalId: id) },
            follow: { ms in try follow(outcome, base: base, token: token, waitMs: ms) })
    }

    /// 上の本体。送る先・聞く面を差し替えられる（検査用。証拠は `Confirm` でしか作れないので、
    /// 差し替えても「押されていないのに APPROVED」は作れない）。
    nonisolated static func settleApprovals(
        _ first: TaskFollowUp, waitMs: UInt64,
        onPending: (@MainActor () -> Void)? = nil,
        prepareCard: (@MainActor (ActionConfirmation, BackendApproval) async -> ActionConfirmation)? = nil,
        ask: @escaping @MainActor (ActionConfirmation) async -> ApprovalAnswer = { await Confirm.approve($0) },
        approve: (String, consuming UserApproval) throws -> Void,
        reject: (String) throws -> Void,
        follow: (UInt64) throws -> TaskFollowUp
    ) async throws -> TaskFollowUp {
        var current = first
        var shown: Set<String> = []
        while let approval = current.pendingApprovals.first(where: { !shown.contains($0.id) }) {
            shown.insert(approval.id)
            var card = ActionConfirmation(backendApproval: approval)
            if let prepareCard { card = await prepareCard(card, approval) }
            // カードへの返答を待つ間も、Main の記録を「作成中」に残さない。
            await onPending?()
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
            case .delegated:
                // The create endpoint already reserved quota, approved this ID and resumed the task.
                // Sending the ordinary approve endpoint again would create a second approval path.
                break
            case .authorizationUnknown:
                return TaskFollowUp(reply: TaskReply(text: "許可と今回の注文の結果は未確認です。「状況を確認」と設定の「任せている注文」で確認してください。注文は再送しません。", phase: .unknown), leftPending: true)
            }
            current = try follow(waitMs)
        }
        return current
    }

    /// 答えの見せ方。例外のカードに描くものがあればカード、無ければ文。
    nonisolated static func presentation(for reply: TaskReply) -> DockPresentation {
        if let card = reply.card, card.hasContent { return .card(card) }
        return .answer(reply.text)
    }

    nonisolated static func taskReply(status: String, artifactID: String, context: TaskOutcomeContext? = nil,
                                    content: () throws -> String) rethrows -> TaskReply {
        // A workflow terminal state alone cannot establish an external order's outcome.
        // This also covers older servers and lost host responses without structured details.
        if ["FAILED", "CANCELLED"].contains(status), context?.isTransaction == true {
            return TaskReply(text: status == "CANCELLED" ? TaskOutcomeContext.stoppedTransactionUnknown : TaskOutcomeContext.transactionUnknown,
                             phase: .unknown, taskKind: context?.kind, transactionResultUnknown: true)
        }
        switch status {
        case "COMPLETED":
            guard !artifactID.isEmpty else { return TaskReply(text: "処理は終了しましたが、成果物は返されませんでした。", phase: .needsInput) }
            let body = try content()
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return TaskReply(text: "成果物の内容が空でした。状況を確認してください。", phase: .needsInput, artifactID: artifactID)
            }
            // 例外のカード（天気・ニュース…）は JSON の成果物。カードと、そのまま読める文に分ける。
            if let card = DockCard.decode(body) {
                return TaskReply(text: card.text, phase: .complete, artifactID: artifactID, card: card)
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

    func applyReply(_ reply: TaskReply, to id: UUID, store: LocalStore = .shared) {
        updateRequest(id, store: store) {
            // Missing context, an empty artifact, or a generic terminal status cannot
            // resolve an existing uncertain order. Only verified content clears it.
            let confirmed = reply.phase == .complete && !reply.artifactID.isEmpty
                && !reply.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if !$0.canReuse && !confirmed && !reply.transactionResultUnknown { return }
            if $0.stopRequested == true, [.working, .submitting, .waiting].contains(reply.phase) { return }
            if $0.backendTaskKind?.hasPrefix("transaction.") == true,
               [.failed, .cancelled].contains(reply.phase) {
                $0.phase = .unknown
                $0.transactionResultUnknown = true
                $0.message = reply.phase == .cancelled ? TaskOutcomeContext.stoppedTransactionUnknown
                    : TaskOutcomeContext.transactionUnknown
                return
            }
            if let kind = reply.taskKind { $0.backendTaskKind = kind }
            $0.transactionResultUnknown = reply.transactionResultUnknown
            $0.phase = reply.phase; $0.artifactID = reply.artifactID
            if reply.phase == .complete { $0.result = reply.text; $0.message = "" }
            else { $0.message = reply.text }
        }
    }

    private func recordApprovalWait(_ id: UUID) {
        applyReply(TaskReply(text: "承認待ちです。確認カードで内容を確認してください。この操作はまだ実行していません。", phase: .waiting), to: id)
        dockEvent(id, .awaitingApproval)
    }

    func recordReadFailure(_ id: UUID, message: String, store: LocalStore = .shared) {
        updateRequest(id, store: store) {
            guard $0.canReuse else { return }
            if $0.backendTaskKind?.hasPrefix("transaction.") == true {
                $0.phase = .unknown
                $0.transactionResultUnknown = true
                $0.message = TaskOutcomeContext.transactionUnknown
            } else { $0.message = message }
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
            recordReadFailure(id, message: "この仕事を依頼した接続が見つかりません。接続を確認してください。")
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
                    ? try await Self.settleApprovals(first, taskId: outcome.taskId, base: base, token: token, waitMs: 12_000,
                        onPending: { self?.recordApprovalWait(id) }).reply
                    : first.reply
                await MainActor.run { self?.applyReply(reply, to: id); self?.refreshingRequests.remove(id) }
            } catch {
                await MainActor.run {
                    self?.recordReadFailure(id, message: "状況を取得できませんでした。接続を確認してから、もう一度状況を確認できます。")
                    self?.refreshingRequests.remove(id)
                }
            }
        }
    }
}
