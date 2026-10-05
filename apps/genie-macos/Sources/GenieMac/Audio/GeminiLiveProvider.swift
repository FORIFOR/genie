import AVFoundation
import Foundation

/// Gemini Live を使うかと、その上限。**本人がはっきり有効にし、上限を決め、キーを置いたときだけ**使う。
///
/// キーは本人のもの（Genie は共通の API キーを持たない）。macOS のキーチェーンにだけ置き、
/// アプリにもログにも出さない。送るときは URL ではなくヘッダーに載せる（URL はログに残りやすい）。
@MainActor
final class GeminiLiveSettings: ObservableObject {
    static let shared = GeminiLiveSettings()
    static let keychainKey = "gemini.live.apiKey"
    private static let enabledKey = "genie.geminiLive.enabled"
    private static let minutesKey = "genie.geminiLive.monthlyMinutes"
    private static let usedKey = "genie.geminiLive.usedSeconds"
    private static let monthKey = "genie.geminiLive.month"

    @Published private(set) var enabled: Bool
    @Published private(set) var budget: GeminiLiveBudget
    @Published private(set) var hasKey: Bool

    private let defaults: UserDefaults
    @Published private(set) var checkingKey = false
    @Published private(set) var keyAccessIssue: String?
    private let presenceReader: (@Sendable () throws -> Bool)?
    private var presenceTask: Task<Result<Bool, Error>, Never>?
    private var presenceGeneration = 0

    /// Fixtures can supply key presence without reading the person's Keychain.
    /// Normal construction never synchronously reads secret data on the main actor.
    init(defaults: UserDefaults = .standard, initialHasKey: Bool? = nil,
         presenceReader: (@Sendable () throws -> Bool)? = nil) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: Self.enabledKey)
        budget = GeminiLiveBudget(monthlyMinutes: defaults.integer(forKey: Self.minutesKey),
                                  usedSeconds: defaults.double(forKey: Self.usedKey),
                                  month: defaults.string(forKey: Self.monthKey) ?? "")
        hasKey = initialHasKey ?? false
        let key = Self.keychainKey
        self.presenceReader = initialHasKey != nil && presenceReader == nil ? nil
            : (presenceReader ?? { try KeychainStore.contains(key) })
        if self.presenceReader != nil {
            checkingKey = true
            Task { [weak self] in await self?.refreshKeyPresence() }
        }
    }

    /// Coalesce settings appearances and explicit use; no key bytes enter this probe.
    func refreshKeyPresence() async {
        guard let read = presenceReader else { return }
        let task: Task<Result<Bool, Error>, Never>
        if let pending = presenceTask { task = pending }
        else {
            checkingKey = true; presenceGeneration += 1
            task = Task.detached { Result { try read() } }
            presenceTask = task
        }
        let generation = presenceGeneration
        let result = await task.value
        guard generation == presenceGeneration, presenceTask != nil else { return }
        presenceTask = nil; checkingKey = false
        switch result {
        case .success(let present): hasKey = present; keyAccessIssue = nil
        case .failure: hasKey = false; keyAccessIssue = KeychainStore.accessMessage
        }
    }

    /// 会話でこの提供元を使うか。どれか 1 つでも欠けていれば使わない（いまの経路のまま）。
    var active: Bool { enabled && hasKey && !checkingKey && keyAccessIssue == nil && budget.monthlyMinutes > 0 }

    /// 会話を始められるか（会話は Gemini Live だけ。クレジット切れは、つないだ時に分かるので毎回試す）。
    var canConverse: Bool { enabled && hasKey && keyAccessIssue == nil }

    func setEnabled(_ on: Bool) { enabled = on; defaults.set(on, forKey: Self.enabledKey) }

    func setMonthlyMinutes(_ minutes: Int) {
        budget.monthlyMinutes = max(0, min(minutes, 6_000))
        defaults.set(budget.monthlyMinutes, forKey: Self.minutesKey)
    }

    /// キーを置く・消す（空で消す）。成否だけ返す。キーそのものは返さない。
    @discardableResult
    func setKey(_ key: String) -> Bool {
        guard !checkingKey, keyAccessIssue == nil else { return false }
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if trimmed.isEmpty { try KeychainStore.delete(Self.keychainKey) } else { try KeychainStore.set(Self.keychainKey, trimmed) }
            hasKey = !trimmed.isEmpty; keyAccessIssue = nil
            WakeController.shared.clearBillingFailure()   // キーを替えた = もう一度つないでよい
            return true
        } catch {
            keyAccessIssue = KeychainStore.accessMessage
            return false
        }
    }

    func apiKey() -> String? {
        do {
            guard let value = try KeychainStore.get(Self.keychainKey) else { return nil }
            guard !value.isEmpty else { throw KeychainStore.KeychainError.invalidData }
            return value
        }
        catch { keyAccessIssue = KeychainStore.accessMessage; return nil }
    }

    func record(seconds: Double, at date: Date = Date()) {
        budget.record(seconds: seconds, at: date)
        defaults.set(budget.usedSeconds, forKey: Self.usedKey)
        defaults.set(budget.month, forKey: Self.monthKey)
    }
}

