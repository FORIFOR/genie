import AppKit

/// 「ジーニー」と呼ばれたら、いつもの会話を始める（本人の指示 2026-10-04: 呼びかけは「ジーニー」だけ）。
///
/// 守ること:
///   - **聞き取りは端末の中だけ。**声の入力と同じ取り込み（`RecordingRuntime.beginVoiceListening`）と
///     オンデバイス固定の認識器を使う。待っている間の音声は外へ送らず、保存もしない
///   - 会話を新しく作らない。見つけたら既存の `beginConversation` へ渡すだけ
///   - マイクを二重に開かない。会話・声の入力・会議の録音・読み上げの間は待ち受けない
///   - 自分の読み上げで起動しない。続けて何度も起動しない（間を置く）
///   - 画面のロック中・スリープ中は待ち受けない
@MainActor
final class WakeWordListener {
    static let shared = WakeWordListener()
    static let enabledKey = "genie.wake.enabled"
    /// 起動したあと、次に起動できるまでの間。
    static let cooldown: TimeInterval = 3
    /// 待ち受けできるかを見直す間隔（取りこぼした合図があっても、ここで戻る）。
    static let recheckInterval: TimeInterval = 3

    private let defaults: UserDefaults
    private(set) var listening = false
    private var lastFired = Date.distantPast
    private var timer: Timer?
    private var screenLocked = false
    private var asleep = false
    private var observers: [NSObjectProtocol] = []
    /// 見つけたときにすること（既定はいつもの会話を始める）。検査で差し替える。
    var onWake: () -> Void = {
        WindowCoordinator.shared.showVoiceHUD()
        VoiceHUDState.shared.beginConversation()
    }

    /// 検査用: 認識器が書いた文字を受け取る（本番では使わない・残さない）。
    var onHeard: ((String) -> Void)?

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// 既定はオン（本人が使うと決めた機能）。メニューから切れる。
    var enabled: Bool {
        get { defaults.object(forKey: Self.enabledKey) as? Bool ?? true }
        set {
            defaults.set(newValue, forKey: Self.enabledKey)
            if newValue { evaluate() } else { suspend() }
        }
    }

    func start() {
        // 検査の実行（--selftest）ではマイクを勝手に開かない。検査の音と取り合いになる。
        guard timer == nil, !CommandLine.arguments.contains("--selftest") else { return }
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append(workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.asleep = true; self?.suspend() }
        })
        observers.append(workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.asleep = false }
        })
        let distributed = DistributedNotificationCenter.default()
        observers.append(distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screenLocked = true; self?.suspend() }
        })
        observers.append(distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screenLocked = false }
        })
        timer = Timer.scheduledTimer(withTimeInterval: Self.recheckInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.evaluate() }
        }
        evaluate()
    }

    /// ほかの誰かがマイクを使う前に呼ぶ。待ち受けていればマイクを返す。
    func suspend() {
        guard listening else { return }
        listening = false
        RecordingRuntime.shared.endVoiceListening()
    }

    /// 待ち受けてよいなら始める。だめなら何もしない（次の見直しでまた見る）。
    func evaluate() {
        guard !listening, Self.mayListen(Conditions(
            enabled: enabled,
            microphoneGranted: Permissions.microphone == .granted,
            speechAuthorized: SpeechTranscriber.authorization == .authorized,
            screenLocked: screenLocked, asleep: asleep,
            conversationActive: VoiceHUDState.shared.conversation.isActive,
            micInUse: RecordingRuntime.shared.voiceListening || RecordingWorkspaceState.shared.isRecording,
            speaking: GenieSpeechOutput.shared.owner != nil))
        else { return }
        listening = RecordingRuntime.shared.beginVoiceListening(
            onFirstFrame: {},
            onPartial: { [weak self] text in self?.heard(text, final: false) },
            onFinal: { [weak self] text in self?.heard(text, final: true) })
        // 聞いた中身は残さない。待ち受けを始めたかどうかだけ。
        if listening { NSLog("genie wake: listening") }
    }

    private func heard(_ text: String, final: Bool) {
        onHeard?(text)
        guard listening, Self.containsWakeWord(text, final: final),
              GenieSpeechOutput.shared.owner == nil,
              Date().timeIntervalSince(lastFired) >= Self.cooldown else { return }
        lastFired = Date()
        NSLog("genie wake: detected")
        suspend()
        onWake()
    }

    struct Conditions {
        var enabled: Bool, microphoneGranted: Bool, speechAuthorized: Bool
        var screenLocked: Bool, asleep: Bool
        var conversationActive: Bool, micInUse: Bool, speaking: Bool
    }

    static func mayListen(_ c: Conditions) -> Bool {
        c.enabled && c.microphoneGranted && c.speechAuthorized && !c.screenLocked && !c.asleep
            && !c.conversationActive && !c.micInUse && !c.speaking
    }

    /*
     * 「ジーニー」と呼ばれたか。**認識器が実際に書く形で見る。**
     * 端末内の認識器は、短く呼んだ「ジーニー」を「ジー」「ジニ」「爺」「G」と書くことが多い
     * （2026-10-04 実測: Kyoko の声で「ジーニー」→「ジー」、「ねえ、ジーニー」→「ジニ」）。
     *   - はっきりした形（ジーニー・ジーニ・ジニー・Genie）は、どこに出てもすぐ起こす
     *   - あいまいな形（ジー・ジニ・爺・G）は、**一言だけの発話が終わったとき**にだけ起こす
     *     （「ジーンズ」の途中の「ジー」などで起こさないため）
     */
    static func containsWakeWord(_ text: String, final: Bool = false) -> Bool {
        let folded = text.precomposedStringWithCompatibilityMapping
            .applyingTransform(.hiraganaToKatakana, reverse: false) ?? text
        var compact = folded.uppercased().filter { !$0.isWhitespace && !"、。,.!?！？・「」〜-".contains($0) }
        if ["ジーニー", "ジーニ", "ジニー", "ジーニイ", "GENIE"].contains(where: { compact.contains($0) }) { return true }
        guard final else { return false }
        // 呼びかけの前置き（ねえ・ヘイ・おい）は外して、一言だけかを見る。
        for prefix in ["ネエ", "ネー", "ヘイ", "HEY", "オイ"] where compact.hasPrefix(prefix) {
            compact.removeFirst(prefix.count)
        }
        return ["ジー", "ジニ", "ジイ", "爺", "G", "ジ"].contains(compact)
    }
}
