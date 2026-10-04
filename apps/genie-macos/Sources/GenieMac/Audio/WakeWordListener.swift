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
        // 秘書のように、まず声で返事をしてから聞く（本人の指示 2026-10-04）。
        // 読み上げの間はマイクを開かない（自分の声を聞かない）。読み終えてから会話を始める。
        GenieSpeechOutput.shared.read(Facts.wakeAcknowledgement, owner: UUID()) {
            GenieLog.write("wake", "acknowledged; starting the conversation")
            let hud = VoiceHUDState.shared
            hud.beginConversation()
            // 声が出せない時（Gemini のクレジット切れ等）も返事が分かるよう、聞いている面に文字でも出す
            // （最初の言葉で置き換わる）。
            if hud.conversation.isActive, case .listening = hud.mode { hud.mode = .listening(partial: Facts.wakeAcknowledgement) }
        }
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
        GenieLog.write("wake", "listener started (enabled: \(enabled))")
        // 呼びかけへの返事の声を先に作っておく（呼んだ時に待たせない）。
        GenieSpeechOutput.shared.prepare(Facts.wakeAcknowledgement)
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
        // 会話がどう終わったかを控える（呼んだのに続かないときの調べ）。
        _ = GenieEventBus.shared.subscribe { [weak self] event in
            guard case .voiceSessionEnded(let reason) = event else { return }
            Task { @MainActor in
                let by = reason == "replaced" ? " by \(VoiceHUDState.shared.lastConversationReplacedBy)" : ""
                self?.lastConversationEnd = "\(ISO8601DateFormatter().string(from: Date())) \(reason)\(by)"
                self?.writeStatus()
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: Self.recheckInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.evaluate() }
        }
        evaluate()
    }

    /// ほかの誰かがマイクを使う前に呼ぶ。待ち受けていればマイクを返す。
    func suspend() {
        settleTimer?.cancel(); settleTimer = nil
        guard listening else { return }
        listening = false
        // 呼びかけの後ろの言葉は要らない。末尾を待たずにすぐ閉じる（待つと返事が遅れる）。
        RecordingRuntime.shared.endVoiceListening(waitForTail: false)
    }

    /// 待ち受けてよいなら始める。だめなら何もしない（次の見直しでまた見る）。
    func evaluate() {
        // ほかの所がマイクを閉じた（声の入力を終えた等）と、こちらは聞いているつもりのまま
        // 二度と始め直さなかった。実際の状態に合わせる。
        if listening, !RecordingRuntime.shared.voiceListening { listening = false }
        defer { writeStatus() }
        guard !listening, Self.mayListen(conditions) else { return }
        listening = RecordingRuntime.shared.beginVoiceListening(
            onFirstFrame: { [weak self] in self?.framesStarted = true },
            onPartial: { [weak self] text in self?.heard(text, final: false) },
            onFinal: { [weak self] text in self?.heard(text, final: true) })
        if listening { framesStarted = false; NSLog("genie wake: listening") }
    }

    private var conditions: Conditions {
        Conditions(
            enabled: enabled,
            microphoneGranted: Permissions.microphone == .granted,
            speechAuthorized: SpeechTranscriber.authorization == .authorized,
            screenLocked: screenLocked, asleep: asleep,
            conversationActive: VoiceHUDState.shared.conversation.isActive,
            micInUse: RecordingRuntime.shared.voiceListening || RecordingWorkspaceState.shared.isRecording,
            speaking: GenieSpeechOutput.shared.owner != nil)
    }

    // 状態の控え（端末の中だけ・本人だけが読める）。待ち受けが動かないときの調べに使う。
    private var framesStarted = false
    private var heardCount = 0
    private var recent: [String] = []
    private var lastConversationEnd = ""
    private var settleTimer: Task<Void, Never>?
    /// 短い呼びかけの途中の文字が、この間変わらなければ話し終えたとみなす。
    static let settle: TimeInterval = 0.6
    private var lastWake = ""
    private func writeStatus() {
        let c = conditions
        let status: [String: Any] = [
            "at": ISO8601DateFormatter().string(from: Date()),
            "listening": listening, "framesStarted": framesStarted,
            "voiceListening": RecordingRuntime.shared.voiceListening,
            "enabled": c.enabled, "microphoneGranted": c.microphoneGranted, "speechAuthorized": c.speechAuthorized,
            "screenLocked": c.screenLocked, "asleep": c.asleep, "conversationActive": c.conversationActive,
            "micInUse": c.micInUse, "speaking": c.speaking,
            "heardCount": heardCount, "recent": recent,
            "lastWake": lastWake, "lastConversationEnd": lastConversationEnd,
        ]
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Genie", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("wake-status.json")
        guard let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func heard(_ text: String, final: Bool) {
        onHeard?(text)
        heardCount += 1
        recent = Array((recent + [String(text.suffix(16)) + (final ? " [確定]" : "")]).suffix(6))
        settleTimer?.cancel(); settleTimer = nil
        // 「ジ」「字」のような短い形は、認識の確定（話し終えて約 2.5 秒）を待つと遅い（実機 2026-10-04）。
        // 途中の文字がその形のまま `settle` 秒変わらなければ、話し終えたとみなして起こす。
        if !final, listening, !Self.containsWakeWord(text, final: false), Self.containsWakeWord(text, final: true) {
            settleTimer = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.settle * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.heard(text, final: true)
            }
            return
        }
        guard listening, Self.containsWakeWord(text, final: final),
              GenieSpeechOutput.shared.owner == nil,
              Date().timeIntervalSince(lastFired) >= Self.cooldown else { return }
        lastFired = Date()
        NSLog("genie wake: detected")
        GenieLog.write("wake", "detected in 「\(GenieLog.clip(text, 20))」")
        lastWake = ISO8601DateFormatter().string(from: Date())
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
        /*
         * 漢字で書かれることもある。実機（2026-10-04、本人の声）では「ジーニー」が「地に」「字」と
         * 書かれ、一度も起きなかった。一言だけの発話に限り、「じ」「に」と読める漢字を仮名に戻す。
         */
        compact = String(compact.map { kanjiAsKana[$0] ?? String($0) }.joined())
        // 呼びかけの前置き（ねえ・ヘイ・おい）は外して、一言だけかを見る。
        for prefix in ["ネエ", "ネー", "ヘイ", "HEY", "オイ"] where compact.hasPrefix(prefix) {
            compact.removeFirst(prefix.count)
        }
        // 続けて 2〜3 回呼ぶこともある（実機 2026-10-04:「字に字に」）。呼びかけだけの繰り返しなら起こす。
        return isCallOnly(compact, remaining: 3)
    }

    private static let looseForms = ["ジイニ", "ジニイ", "ジニー", "ジーニ", "ジー", "ジニ", "ジイ", "G", "ジ"]

    /// 発話全体が、呼びかけの形を 1〜`remaining` 回並べただけか。
    private static func isCallOnly(_ text: String, remaining: Int) -> Bool {
        guard remaining > 0, !text.isEmpty else { return false }
        if looseForms.contains(text) { return true }
        return looseForms.contains { form in
            text.hasPrefix(form) && isCallOnly(String(text.dropFirst(form.count)), remaining: remaining - 1)
        }
    }

    /// 認識器が「じ」「に」の音に当てる漢字（一言だけの発話でだけ使う）。
    private static let kanjiAsKana: [Character: String] = [
        "地": "ジ", "字": "ジ", "自": "ジ", "次": "ジ", "時": "ジ", "児": "ジ", "治": "ジ", "事": "ジ",
        "爺": "ジイ", "二": "ニ", "似": "ニ", "荷": "ニ", "煮": "ニ", "尼": "ニ",
    ]
}
