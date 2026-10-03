import SwiftUI
import AppKit
import ImageIO
import UniformTypeIdentifiers
import GenieCore

enum RecordingTool: String, CaseIterable, Identifiable {
    case transcript, translation
    var id: String { rawValue }
    var title: String {
        switch self {
        // controller のタブが「字幕」（機能）。パネル内はその**表示モード**なので、字幕を繰り返さない。
        case .transcript: return "原文"
        case .translation: return "翻訳"
        }
    }
    /// ⌘1 / ⌘2 で切り替える（マウス無しでも右列を操作できるように）。
    var shortcut: KeyEquivalent {
        switch self {
        case .transcript: return "1"
        case .translation: return "2"
        }
    }
    var icon: String {
        switch self {
        case .transcript: return "text.alignleft"
        case .translation: return "character.bubble"
        }
    }
}

struct TranscriptSegment: Identifiable {
    let id = UUID()
    let speaker: String
    let text: String
    let interim: Bool
    /// 会議の開始からの秒数。どこで言われたかが分からないと、後から音に戻れない。
    var at: TimeInterval = 0

    /// 「04:21」。
    var timeLabel: String {
        let t = Int(max(0, at))
        return String(format: "%02d:%02d", t / 60, t % 60)
    }
}

/// RAG ドロワーの 1 行。並べ替え（score/reason）は core が決める。
struct RankedContext: Identifiable {
    let id: String
    let title: String
    let source: ContextSource
    let score: Double
    let reason: String
}

/// 録音 UI の状態を一か所に。UI から STT/Core を直接呼ばない（後段で bridge 経由にする）。
@MainActor
final class RecordingWorkspaceState: ObservableObject {
    static let shared = RecordingWorkspaceState()

    @Published var isRecording = false
    /// 録音を成り立たなくしている許可。無ければ nil。バナーで出す。
    @Published var permissionIssue: PermissionIssue?
    private var tickTimer: Timer?
    private var microphoneRequest: UUID?
    @Published var isPaused = false
    @Published var elapsedSeconds = 0
    /// 検査用: 撮影の間だけ経過時計を止める。**本番では false。** light と dark を別プロセスで撮るので、
    /// 動いたままだと同じ面が 05:21 / 05:23 とずれ、fixed（light == dark）の gate が運で通ったり落ちたりした（実測）。
    var freezeClockForShot = false
    @Published var selectedTool: RecordingTool = .transcript
    @Published var ragOpen = false
    @Published var transcript: [TranscriptSegment] = [] {
        didSet { translation.update(transcript) }
    }
    /// RAG コンテキストの並べ替え結果（core の rank_context 由来）。
    @Published var ragResults: [RankedContext] = []
    /// いまの会議 id（スクリーンショット等の保存先に使う）。
    var currentMeetingId = "adhoc"
    /// AI 操作（要約/質問/決定事項/アクション）の結果。
    @Published var aiResult = ""
    @Published var aiRunning = false
    /// 動いている AI 操作（止めるときに待ちを取り消す）と、その backend の仕事の id。
    private var aiTask: Task<Void, Never>?
    private var aiJobId: String?
    /// 検査用（`--selftest aistop`）。いま動いている AI 操作の backend の仕事。
    var aiJobIdForTest: String? { aiJobId }
    @Published private(set) var aiActionSucceeded = false
    let translation = MeetingTranslation()
    var translatedText: String { translation.text }
    var translating: Bool { translation.isTranslating }
    /// 実バックエンド（サインイン済みのときだけ AI 操作が動く）。
    private var apiBase: String?
    private var apiToken: String?
    private let aiRequests = MeetingAIRequests()
    /// ユーザーが選んだローカルファイル由来の候補（Finder access）。transcript と混ぜて並べ替える。
    var fileCandidates: [ContextCandidate] = []
    /// まだ一度も実マイクの値が来ていない。「静か」と「聞けていない」を描き分けるため。
    @Published private(set) var awaitingAudio = true
    @Published var audioLevels: [CGFloat] =
        [0.3, 0.5, 0.8, 0.4, 0.9, 0.6, 0.35, 0.7, 0.5, 0.85, 0.45, 0.6]