/// Gemini Live（音声どうし）を、会話の進み方（`ConversationLoop`）に合わせる提供元。
///
/// - 聞く: マイクの 16 kHz を送り続ける。Gemini が相手の区切りを判断して答え始めたら、
///   そこまでの文字起こしを「言い終えた」として返す。
/// - 答える: 答えの声は**届いた順にすぐ流す**（以前は turnComplete まで溜めてから一度に流し、そのぶん返事が遅れた）。
///   読み上げの合図（`speak`）では、まだ流れている分が終わるのを待つだけ。
/// - 割り込み（`interrupted`）: 再生中と再生待ちの声を捨てる。世代を進め、遅れて届いた古い声も流さない。
/// - 仕事: `delegate_task` を受けたら Genie の既存の経路に渡し、受け付けたかだけを返す（区切りで伝える WHEN_IDLE）。
/// - 切れる: 接続は約 10 分で切れる（goAway）。再開の鍵があれば同じ会話へつなぎ直す（最大 3 回）。
///   鍵が無い・つなげないときだけ `onLost` で会話を終える。**ほかの有料の提供元へは切り替えない。**
@MainActor
final class GeminiLiveProvider: ConversationProvider {
    let name = "gemini-live"
    /// 声で割り込める（全二重）のは、Gemini の声を共有マイクと同じ engine で鳴らし、エコー除去できるときだけ。
    var capabilities: ConversationCapabilities { ConversationCapabilities(bargeIn: input.canPlay, sendsAudioOffDevice: true,
                                                synthesizesOffDevice: true, mayNotRespond: true) }

    private let apiKey: String
    private let model: String
    private let delegate: (String) async -> String
    private let onLost: (String) -> Void
    private let settings: GeminiLiveSettings

    private var socket: URLSessionWebSocketTask? { didSet { lane.attach(socket) } }
    private let lane = AudioSendLane()
    private var ready = false
    private var connectedAt: Date?
    private var pendingOpen: (() -> Void)?
    /// つながったら挨拶を促す（呼びかけの声が無いまま始めたとき）。1 回だけ。
    var greetWhenReady = false
    /// 検査用: 挨拶の代わりに送る最初の依頼文。
    var openingPrompt: String?
    /// 挨拶を促す（「ジーニー」とだけ呼ばれた）。つながっていればすぐ、まだなら setupComplete で。
    func greetSoon() {
        if ready { send(GeminiLive.greeting); mark("greeting-prompted") } else { greetWhenReady = true }
    }

