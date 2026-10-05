import AppKit

/// 「ジーニー」から Gemini Live の会話へ。
///
/// - 待機中は `VoiceInputHub` が端末の中だけで聞き、検出器（端末で動く呼びかけ専用モデル）に渡す。外へは送らない
/// - 検出したら、呼びかけの前後の声を預かったまま Gemini Live の会話を始める（つながったら順に渡す）
/// - 会話中は検出を休む（Genie 自身の声で起きない）。会話が終われば待機へ戻る
/// - Gemini Live が使えなければ会話を始めず、預かった声を捨てて理由を出す（標準の会話には切り替えない）
///
/// 検出器のモデルがまだ無い間は待ち受けない（検出しないマイクは開かない）。メニューの「呼びかけを試す」で
/// 検出したことにして、会話への引き継ぎだけを確かめられる。
@MainActor
final class WakeController {
    static let shared = WakeController()
    static let enabledKey = WakeWordListener.enabledKey
    /// 検出の後、話が続くかを見る長さと、続いたとみなす声の長さ。
    static let continuationWindow = 0.9
    static let continuationSpeech = 0.25
    private let hub: VoiceInputHub
    private(set) var detector: WakeDetector?

    init(hub: VoiceInputHub = .shared) { self.hub = hub }

    /// 画面ロック・スリープの間はマイクを開かない（待ち受けも止める）。
    private var paused = false
    private var observers: [NSObjectProtocol] = []
    /// Gemini の支払い・クレジットで断られた後は、呼びかけのたびに接続し直さない。
    /// 本人が Dock から会話を始める・「呼びかけを試す」・キーを登録し直すまで、検出しても理由を出すだけ。
    private(set) var billingBlocked: String?
    /// いまの会話が（試しではない）呼びかけの検出で始まったか・いつ起きたか。
    var startedByWake = false
    private(set) var wokeAt: Date?

    func noteBillingFailure(_ reason: String) { billingBlocked = reason }

    /// 呼びかけで始めた会話が、言葉の無いまま終わった = 誤検出。起きた 2 秒を端末の中に残す
    /// （`~/Library/Application Support/Genie/wake/false/`、0600。次の学び直しで「起きない」例にする）。
    func noteFalseWake() {
        guard let window = (detector as? LiveKitWakeDetector)?.lastFiredWindow else { return }
        let dir = WakeEnrollment.directory.appendingPathComponent("false", isDirectory: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
        let url = dir.appendingPathComponent("false-\(stamp).wav")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try WakeEnrollment.writeWAV(window.map { Float($0) / Float(Int16.max) }, to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            GenieLog.write("wake", "false wake kept for retraining")
        } catch {
            GenieLog.write("wake", "could not keep the false wake: \(error)")
        }
    }
    func clearBillingFailure() { billingBlocked = nil }

    private func observeLockAndSleep() {
        guard observers.isEmpty else { return }
        let workspace = NSWorkspace.shared.notificationCenter
        let distributed = DistributedNotificationCenter.default()
        let pause: (Notification) -> Void = { [weak self] _ in
            Task { @MainActor in guard let self else { return }; self.paused = true; self.stop()
                GenieLog.write("wake", "paused (screen locked or asleep)") }
        }
        let resume: (Notification) -> Void = { [weak self] _ in
            Task { @MainActor in guard let self, self.paused else { return }; self.paused = false; self.start() }
        }
        observers.append(workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main, using: pause))
        observers.append(workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main, using: resume))
        observers.append(distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main, using: pause))
        observers.append(distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main, using: resume))
    }

    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey); newValue ? start() : stop() }
    }

    /// 待ち受けを始める（検出器があり、有効で、マイクの許可があるときだけ）。
    func start() {
        guard !CommandLine.arguments.contains("--selftest"), enabled else { return }
        observeLockAndSleep()
        guard !paused else { return }
        guard let detector = detector ?? Self.loadDetector() else {
            GenieLog.write("wake", "off: no on-device wake-word model yet")
            return
        }
        self.detector = detector
        guard Permissions.microphone == .granted else {
            GenieLog.write("wake", "off: microphone permission"); return
        }
        do {
            try hub.startStandby(detector: detector) { [weak self] in self?.woke(simulated: false) }
            GenieLog.write("wake", "standby (on-device model)")
        } catch {
            GenieLog.write("wake", "could not open the microphone: \(error)")
        }
    }

    func stop() { hub.stopStandby() }

    /// メニューの「呼びかけを試す」: 検出したことにして、会話への引き継ぎを確かめる。
    func simulateWake() {
        clearBillingFailure()   // 本人が試す = もう一度つないでよい
        hub.simulateWake()
        woke(simulated: true)
    }

    private func woke(simulated: Bool) {
        let hud = VoiceHUDState.shared
        GenieLog.write("wake", simulated ? "simulated" : "detected (on-device model)")
        guard !hud.conversation.isActive else { return }
        if let reason = billingBlocked, !simulated {
            // 支払いで断られたまま。つながず（声も送らず）、理由だけ出して待機へ戻る。
            hub.detach()
            WindowCoordinator.shared.showVoiceHUD()
            hud.showAnswer(reason)
            GenieLog.write("wake", "not connecting: Gemini billing failed earlier")
            return
        }
        // 呼びかけの音が無い（試し）なら、Gemini に挨拶を促す。音があれば Gemini が聞いて応える。
        hud.beginConversation(greet: simulated)
        startedByWake = !simulated
        // 「ジーニー」だけで止まったなら、Gemini に挨拶を促す（名前だけでは Gemini は返事をしなかった。genie.log 2026-10-05）。
        // 続けて話しているなら促さない（「ジーニー、〇〇して」は Gemini がそのまま答える）。
        if !simulated, hud.conversation.isActive {
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.continuationWindow * 1_000_000_000))
                guard let self, hud.conversation.isActive, let gemini = hud.conversationProvider as? GeminiLiveProvider else { return }
                let (speech, observed) = self.hub.speechSinceWake()
                if speech < Self.continuationSpeech {
                    GenieLog.write("wake", String(format: "name only (speech %.2f s of %.2f s) — prompting a greeting", speech, observed))
                    gemini.greetSoon()
                } else {
                    GenieLog.write("wake", String(format: "continued speaking (%.2f s) — no greeting", speech))
                }
            }
        }
        wokeAt = Date()
        // 始められなかった（Gemini Live が使えない等）。預かった声は送らずに捨て、待機へ戻る。
        if !hud.conversation.isActive { hub.detach() }
    }

    /// 端末に置いた呼びかけ専用モデル（`genie_ja.onnx`）。無い・読めなければ待ち受けない。
    static func loadDetector() -> WakeDetector? {
        guard let url = LiveKitWakeDetector.modelURL() else { return nil }
        do { return try LiveKitWakeDetector(modelURL: url) }
        catch { GenieLog.write("wake", "could not load the wake model: \(error)"); return nil }
    }
}