    /// 経過・状態の表示は genie-core（Rust）に一本化する（Swift 側で書き直さない）。
    var snapshot: RecordingSnapshot {
        GenieCoreBridge.snapshot(
            elapsedMs: UInt64(elapsedSeconds) * 1000,
            isPaused: isPaused,
            link: .online,
            pendingMs: 0)
    }
    var elapsedText: String { snapshot.elapsedLabel }
    var heroText: String { snapshot.heroText }

    /// **実際に届いている経路**から、許可が無い経路を引いたもの。
    /// hero の「（音声なし）」、見出しの「〜を聞いています」、本文の「聞いています…」は
    /// 全部これから組む。以前は hero が `permissionIssue` を、見出しと本文が `listening` を見ていて、
    /// マイク拒否のとき同じ面で「音声なし」と「聞いています」が並んだ（Atlas F2）。
    /// マイクが拒否でも画面の音が届いていれば、それは言う（隠さない）。
    var liveChannels: Set<SpeakerChannel> {
        var ch = RecordingRuntime.shared.listening
        if let denied = permissionIssue?.channel { ch.remove(denied) }
        return ch
    }
    /// 許可が無くて**何も届いていない**。主役が元気に動くと画面が嘘をつく。
    var silent: Bool { permissionIssue != nil && liveChannels.isEmpty }

    /// 音声認識の許可が無ければそう言う（マイクの問題が無いときだけ。マイク拒否のほうが先）。
    /// 許可の答えが遅れて来たときにも呼ぶ（JIT のダイアログのあと）。
    func refreshSpeechPermission() {
        guard isRecording else { return }
        if RecordingRuntime.cloudTranscriptionAllowed {
            if permissionIssue != nil, permissionIssue?.channel == nil { permissionIssue = nil }
            return
        }
        let denied = Permissions.speechRecognition == .denied || Permissions.speechRecognition == .restricted
        if permissionIssue?.channel == .localUser { return }          // マイク拒否が出ている
        if denied { permissionIssue = .speechDenied }
        else if permissionIssue != nil, permissionIssue?.channel == nil { permissionIssue = nil }
    }

    /// §17: 決定的な固定画面。
    /// 検査・golden・geometry 用。実マイクを開けない撮影で「音が届いている姿」を作る
    /// （`RecordingRuntime.markListening` / `VoiceHUDState.markVoiceCaptureLive` と同じ役割）。
    /// これを呼ばないと Dock は正しく「準備中…」になり、基準（録音中の姿）と一致しない。
    func markAudioLiveForShot() { holdPreparingForShot = false; awaitingAudio = false }
    /// 同じく固定画面用: 「準備中…」（音がまだ届いていない）の姿を作る。
    /// `VoiceHUDState.beginPreparingForShot` の録音側。Atlas の meeting.preparing はこれで撮る。
    /// 実マイクが動いている撮影では level が届くたびに「準備中…」が消えるので、撮り終わるまで止める。
    func beginPreparingForShot() { holdPreparingForShot = true; awaitingAudio = true; elapsedSeconds = 0 }
    private var holdPreparingForShot = false

    func loadDemo(ragOpen: Bool) {
        translation.reset()
        isRecording = true
        // §17 の固定画面は「録音中で音が届いている」姿。準備中の姿は 02b で別に固定する。
        awaitingAudio = false
        isPaused = false
        elapsedSeconds = 4 * 60 + 21
        selectedTool = .transcript
        self.ragOpen = ragOpen
        transcript = [
            TranscriptSegment(speaker: "田中", text: "それでは 9 月 12 日に出しましょう。", interim: false, at: 233),
            TranscriptSegment(speaker: "あなた", text: "了解しました。", interim: false, at: 245),
            TranscriptSegment(speaker: "鈴木", text: "OAuth だけ確認お願いします。", interim: true, at: 258),
        ]
        refreshRag()
    }