    /// 本人が会話を終えたいと言った（end_conversation）。会話の側が閉じる。
    var onEndRequested: (() -> Void)?
    private var endWhenDrained = false
    /// マイクは Genie 全体で 1 本（呼びかけの待ち受けと共有。呼びかけの前後の声もここから届く）。
    private let input: VoiceInputHub
    private var streaming = false

    private var onFirstFrame: (() -> Void)?
    private var onUtterance: ((String) -> Void)?
    private var onReply: ((ConversationLoop.Reply) -> Void)?
    private var heard = ""
    private var said = ""
    private var answered = false
    /// このターンで Gemini の声を流したか（流していなければ、読み上げは Mac の声で伝える）。
    private var streamedThisTurn = false

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var playing: UUID?
    /// 再生の世代。割り込み・停止で進める。古い世代の再生完了・遅れた声は捨てる。
    private var playbackGeneration = 0
    /// まだ流し終えていない声の数（この世代）。
    private var queuedBuffers = 0
    /// 流し終えるのを待っている読み上げの合図。
    private var drainWaiter: (() -> Void)?
    private var playerFormat: AVAudioFormat?
    private var budgetTimer: Task<Void, Never>?
    /// 再開の鍵（`sessionResumptionUpdate`）。`resumable` のときだけ持つ。
    private var resumeHandle: String?
    private var reconnects = 0
    static let maxReconnects = 3
    /// 検査用の足跡（時刻つき、最新 50 件）。声・文字の中身は入れない。
    private(set) var trace: [(Date, String)] = []
    private func mark(_ event: String) {
        trace.append((Date(), event))
        if trace.count > 50 { trace.removeFirst(trace.count - 50) }
    }

    init(apiKey: String, model: String = GeminiLive.defaultModel, settings: GeminiLiveSettings,
         delegate: @escaping (String) async -> String, onLost: @escaping (String) -> Void,
         input: VoiceInputHub = .shared) {
        self.input = input
        self.apiKey = apiKey
        self.model = model
        self.settings = settings
        self.delegate = delegate
        self.onLost = onLost
        engine.attach(player)
    }

    // MARK: - ConversationProvider

    func openInput(echoCancellation: Bool, onFirstFrame: @escaping () -> Void,
                   onUtterance: @escaping (String) -> Void) -> Bool {
        guard Permissions.microphone == .granted else { return false }
        self.onFirstFrame = onFirstFrame
        self.onUtterance = onUtterance
        heard = ""; said = ""; answered = false; streamedThisTurn = false
        if streaming { onFirstFrame(); return true }   // 全二重: 送り続けている（次のターンの区切りだけ戻す）
        if ready { startMic(echoCancellation: echoCancellation) }
        else {
            pendingOpen = { [weak self] in self?.startMic(echoCancellation: echoCancellation) }
            connect()
        }
        return true
    }

    func closeInput() {
        // 接続の準備が済む前に閉じられたら、済んだ時にマイクを開く約束も取り消す（消音が効かなかった）。
        pendingOpen = nil
        guard streaming else { return }
        streaming = false
        lane.setOpen(false)
        input.pause()
        send(GeminiLive.audioStreamEnd)
    }

    /// 声はもう送ってある。ここでは答え（turnComplete）を待つだけ。
    func send(_ text: String, onReply: @escaping (ConversationLoop.Reply) -> Void) {
        self.onReply = onReply
    }

    /// 読み上げの合図。Gemini の声は届いた時から流しているので、流し終えるのを待つだけ（`text` は表示・記録用）。
    func speak(_ text: String, onFinish: @escaping () -> Void) {
        if streamedThisTurn {
            streamedThisTurn = false
            if queuedBuffers == 0 { onFinish() } else { drainWaiter = onFinish }
            return
        }
        // Gemini が声を作っていない知らせ（受付・失敗・預かり）は、Mac の読み上げで伝える。黙らない。
        let spoken = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { onFinish(); return }
        let id = UUID()
        playing = id
        GenieSpeechOutput.shared.read(spoken, owner: id) { [weak self] in
            guard let self, self.playing == id else { return }
            self.playing = nil
            onFinish()
        }
    }

