import Foundation

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
    private let hub: VoiceInputHub
    private(set) var detector: WakeDetector?

    init(hub: VoiceInputHub = .shared) { self.hub = hub }

    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey); newValue ? start() : stop() }
    }

    /// 待ち受けを始める（検出器があり、有効で、マイクの許可があるときだけ）。
    func start() {
        guard !CommandLine.arguments.contains("--selftest"), enabled else { return }
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
        hub.simulateWake()
        woke(simulated: true)
    }

    private func woke(simulated: Bool) {
        let hud = VoiceHUDState.shared
        GenieLog.write("wake", simulated ? "simulated" : "detected (on-device model)")
        guard !hud.conversation.isActive else { return }
        // 呼びかけの音が無い（試し）なら、Gemini に挨拶を促す。音があれば Gemini が聞いて応える。
        hud.beginConversation(greet: simulated)
        // 始められなかった（Gemini Live が使えない等）。預かった声は送らずに捨て、待機へ戻る。
        if !hud.conversation.isActive { hub.detach() }
    }

    /// 端末に置いた呼びかけ専用モデル。まだ無い（学習前）。
    static func loadDetector() -> WakeDetector? { nil }
}