    /// いま話していることに近い文脈を、この会議の中身から core で並べ替える。
    /// 候補は transcript から作る実データ。ランキングは core（Swift 側で書き直さない）。
    /// 外部コネクタ（Gmail/Drive 等）の候補は接続後にここへ足す。
    func refreshRag() {
        let segments = transcript
        guard !segments.isEmpty else { ragResults = []; return }
        // 直近の発話から検索語を作る（小文字化・記号除去）。
        let latest = segments.last?.text ?? ""
        let terms = latest.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count >= 2 }
        var candidates: [ContextCandidate] = segments.enumerated().map { i, seg in
            ContextCandidate(
                id: seg.id.uuidString,
                text: seg.text,
                source: .meeting,
                ageSeconds: UInt64((segments.count - i) * 30),
                projectMatch: true)
        }
        // ローカルファイル（Finder access）由来の候補も同じ土俵で並べ替える。
        candidates.append(contentsOf: fileCandidates)
        // 前面アプリで選択中のテキスト（AX）があれば、外から来た文脈として足す。
        for lite in AccessibilityContext.candidate() {
            candidates.append(ContextCandidate(
                id: lite.id, text: lite.text, source: .message, ageSeconds: 0, projectMatch: true))
        }
        let byId = Dictionary(uniqueKeysWithValues: candidates.map { ($0.id, $0) })
        let ranked = GenieCoreBridge.rankContext(terms: terms, limit: 5, candidates: candidates)
        ragResults = ranked.compactMap { r in
            guard let c = byId[r.id] else { return nil }
            return RankedContext(id: r.id, title: c.text, source: c.source, score: r.score, reason: r.reason)
        }
    }

    /// フォルダを選んで RAG のローカルファイル候補にする（Finder access）。
    func addFileContext(directory: URL) {
        fileCandidates = FileContext.candidates(inDirectory: directory)
        refreshRag()
    }

    /// ユーザーにフォルダを選ばせて RAG のローカルファイル候補にする（Finder access）。
    /// **選んだフォルダだけを読む**（全ディスクを漁らない）。
    func pickFileContext() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "このフォルダを文脈に使う"
        if panel.runModal() == .OK, let dir = panel.url {
            addFileContext(directory: dir)
        }
    }

    private var finishingRecording = false
    private var startAfterFinishing: (() -> Void)?

    /// Start a recording. The optional switches are used only by the headless
    /// crash-recovery self-test, which must exercise the disk/session path
    /// without asking macOS TCC for microphone or speech access.
    func start(captureMic: Bool = true, transcribe: Bool = true, requestPermissions: Bool = true,
               captureSystemAudio: Bool? = nil) {
        if finishingRecording {
            startAfterFinishing = { [weak self] in
                self?.start(captureMic: captureMic, transcribe: transcribe,
                            requestPermissions: requestPermissions, captureSystemAudio: captureSystemAudio)
            }
            return
        }
        guard microphoneRequest == nil else { return }
        // A permission prompt is not a recording. Do not clear the previous
        // transcript, start the clock, or create a session before access exists.
        if captureMic && Permissions.microphone != .granted {
            permissionIssue = .microphoneDenied
            if !requestPermissions {
                GenieStateStore.shared.setDock(.result(AgentResult(
                    title: Facts.recordingCannotStart,
                    actions: [.openSettings],
                    detail: "マイクが許可されていません。設定で Genie に許可すると始められます。",
                    failed: true)))
            }
            if requestPermissions {
                let request = UUID()
                microphoneRequest = request
                PermissionGuideCoordinator.shared.explain(.microphone, purpose: .recording, onCancel: { [weak self] in
                    guard let self, self.microphoneRequest == request else { return }
                    self.microphoneRequest = nil
                    self.pendingCalendarLink = nil
                }) { [weak self] in
                    guard let self, self.microphoneRequest == request else { return }
                    self.microphoneRequest = nil
                    self.start(captureMic: captureMic, transcribe: transcribe,
                               requestPermissions: requestPermissions, captureSystemAudio: captureSystemAudio)
                }
            } else {
                pendingCalendarLink = nil
            }
            return
        }
        // 会話・音声入力と録音は同じマイクを使う。声の側を先に閉じる（重ねると、会話を終えたときに
        // 録音のマイクまで止まっていた）。
        let voice = VoiceHUDState.shared
        if voice.conversation.isActive || RecordingRuntime.shared.voiceListening { voice.cancelListening() }
        isRecording = true
        // 前の会議を消す。消さないと 2 本目の録音に 1 本目の行が混ざる（`at` も衝突する）。
        // 前の会議は確定のたびに保存してあるので、ここで失うものは無い。
        translation.reset()
        selectedTool = .transcript
        transcript = []
        GenieStateStore.shared.updateCanvas(MeetingCanvas())
        // 経過時間を実際に進める（一時停止中は止める）。以前は 0 のままだった。
        elapsedSeconds = 0
        tickTimer?.invalidate()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, self.isRecording, !self.isPaused, !self.freezeClockForShot else { return }
            self.elapsedSeconds += 1
        }
        // オンデバイス STT の途中経過/確定を transcript に反映する。
        RecordingRuntime.shared.onTranscript = { [weak self] text, isFinal in
            guard let self else { return }
            if !text.isEmpty, !self.holdPreparingForShot { self.awaitingAudio = false }
            // 直近の interim を置き換え、確定したら確定行にする（重なりは core の merge に委ねる設計）。
            // §19 誰の声かを channel から取る（混合波からは分からない）。
            let speaker = RecordingRuntime.shared.lastTranscriptChannel.label
            let row: Int
            if let index = self.transcript.lastIndex(where: { $0.interim && $0.speaker == speaker }) {
                // 言い始めた時刻を保つ（確定するたびに時刻が動くと読みづらい）。
                self.transcript[index] =
                    TranscriptSegment(speaker: speaker, text: text, interim: !isFinal, at: self.transcript[index].at)
                row = index
            } else {
                self.transcript.append(TranscriptSegment(
                    speaker: speaker, text: text, interim: !isFinal,
                    at: Double(self.elapsedSeconds)))
                row = self.transcript.count - 1
            }
            if isFinal { self.didFinalizeLastRow(index: row) } else { self.refreshRag() }
        }
        // 波形を実マイクレベルで更新する（デモの固定値をやめてフラットから始める）。
        audioLevels = Array(repeating: 0.0, count: 12)
        awaitingAudio = true
        RecordingRuntime.shared.onLevel = { [weak self] level in
            guard let self, !self.holdPreparingForShot else { return }
            self.awaitingAudio = false
            self.audioLevels.removeFirst()
            self.audioLevels.append(CGFloat(level))
        }
        // 実ランタイム: マイク → genie-core → ディスク断片（許可があればライブ取り込み + 手元 STT）
        MeetingIntelligence.shared.reset()
        // §26 会議に要るものだけを、始めるこの瞬間に要求する（起動時に一括で聞かない）。
        if requestPermissions && !RecordingRuntime.cloudTranscriptionAllowed {
            PermissionCenter.request(.meeting) {
                RecordingRuntime.shared.speechAuthorizationChanged()
                RecordingWorkspaceState.shared.refreshSpeechPermission()
            }
        }
        // マイクが**拒否**されているなら録音状態にしない。
        // 「録音中」と出しながら無音を録るのが一番高くつく壊れ方なので、始めない。
        if captureMic && (Permissions.microphone == .denied || Permissions.microphone == .restricted) {
            permissionIssue = .microphoneDenied
            isRecording = false
            tickTimer?.invalidate(); tickTimer = nil
            pendingCalendarLink = nil
            // 理由は Workspace のバナーだけに出ていた。Workspace は開いていないので、
            // Home / Dock / ⌥Space から始めた人には**何も起きない**ように見えた。
            // Dock の結果面に理由と、直しに行く道を出す。
            GenieStateStore.shared.setDock(.result(AgentResult(
                title: Facts.recordingCannotStart,
                actions: [.openSettings],
                detail: "マイクが許可されていません。設定で Genie に許可すると始められます。",
                failed: true)))
            return
        }
        // 未確認のまま進む場合（プロンプト待ち）は、録れていないことを画面に出す。
        permissionIssue = captureMic && Permissions.microphone != .granted ? .microphoneDenied : nil
        if requestPermissions { refreshSpeechPermission() }
        let localId = "meeting-\(UUID().uuidString.lowercased())"
        // 設定の既定値は NewRecordingSheet の「画面の音」と同じ。無人の保存検査では要求しない。
        let screenAudio = captureSystemAudio ?? (requestPermissions && captureMic &&
            (UserDefaults.standard.object(forKey: "astra.recording.systemAudio") as? Bool ?? true))
        if screenAudio && requestPermissions { PermissionCenter.request(.meetingAudio) }
        RecordingRuntime.shared.onSystemAudioFailure = { [weak self] in
            self?.permissionIssue = .systemAudioUnavailable
        }
        RecordingRuntime.shared.begin(meetingId: localId, captureMic: captureMic,
                                      captureSystemAudio: screenAudio, transcribe: transcribe)
        // スクショ等は実際に journal を作った id に合わせる（サインイン時は gateway id）。
        currentMeetingId = RecordingRuntime.shared.activeMeetingId
        // §1 録音を始めたこの瞬間に Session を作って保存する。
        // 止めたときに「保存しますか」とは聞かない。
        let link = pendingCalendarLink
        pendingCalendarLink = nil
        // 予定が無いときの題は**始めた時刻**にする。会議アプリ名を題にすると、
        // 題と出所が同じ文字になって「Google Meet / Google Meet」と 2 回出るうえ、
        // 後から一覧で見ても、同じ名前の行が並ぶだけで見分けが付かない。
        let detectedApp = GenieStateStore.shared.state.meeting.detectedApp
        let session = MeetingSessionStore.shared.begin(
            id: currentMeetingId,
            title: link?.title ?? Self.untitledMeetingName(),
            link: link,
            source: detectedApp)
        // 録音の UI は Store が決める。ここで直接 window を開かない
        // —— 以前ここが `enterRecordingMode()` を呼んでいたため、録音ボタンだけが
        // 大きな面を開き、Dock コントローラの経路を通っていなかった。
        GenieStateStore.shared.meetingStarted(id: session.id)
    }
    /// 確定行を 1 つ足す。STT からも検査からも**この 1 本**を通る
    /// （検査だけ `transcript` を直に書くと、保存と抽出を通らない姿を測ることになる）。
    func appendFinal(_ seg: TranscriptSegment) {
        transcript.append(TranscriptSegment(speaker: seg.speaker, text: seg.text, interim: false, at: seg.at))
        didFinalizeLastRow()
    }

    /// 末尾の行が確定した。保存 → 検索の索引 → 抽出。
    ///
    /// 保存は**確定のたび**。止めたときにまとめて書くと、落ちたら全部消える。
    private func didFinalizeLastRow(index: Int? = nil) {
        let index = index ?? transcript.count - 1
        if transcript.indices.contains(index), !transcript[index].interim {
            LocalStore.shared.saveTranscriptRow(meetingId: currentMeetingId,
                                                index: index, transcript[index])
        }
        refreshRag()
        // §20 確定行が溜まったら**新しい分だけ**抽出する（全文を毎回投げない）。
        // 話者と時刻を落とさずに渡す。落とすと Canvas から発言に戻れない。
        MeetingIntelligence.shared.ingest(
            transcript.filter { !$0.interim }
                .map { CanvasItem($0.text, at: $0.at, speaker: $0.speaker) })
    }

    func stop() {
        microphoneRequest = nil
        pendingCalendarLink = nil
        guard isRecording else {
            permissionIssue = nil
            return
        }
        isRecording = false
        permissionIssue = nil
        tickTimer?.invalidate(); tickTimer = nil
        finishingRecording = true
        let id = currentMeetingId
        // Show the stopped/processing state before waiting for the final utterance.
        // A new start requested during this flush is queued for the next run loop.
        MeetingSessionStore.shared.beginProcessing(id: id)
        GenieStateStore.shared.meetingEnded()
        RecordingRuntime.shared.end(cloudCompletion: { [weak self] finishedId, failure in
            if let failure {
                NSLog("cloud transcription failed: %@", failure)
                MeetingSessionStore.shared.markFailed(id: finishedId)
            } else { self?.finishProcessing(id: finishedId) }
        }) { [weak self] in
            guard let self else { return }
            MeetingIntelligence.shared.ingest(
                self.transcript.filter { !$0.interim }.map { CanvasItem($0.text, at: $0.at, speaker: $0.speaker) },
                force: true)
            // The live ID has been cleared; keep late final words and notes tied
            // to this recording before allowing the next recording to start.
            LocalStore.shared.saveNotes(meetingId: id, GenieStateStore.shared.state.meeting.canvas)
            if !RecordingRuntime.shared.cloudPendingIds.contains(id) { self.finishProcessing(id: id) }
            self.finishingRecording = false
            let pending = self.startAfterFinishing
            self.startAfterFinishing = nil
            if let pending { DispatchQueue.main.async(execute: pending) }
        }
    }

    /// 予定に紐づかない録音の題。「14:32 の会議」。
    static func untitledMeetingName(now: Date = Date()) -> String {
        let f = DateFormatter(); f.dateFormat = "HH:mm"
        return "\(f.string(from: now)) の会議"
    }

    /// 予定から録音するときに引き継ぐもの（§6）。start() が読んで消す。
    var pendingCalendarLink: CalendarLink?

    /// 読み取り。会議中に溜めた構造データをそのまま Session の中身にする。
    /// gateway が無くても成立するよう、手元の抽出結果を使う。
    private func finishProcessing(id: String) {
        let canvas = LocalStore.shared.loadNotes(meetingId: id)
        let speakers = Set(LocalStore.shared.loadTranscript(meetingId: id).map(\.speaker))
        let store = MeetingSessionStore.shared
        // 段階を順に進める。spinner だけでは「止まっている」と区別がつかない。
        let stages: [ProcessingStage] = [.savingTranscript, .analyzing, .extractingActions, .preparingNotes]
        for (index, stage) in stages.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45 * Double(index)) {
                store.setProcessingStage(stage, for: id)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45 * Double(stages.count)) {
            let summary = (canvas.decisions.first ?? canvas.notes.first)?.text
            store.markReady(
                id: id,
                summary: summary,
                actions: canvas.actions.count,
                decisions: canvas.decisions.count,
                participants: max(speakers.count, 0))
        }
    }

    /// サインイン済みセッションを渡す（Main Window のサインインから）。
    func configureBackend(base: String, token: String) {
        apiBase = base; apiToken = token
    }

    /// AI 操作。transcript を Agent（会話）に渡して結果を得る。要約/質問/決定事項/アクション。
    /// 同期 I/O なのでバックグラウンドで回し、結果を main で反映する。
    func runAIAction(_ title: String) {
        guard !aiRunning else { return }
        aiActionSucceeded = false
        guard let base = apiBase, let token = apiToken else {
            aiResult = "サインインすると AI 操作が使えます。"; return
        }
        let transcriptText = transcript.filter { !$0.interim && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map { "\($0.speaker): \($0.text)" }.joined(separator: "\n")
        guard !transcriptText.isEmpty else {
            aiResult = "発言が文字起こしされてから実行してください。"; return
        }
        let instruction: String
        switch title {
        case "リアルタイム要約": instruction = "次の会議の文字起こしを日本語で3行以内に要約して。"
        case "決定事項": instruction = "次の会議の文字起こしから決定事項だけを箇条書きで出して。"
        case "アクション": instruction = "次の会議の文字起こしから ToDo（担当と期限があれば付けて）を箇条書きで出して。"
        default: instruction = "次の会議の文字起こしについて答えて。"
        }
        aiRunning = true; aiResult = ""
        let prompt = instruction + "\n---\n" + transcriptText
        let key = MeetingAIRequests.Key(scope: base + "\n" + token, meeting: currentMeetingId,
                                        action: title, transcript: transcriptText)

        // §15 何をしているかを段階で見せる。Timeline はこの task を描くだけ（別に状態を持たない）。
        let steps = [
            AgentStep(title: "会話を用意する", tool: "conversation"),
            AgentStep(title: "文字起こしを読む", tool: "transcript"),
            AgentStep(title: "答えをまとめる", tool: "agent"),
        ]
        let store = GenieStateStore.shared
        let task = AgentTask(id: UUID(), title: title, status: .running, steps: steps,
                             startedAt: Date(), context: store.state.context)
        store.startTask(task, onStop: { [weak self] in self?.stopAIAction(base: base, token: token) })
        let stepIds = steps.map(\.id)

        aiJobId = nil
        aiTask = Task { [weak self] in
            guard let self else { return }
            do {
                store.updateStep(stepIds[0], to: .running)
                store.updateStep(stepIds[1], to: .success)
                store.updateStep(stepIds[2], to: .running)
                let answer = try await self.aiRequests.run(key, submit: {
                    let submission = try await Task.detached {
                        // Each action contains its full source snapshot. Reusing a
                        // conversation would append old full transcripts every time.
                        let conv = try GenieCoreBridge.startConversation(base, accessToken: token)
                        let outcome = try GenieCoreBridge.sendTurn(base, accessToken: token, conversationId: conv, text: prompt)
                        guard !outcome.needsClarification else {
                            throw TranslationFailure(message: outcome.notice.isEmpty ? "詳しく教えてください。" : outcome.notice)
                        }
                        return MeetingAIRequests.Submission(answer: outcome.answer, taskId: outcome.taskId)
                    }.value
                    // 止めるときに backend の仕事も取り消せるよう、id を覚えておく。
                    self.aiJobId = submission.taskId
                    return submission
                }, poll: { job in
                    try await Task.detached {
                        let done = try GenieCoreBridge.waitTask(base, accessToken: token, taskId: job, timeoutMs: 30_000)
                        if ["FAILED", "CANCELLED"].contains(done.status) { throw MeetingAIRequests.TerminalJobFailure() }
                        guard done.status == "COMPLETED", !done.resultArtifactId.isEmpty else {
                            throw TranslationFailure(message: "結果をまだ取得できません。再試行すると同じ処理の結果を確認します。")
                        }
                        return try GenieCoreBridge.artifactContent(base, accessToken: token, artifactId: done.resultArtifactId)
                    }.value
                })
                // 止めた後に届いた答えは使わない（止めた仕事を成功に見せない）。
                guard !Task.isCancelled else { return }
                store.updateStep(stepIds[0], to: .success)
                store.updateStep(stepIds[2], to: .success)
                store.finishTask(.success)
                if self.currentMeetingId == key.meeting {
                    self.aiActionSucceeded = true; self.aiResult = answer
                }
            } catch {
                guard !Task.isCancelled else { return }
                store.updateStep(stepIds[2], to: .failed)
                store.finishTask(.failed)
                if self.currentMeetingId == key.meeting { self.aiResult = "AI 操作に失敗しました: \(error.localizedDescription)" }
            }
            self.aiRunning = false
        }
    }

    /// Dock の「止める」から。待ちを取り消し、backend の仕事も取り消す（終わっていれば 409 で、何もしない）。
    /// 音声の停止ではない。結果の面は GenieStateStore が「取り消しました」で出す。
    private func stopAIAction(base: String, token: String) {
        aiTask?.cancel(); aiTask = nil
        aiRunning = false
        aiActionSucceeded = false
        aiResult = Facts.taskCancelled
        guard let job = aiJobId, !job.isEmpty else { return }
        aiJobId = nil
        Task.detached {
            do { _ = try GenieCoreBridge.cancelTask(base, accessToken: token, taskId: job) }
            catch { NSLog("AI action: cancel not delivered: \(error)") }
        }
    }

    func selectTool(_ tool: RecordingTool) {
        selectedTool = tool
        if tool == .translation { translate(to: translation.language.title) }
    }

    /// Selecting Translation starts incremental translation of confirmed utterances.
    func translate(to language: String = "英語") {
        translation.setLanguage(language == "日本語" ? .japanese : .english)
        translation.update(transcript)
        translation.setEnabled(true)
    }

    func togglePause() {
        isPaused.toggle()
        RecordingRuntime.shared.setPaused(isPaused)   // 実際に録音を止める（core が sample を捨てる）
    }
    /// 画面文脈を 1 枚取り、会議フォルダに保存する（Context Lens / 後追いの手掛かり）。
    /// 保存先パスを返す（失敗時 nil）。実フレーム取得は ScreenContextCapture（画面収録許可が要る）。
    @discardableResult
    func captureScreenshot() -> String? {
        guard #available(macOS 14.0, *), let image = ScreenContextCapture.captureFrameCG() else { return nil }
        let dir = LocalStore.dataRoot
            .appendingPathComponent("meetings/\(currentMeetingId)/screens", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("screen-\(Int(Date().timeIntervalSince1970)).png")
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return url.path
    }
}
