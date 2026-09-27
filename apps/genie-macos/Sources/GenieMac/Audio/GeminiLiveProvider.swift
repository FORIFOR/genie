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

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: Self.enabledKey)
        budget = GeminiLiveBudget(monthlyMinutes: defaults.integer(forKey: Self.minutesKey),
                                  usedSeconds: defaults.double(forKey: Self.usedKey),
                                  month: defaults.string(forKey: Self.monthKey) ?? "")
        hasKey = ((try? KeychainStore.get(Self.keychainKey)) ?? nil)?.isEmpty == false
    }

    /// 会話でこの提供元を使うか。どれか 1 つでも欠けていれば使わない（いまの経路のまま）。
    var active: Bool { enabled && hasKey && budget.monthlyMinutes > 0 }

    func setEnabled(_ on: Bool) { enabled = on; defaults.set(on, forKey: Self.enabledKey) }

    func setMonthlyMinutes(_ minutes: Int) {
        budget.monthlyMinutes = max(0, min(minutes, 6_000))
        defaults.set(budget.monthlyMinutes, forKey: Self.minutesKey)
    }

    /// キーを置く・消す（空で消す）。成否だけ返す。キーそのものは返さない。
    @discardableResult
    func setKey(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if trimmed.isEmpty { try KeychainStore.delete(Self.keychainKey) } else { try KeychainStore.set(Self.keychainKey, trimmed) }
            hasKey = !trimmed.isEmpty
            return true
        } catch {
            return false
        }
    }

    func apiKey() -> String? { (try? KeychainStore.get(Self.keychainKey)) ?? nil }

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
/// - 考える: マイクを閉じ、答えの声と文字起こしを turnComplete まで溜める。
/// - 読み上げる: 溜めた Gemini 自身の声を再生し、再生し終えたら次を聞く。答えが無ければすぐ次を聞く。
/// - 仕事: `delegate_task` を受けたら Genie の既存の経路に渡し、受け付けたかだけを返す。
/// - 止まる: 切断・上限到達は `onLost` で会話を終える。**ほかの有料の提供元へは切り替えない。**
@MainActor
final class GeminiLiveProvider: ConversationProvider {
    let name = "gemini-live"
    let capabilities = ConversationCapabilities(bargeIn: false, sendsAudioOffDevice: true,
                                                synthesizesOffDevice: true, mayNotRespond: true)

    private let apiKey: String
    private let model: String
    private let delegate: (String) async -> String
    private let onLost: (String) -> Void
    private let settings: GeminiLiveSettings

    private var socket: URLSessionWebSocketTask?
    private var ready = false
    private var connectedAt: Date?
    private var pendingOpen: (() -> Void)?
    private let mic = MicCapture()
    private let micQueue = DispatchQueue(label: "genie.gemini.mic")
    private var streaming = false

    private var onFirstFrame: (() -> Void)?
    private var onUtterance: ((String) -> Void)?
    private var onReply: ((ConversationLoop.Reply) -> Void)?
    private var heard = ""
    private var said = ""
    private var answered = false
    private var audio: [(Data, Int)] = []

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var playing: UUID?
    private var budgetTimer: Task<Void, Never>?

    init(apiKey: String, model: String = GeminiLive.defaultModel, settings: GeminiLiveSettings,
         delegate: @escaping (String) async -> String, onLost: @escaping (String) -> Void) {
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
        heard = ""; said = ""; answered = false; audio = []
        if ready { startMic(echoCancellation: echoCancellation) }
        else {
            pendingOpen = { [weak self] in self?.startMic(echoCancellation: echoCancellation) }
            connect()
        }
        return true
    }

    func closeInput() {
        guard streaming else { return }
        streaming = false
        micQueue.async { [mic] in mic.stop() }
        send(GeminiLive.audioStreamEnd)
    }

    /// 声はもう送ってある。ここでは答え（turnComplete）を待つだけ。
    func send(_ text: String, onReply: @escaping (ConversationLoop.Reply) -> Void) {
        self.onReply = onReply
    }