    /// 届いた声を、すぐ再生の列に足す（ためない）。
    private func enqueue(_ pcm: Data, rate: Int) {
        let samples = Self.floats(from: pcm)
        guard !samples.isEmpty,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(rate), channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in buffer.floatChannelData![0].update(from: src.baseAddress!, count: samples.count) }
        let generation = playbackGeneration
        if queuedBuffers == 0 { mark("playback-start") }
        queuedBuffers += 1
        streamedThisTurn = true
        let finished: () -> Void = { [weak self] in
            Task { @MainActor in
                guard let self, self.playbackGeneration == generation else { return }
                self.queuedBuffers = max(0, self.queuedBuffers - 1)
                if self.queuedBuffers == 0, self.endWhenDrained { self.endWhenDrained = false; self.onEndRequested?() }
                if self.queuedBuffers == 0, let waiter = self.drainWaiter {
                    self.drainWaiter = nil
                    waiter()
                }
            }
        }
        // 共有マイクの engine で鳴らす（エコー除去で Genie 自身の声を消し、話しながら聞ける）。
        if input.canPlay, format.sampleRate == MicCapture.playbackFormat.sampleRate {
            input.setEchoCancellation(true)
            input.play(buffer, completion: finished)
            return
        }
        do {
            if playerFormat?.sampleRate != format.sampleRate {
                engine.disconnectNodeOutput(player)
                engine.connect(player, to: engine.mainMixerNode, format: format)
                playerFormat = format
            }
            if !engine.isRunning { try engine.start() }
        } catch { finished(); return }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in finished() }
        if !player.isPlaying { player.play() }
    }

    /// 再生中と再生待ちの声を捨てる（割り込み・停止）。世代を進め、古い完了の知らせと遅れた声を無視する。
    private func clearPlayback() {
        if queuedBuffers > 0 { mark("playback-cleared-\(queuedBuffers)") }
        playbackGeneration += 1
        queuedBuffers = 0
        player.stop()
        input.stopPlayback()
    }

    func stopSpeaking() {
        if let id = playing { GenieSpeechOutput.shared.stop(owner: id) }
        playing = nil
        clearPlayback()
        drainWaiter = nil
    }

    func endSession() {
        closeInput()
        stopSpeaking()
        budgetTimer?.cancel(); budgetTimer = nil
        if let connectedAt { settings.record(seconds: Date().timeIntervalSince(connectedAt)) }
        connectedAt = nil
        ready = false
        lane.setOpen(false)
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        onReply = nil; onUtterance = nil; onFirstFrame = nil; pendingOpen = nil
        resumeHandle = nil; reconnects = 0
        if engine.isRunning { engine.stop() }
        input.detach()
    }

    // MARK: - 接続

    /// 接続先の差し替え。**この Mac の中（127.0.0.1 / localhost）だけ**。検査用の偽の Gemini にしか向けられない。
    private static var endpointOverride: URL?

    /// 検査用: 手元の偽の Gemini（`tools/gemini-fake/server.mjs`）へつなぐ提供元。本物の API へは向けられない
    /// （ループバック以外の宛先なら nil）。本物の Gemini へつなぐ提供元は `VoiceHUDState.beginConversation` だけが作る
    /// （同意・キー・上限を確かめた後。`scripts/verify-privacy-egress.sh`）。
    static func forLocalFake(url: URL, settings: GeminiLiveSettings, delegate: @escaping (String) async -> String,
                             onLost: @escaping (String) -> Void, input: VoiceInputHub = .shared) -> GeminiLiveProvider? {
        guard ["ws", "wss"].contains(url.scheme ?? ""), ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "") else { return nil }
        endpointOverride = url
        return GeminiLiveProvider(apiKey: "local-fake", settings: settings, delegate: delegate, onLost: onLost, input: input)
    }

    /// つながる（setupComplete）までの待ちの上限。超えたら預かった声は送らずに終える（再発話してもらう）。
    static let connectTimeout: TimeInterval = 8

    private func connect() {
        guard socket == nil else { return }
        openSocket(resume: nil)
        connectedAt = Date()
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.connectTimeout * 1_000_000_000))
            guard let self, self.socket != nil, !self.ready else { return }
            self.mark("connect-timeout")
            self.lose("Gemini Live に \(Int(Self.connectTimeout)) 秒つながらなかったので、会話を終えました。もう一度お話しください。")
        }
        // 今月の残りを超えて話し続けない。
        let remaining = settings.budget.remainingSeconds(at: Date())
        budgetTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.lose("今月の Gemini Live の上限に達したので、会話を終えました。")
        }
    }

    private func openSocket(resume handle: String?) {
        var request = URLRequest(url: Self.endpointOverride ?? GeminiLive.endpoint)
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task
        ready = false
        lane.setOpen(false)
        task.resume()
        send(GeminiLive.setup(model: model, instruction: Self.instruction, resumeHandle: handle))
        receive(task)
    }

    /// 同じ会話へつなぎ直す（接続の寿命・回線の切断）。鍵が無い・回数を超えたら false。
    /// 聞いている途中なら、つながり次第マイクの声を送り直す。流している声・待っている答えはそのまま。
    private func resume() -> Bool {
        guard let handle = resumeHandle, reconnects < Self.maxReconnects else { return false }
        reconnects += 1
        mark("resume-\(reconnects)")
        let old = socket
        socket = nil
        old?.cancel(with: .goingAway, reason: nil)
        if streaming { pendingOpen = { } }
        openSocket(resume: handle)
        return true
    }

    /// 役割・話し方・会話・正確さと実行を分けて書く（公式の推奨）。言語は指示で決める（languageCode は使わない）。
    static let instruction = """
    あなたは Mac の作業を手伝う音声アシスタントの Genie です。自然な日本語で話してください。
    利用者は日本語で話します。聞き取った言葉は日本語として扱ってください（韓国語など別の言語として解釈しないでください）。

    【話し方】
    丁寧な言葉づかいで話してください。「です・ます」調を基本に、相手の行動には尊敬語、自分の行動には謙譲語を使ってください
    （例:「確認いたします」「お調べしますね」「ご希望の日時を教えていただけますか」）。
    くだけた言い方（「〜だよ」「〜しとくね」）は使わないでください。丁寧でも、回りくどい前置きや過剰な敬語は避けてください。
    普段の返答は 1〜3 文を目安にし、必要な情報から話してください。詳しい説明を求められた場合は、必要な長さで説明してください。
    毎回「承知しました」「なるほど」から始めないでください。相手の発言を毎回そのまま復唱しないでください。
    不自然な笑い声、過剰な共感、わざとらしい言い淀みを加えないでください。

    【呼びかけ】
    会話の最初に「ジーニー」とだけ呼ばれたら、「はい、どうされましたか？」と短く応えてください。
    「ジーニー、〇〇して」のように続けて頼まれたら、挨拶を挟まずに依頼に答えてください。

    【会話を終える】
    「終了して」「終わって」「終わり」「おしまい」「閉じて」「バイバイ」「さようなら」「またね」など会話を終えたいと言われたら、
    必ず「承知しました」とだけ言ってから end_conversation を呼んでください。会話を続けようとしないでください。

    【会話】
    言い直しがあった場合は、最後の訂正を採用してください。
    確認質問は、回答や実行に必要なものを一つずつ聞いてください。
    沈黙のたびに話しかけたり、返事を催促したりしないでください。
    割り込まれた後は、直前の説明を最初から繰り返さないでください。

    【正確さと実行】
    分からない事実を推測で断定しないでください。数字や予定を作らないでください。
    天気・ニュース・営業時間・一般的な事実など、公開されている情報を聞かれたら、Google 検索で調べて、その結果を声で要点だけお伝えしてください。
    調べられなかった場合は、推測で答えずにそう伝えてください。
    Mac での作業・アプリの操作・送信・注文や予約（モバイルオーダー・デリバリーを含む）を頼まれたら、断らずに、
    自分で済ませたふりもせず、必ず delegate_task に依頼文を渡し、受け付けたかどうかだけを伝えてください。
    支払い・注文の確定・送信の前には Genie が画面で本人に確認を求めるので、あなたが代わりに断ったり止めたりする必要はありません。
    Genie は Mac の画面に見せることができます。「見せて」「開いて」「サイトで見たい」「商品を見たい」と頼まれたら、
    「お見せできません」とは言わずに、delegate_task に依頼文を渡してください（例:「オークリーのサングラスを公式サイトで見せて」）。
    Genie がブラウザで公式サイトや該当のページを開きます。
    「近くのご飯屋さん」「近くのカフェ」など近くの店や場所を聞かれたら、現在地を尋ねずに delegate_task に依頼文を渡してください。
    Genie が Mac の現在地と地図で探し、画面に地図つきのカードを出します（店名や住所はあなたには届きません）。
    実行結果が成功するまで「完了しました」「注文しました」と言わないでください。
    重要な名前・金額・日時・店舗・品目が曖昧な場合は、その部分だけ確認してください。
    """

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                // 古い接続（つなぎ直した後）からの知らせは捨てる。
                guard let self, self.socket === task else { return }
                switch result {
                case .failure:
                    // 利用枠・キーの問題はつなぎ直しても直らない。理由を言って終える。
                    if let fatal = GeminiLive.fatalCloseMessage(code: task.closeCode.rawValue,
                                                                reason: task.closeReason.flatMap { String(data: $0, encoding: .utf8) }) {
                        self.mark("closed-fatal-\(task.closeCode.rawValue)")
                        self.lose(fatal)
                    } else if !self.resume() { self.lose("Gemini との接続が切れました。") }
                case .success(let message):
                    let text: String? = switch message {
                    case .string(let s): s
                    case .data(let d): String(data: d, encoding: .utf8)
                    @unknown default: nil
                    }
                    if let text { for event in GeminiLive.parse(text) { self.handle(event) } }
                    if self.socket === task { self.receive(task) }
                }
            }
        }
    }

    private func handle(_ event: GeminiLive.ServerEvent) {
        switch event {
        case .setupComplete:
            ready = true
            lane.setOpen(streaming)
            if greetWhenReady {
                greetWhenReady = false
                send(openingPrompt.map(GeminiLive.userText) ?? GeminiLive.greeting)
            }
            pendingOpen?(); pendingOpen = nil
        case .inputTranscript(let t):
            heard += t
        case .audio(let pcm, let rate):
            userTurnEnded()
            enqueue(pcm, rate: rate)
        case .outputTranscript(let t):
            userTurnEnded()
            said += t
        case .toolCall(let id, let name, let request):
            userTurnEnded()
            if name == GeminiLive.endTool {
                send(GeminiLive.toolResponse(id: id, name: name, response: ["status": "closing"], scheduling: "SILENT"))
                mark("end-requested")
                // 「承知しました」を言い終えてから閉じる（流している声があれば待つ）。
                endWhenDrained = true
                // 声が来ない・止まったままでも 4 秒で閉じる。
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    guard let self, self.endWhenDrained else { return }
                    self.endWhenDrained = false; self.onEndRequested?()
                }
                return
            }
            guard name == GeminiLive.delegateTool else {
                send(GeminiLive.toolResponse(id: id, name: name, response: ["error": "unknown tool"]))
                return
            }
            Task { [weak self] in
                guard let self else { return }
                let status = await self.delegate(request)
                self.send(GeminiLive.toolResponse(id: id, name: name, response: ["status": status]))
            }
        case .turnComplete:
            mark("turn-complete")
            guard answered, let reply = onReply else { return }
            onReply = nil
            reply(.settled(said))
        case .goAway:
            // 接続の寿命。鍵があれば同じ会話へつなぎ直す（会話は終えない）。
            if !resume() { lose("Gemini との接続が終わりました。") }
        case .resumption(let handle, let resumable):
            if resumable { resumeHandle = handle }
        case .interrupted:
            mark("interrupted")
            // 話し始めた・割り込まれた。流している声と待ちの声を捨てる。読み上げの終わりを待っていれば、次を聞く。
            clearPlayback()
            if let waiter = drainWaiter { drainWaiter = nil; waiter() }
        case .generationComplete, .toolCallCancelled, .usage:
            break
        }
    }

    /// Gemini が答え始めた = 相手の区切りが来た。1 ターンに 1 回だけ「言い終えた」を返す。
    private func userTurnEnded() {
        guard !answered else { return }
        answered = true
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        onUtterance?(text.isEmpty ? "（音声）" : text)
    }

    private func startMic(echoCancellation: Bool) {
        streaming = true
        lane.setOpen(ready)
        let lane = self.lane
        var first = true
        do {
            // 預かっていた声（呼びかけの前後・接続を待つ間）を先に、以降の声を順に送る。
            // ここに来るのは setupComplete の後（それより前の音声は受け付けられない）。
            // 送るのは共有マイクの直列の列から、1 本の流れで（順番を仕組みで守る）。
            let flushed = try input.attach { [weak self] frame in
                guard lane.send(frame), first else { return }
                first = false
                Task { @MainActor in self?.onFirstFrame?() }
            }
            if flushed > 0 { mark(String(format: "sent %.1fs held audio", flushed)) }
        } catch {
            lose("マイクを開けませんでした。")
        }
    }

    private func send(_ object: [String: Any]) {
        socket?.send(.string(GeminiLive.json(object))) { _ in }
    }

    /// 切れた・上限に達した。**必ず片付けてから**会話を終える（答えを待っている途中でも）。
    /// 以前は待っている答えに失敗を返すだけで、会話は切れた接続のまま・上限を超えて続いていた。
    private func lose(_ reason: String) {
        guard socket != nil || ready else { return }
        mark("lost")
        onReply = nil
        closeInput()
        ready = false
        lane.setOpen(false)
        budgetTimer?.cancel(); budgetTimer = nil
        if let connectedAt { settings.record(seconds: Date().timeIntervalSince(connectedAt)) }
        connectedAt = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        onLost(reason)
    }

    nonisolated static func floats(from pcm: Data) -> [Float] {
        pcm.withUnsafeBytes { raw in
            let count = raw.count / 2
            return (0..<count).map { i in
                let v = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))
                return Float(v) / Float(Int16.max)
            }
        }
    }
}

/// マイクの声を Gemini へ送る**1 本の流れ**。共有マイクの直列の列（`VoiceInputHub` の queue）から順に呼ばれ、
/// そのままの順で WebSocket へ渡す（音の小片ごとに別の非同期処理を作らない = 順番が入れ替わる余地を作らない）。
/// 開いているのは setupComplete の後・送ってよい間だけ。
final class AudioSendLane: @unchecked Sendable {
    private let lock = NSLock()
    private var socket: URLSessionWebSocketTask?
    private var open = false

    func attach(_ socket: URLSessionWebSocketTask?) { lock.lock(); self.socket = socket; lock.unlock() }
    func setOpen(_ on: Bool) { lock.lock(); open = on; lock.unlock() }

    /// 送れたら true（閉じている間の声は送らない）。
    @discardableResult
    func send(_ frame: [Float]) -> Bool {
        lock.lock(); let target = open ? socket : nil; lock.unlock()
        guard let target else { return false }
        target.send(.string(GeminiLive.json(GeminiLive.audioChunk(frame)))) { _ in }
        return true
    }
}