    /// 溜めた Gemini の声を再生する（`text` は文字起こし。表示・記録用）。
    func speak(_ text: String, onFinish: @escaping () -> Void) {
        let chunks = audio
        audio = []
        guard !chunks.isEmpty else {
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
            return
        }
        let id = UUID()
        playing = id
        do {
            let rate = chunks[0].1
            guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(rate), channels: 1, interleaved: false) else { onFinish(); return }
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            if !engine.isRunning { try engine.start() }
            let samples = chunks.flatMap { Self.floats(from: $0.0) }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { onFinish(); return }
            buffer.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { src in buffer.floatChannelData![0].update(from: src.baseAddress!, count: samples.count) }
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.playing == id else { return }
                    self.playing = nil
                    onFinish()
                }
            }
            player.play()
        } catch {
            playing = nil
            onFinish()
        }
    }

    func stopSpeaking() {
        if let id = playing { GenieSpeechOutput.shared.stop(owner: id) }
        playing = nil
        player.stop()
    }

    func endSession() {
        closeInput()
        stopSpeaking()
        budgetTimer?.cancel(); budgetTimer = nil
        if let connectedAt { settings.record(seconds: Date().timeIntervalSince(connectedAt)) }
        connectedAt = nil
        ready = false
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        onReply = nil; onUtterance = nil; onFirstFrame = nil; pendingOpen = nil
        if engine.isRunning { engine.stop() }
    }

    // MARK: - 接続

    private func connect() {
        guard socket == nil else { return }
        var request = URLRequest(url: GeminiLive.endpoint)
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task
        task.resume()
        connectedAt = Date()
        send(GeminiLive.setup(model: model, instruction: Self.instruction))
        receive()
        // 今月の残りを超えて話し続けない。
        let remaining = settings.budget.remainingSeconds(at: Date())
        budgetTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.lose("今月の Gemini Live の上限に達したので、会話を終えました。")
        }
    }

    private static let instruction = """
    あなたは Mac の作業を手伝う Genie です。日本語で、短く、落ち着いて話します。
    作業・操作・調べもの・送信などを頼まれたら、自分で済ませたふりをせず、必ず delegate_task に依頼文を渡し、
    受け付けたかどうかだけを伝えます。「完了しました」とは言いません。数字や予定は推測で作りません。
    """

    private func receive() {
        socket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket != nil else { return }
                switch result {
                case .failure:
                    self.lose("Gemini との接続が切れました。")
                case .success(let message):
                    let text: String? = switch message {
                    case .string(let s): s
                    case .data(let d): String(data: d, encoding: .utf8)
                    @unknown default: nil
                    }
                    if let text { for event in GeminiLive.parse(text) { self.handle(event) } }
                    self.receive()
                }
            }
        }
    }

    private func handle(_ event: GeminiLive.ServerEvent) {
        switch event {
        case .setupComplete:
            ready = true
            pendingOpen?(); pendingOpen = nil
        case .inputTranscript(let t):
            heard += t
        case .audio(let pcm, let rate):
            userTurnEnded()
            audio.append((pcm, rate))
        case .outputTranscript(let t):
            userTurnEnded()
            said += t
        case .toolCall(let id, let name, let request):
            userTurnEnded()
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
            guard answered, let reply = onReply else { return }
            onReply = nil
            reply(.settled(said))
        case .goAway:
            lose("Gemini との接続が終わりました。")
        case .interrupted, .generationComplete, .toolCallCancelled, .usage:
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
        var first = true
        micQueue.async { [weak self, mic] in
            do {
                try mic.start(echoCancellation: echoCancellation) { frame in
                    let message = GeminiLive.json(GeminiLive.audioChunk(frame))
                    Task { @MainActor in
                        guard let self, self.streaming else { return }
                        if first { first = false; self.onFirstFrame?() }
                        self.socket?.send(.string(message)) { _ in }
                    }
                }
            } catch {
                Task { @MainActor in self?.lose("マイクを開けませんでした。") }
            }
        }
    }

    private func send(_ object: [String: Any]) {
        socket?.send(.string(GeminiLive.json(object))) { _ in }
    }

    /// 切れた・上限に達した。**必ず片付けてから**会話を終える（答えを待っている途中でも）。
    /// 以前は待っている答えに失敗を返すだけで、会話は切れた接続のまま・上限を超えて続いていた。
    private func lose(_ reason: String) {
        guard socket != nil || ready else { return }
        onReply = nil
        closeInput()
        ready = false
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
