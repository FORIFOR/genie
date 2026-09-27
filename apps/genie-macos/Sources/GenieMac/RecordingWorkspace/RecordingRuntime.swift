import Foundation
import GenieCore

/// 録音の実行時。マイク → genie-core(RecordingSession) → ディスク断片。
/// SwiftUI から直接触らず、State/Bridge 経由で使う。
@MainActor
final class RecordingRuntime {
    static let shared = RecordingRuntime()

    private var session: RecordingSession?
    /// §12 声が乗っている間だけ STT へ流す門番。
    private var vad = VoiceActivityDetector()
    /// §12 partial が UI に出るまでの実測（最後の 1 件、ミリ秒）。
    private(set) var lastPartialLatencyMs: Double = 0
    private var speechStartedAt: Date?
    /// §19 いま STT に流している音がどちらから来たか。混合波では失われる情報。
    private(set) var currentChannel: SpeakerChannel = .localUser
    /// 直近の文字起こしがどちらの声だったか（UI の話者名に使う）。
    private(set) var lastTranscriptChannel: SpeakerChannel = .localUser

    /// **実際に音が届いている経路。** 意図ではなく実測を持つ。
    ///
    /// 画面収録の許可が無いと system audio は黙って落ちて mic だけになる。
    /// 「相手の声も拾っているつもり」で拾えていない状態が、画面から分からなかった。
    @Published private(set) var listening: Set<SpeakerChannel> = []

    /// 音が 1 フレーム届いたことを記録する。音声の callback と検査の両方から呼ぶ。
    /// 検査だけ別経路にすると、検査が本番と違う姿を測ることになる。
    func markListening(_ ch: SpeakerChannel) {
        guard !listening.contains(ch) else { return }
        // 既に main なら**その場で**入れる。async に回すと、検査が撮る頃には
        // まだ反映されておらず「音が届いていません」の姿を撮ってしまう。
        if Thread.isMainThread { listening.insert(ch) }
        else { DispatchQueue.main.async { self.listening.insert(ch) } }
    }
    /// 録音を始める瞬間に「届いている経路」を空にする。前の録音で届いていた事実は、
    /// 次の録音の証拠にならない（以前は消えず、2 回目から最初の 1 フレーム前に
    /// 「聞いています」と名乗っていた）。検査もここを通る（`shots` 09）。
    func resetListening() {
        if Thread.isMainThread { listening = [] }
        else { DispatchQueue.main.async { self.listening = [] } }
    }
    /// §17 固定画面用: 「この Mac ではオンデバイス文字起こしを使えません」の姿を作る。
    /// 本番はオンデバイス STT の起動失敗だけがここを立てる（`begin`）。
    func setTranscriptionUnavailableForShot(_ on: Bool) { transcriptionUnavailable = on }
    /// マイクは 1 台を使い回す（録音のたびに新しい engine を作ると起動が 200〜770ms かかる）。
    /// start / stop はこの直列 queue でだけ触る（主スレッドを止めない・同時に触らない）。
    private let micCapture = MicCapture()
    private let micQueue = DispatchQueue(label: "astra.mic", qos: .userInitiated)
    private var micActive = false
    private var micGeneration = 0
    private var sysAudio: AnyObject?
    private var speech: SpeechTranscriber?
    private var remoteSpeech: SpeechTranscriber?
    private var googleMic: GoogleLiveTranscriber?
    private var googleRemote: GoogleLiveTranscriber?
    private(set) var liveTranscriptionFailure: String?
    var transcriptionFailureMessage: String { liveTranscriptionFailure ?? Facts.transcriptionOnDeviceUnavailable }

    func retryLiveTranscription() {
        guard session != nil, cloudRequestedForRecording, Self.cloudTranscriptionAllowed else { return }
        googleMic?.cancel(); googleRemote?.cancel()
        googleMic = nil; googleRemote = nil
        liveTranscriptionFailure = nil; transcriptionUnavailable = false
        startGoogleLive()
        if paused { googleMic?.setPaused(true); googleRemote?.setPaused(true) }
    }

    private func startGoogleLive() {
        guard let base = apiBase, let token = accessToken else {
            liveTranscriptionFailure = "Googleのライブ文字起こしに接続されていません。Genie Homeを開いて接続を確認してください。"
            transcriptionUnavailable = true
            return
        }
        func make(_ channel: SpeakerChannel) -> GoogleLiveTranscriber? {
            let client = GoogleLiveTranscriber(base: base, token: token)
            client.onTranscript = { [weak self] text, final in
                guard let self else { return }
                self.lastTranscriptChannel = channel
                self.onTranscript?(text, final)
            }
            client.onFailure = { [weak self] message in
                self?.liveTranscriptionFailure = message
                self?.transcriptionUnavailable = true
            }
            do { try client.start(); return client }
            catch {
                liveTranscriptionFailure = "Googleのライブ文字起こしを開始できません。接続と送信設定を確認してください。"
                transcriptionUnavailable = true
                return nil
            }
        }
        googleMic = make(.localUser)
        if systemAudioWanted { googleRemote = make(.remoteAudio) }
    }
    private var remoteVad = VoiceActivityDetector()
    private var systemAudioWanted = false
    private var audioGeneration = 0
    private var audioBuffer = RecordingAudioBuffer()
    private var mixTimer: Timer?
    private var mixClock: TimeInterval?
    private var mixedFrames = 0
    private(set) var systemAudioFrames = 0
    private(set) var systemAudioPeak: Float = 0
    var onSystemAudioFailure: (() -> Void)?
    /// Listening（声で頼む）の取り込み。録音とは別で、ディスクには残さない。
    private var voiceSpeech: SpeechTranscriber?
    private var onVoicePartial: ((String) -> Void)?
    private var onVoiceFinal: ((String) -> Void)?
    private var voiceVad = VoiceActivityDetector()
    private(set) var voiceListening = false
    /// 検査専用: 次の 1 回の聞き取りで、マイクの代わりに流す音（16 kHz mono）。本番では nil。
    /// 流した音は本物のマイクの音と同じ道（VAD → オンデバイス STT）を通る。
    var voiceInjection: [Float]?
    /// オンデバイス STT を始められなかったか（取り込みは続くが文字は出ない）。画面と検査が読む。
    private(set) var voiceTranscriptionUnavailable = false

    private func startVoiceSpeechTranscriber() {
        guard SpeechTranscriber.authorization == .authorized, voiceSpeech == nil else { return }
        // 音声指示（Voice HUD）では、息継ぎや思考の間のポーズ（1〜1.5秒程度）で途中で途切れて誤送信されないよう、
        // 会議録音用の 0.9 秒より余裕を持った 2.2 秒の無音判定を適用する。
        let st = SpeechTranscriber(utteranceGap: 2.2)
        do {
            try st.start { [weak self] live in
                DispatchQueue.main.async {
                    guard let self, self.voiceListening else { return }
                    if live.isFinal {
                        self.onVoiceFinal?(live.text)
                    } else {
                        self.onVoicePartial?(live.text)
                    }
                }
            }
            voiceSpeech = st
        } catch {
            // オンデバイス資産が無い。取り込みは続けるが文字は出ない（サーバへは落とさない）。
            NSLog("voice listening: on-device STT unavailable: \(error)")
            voiceTranscriptionUnavailable = true
        }
    }
    /// 文字起こしを頼まれたのに、この Mac ではオンデバイス STT が始められなかった。
    /// **録音は続いている。**サーバへは落とさない（`SpeechTranscriber` 冒頭）。画面はこれを見て
    /// 「文字起こしが出ない理由」を言う。黙って空のまま「聞いています」と出さない。
    private(set) var transcriptionUnavailable = false
    private var paused = false
    /// 途中経過/確定の文字起こしを UI へ渡す（オンデバイス STT）。
    var onTranscript: ((String, Bool) -> Void)?
    /// この録音で文字起こしを頼まれているか（許可の答えが遅れて来たときに始めるため）。
    private var speechWanted = false
    /// 診断: 確定した発話の数 / 受け取った partial の数（REAL_MEETING の result.json）。録音中だけ意味を持つ。
    var sttFinals: Int { (googleMic?.finals ?? 0) + (googleRemote?.finals ?? 0) + (speech?.finalsEmitted ?? 0) + (remoteSpeech?.finalsEmitted ?? 0) }
    var sttPartials: Int { (googleMic?.partials ?? 0) + (googleRemote?.partials ?? 0) + (speech?.partialsSeen ?? 0) + (remoteSpeech?.partialsSeen ?? 0) }

    /// オンデバイス STT を始める。録音の開始時、または音声認識の許可が下りた瞬間に呼ぶ。
    private func startSpeech() {
        guard !cloudRequestedForRecording, speech == nil, session != nil else { return }
        let st = SpeechTranscriber()
        st.onFailure = { [weak self] _ in self?.transcriptionUnavailable = true }
        do {
            try st.start { [weak self] live in
                // §12 partial は final を待たずに UI へ。出るまでの時間を実測しておく。
                let started = self?.speechStartedAt
                let channel = SpeakerChannel.localUser
                let deliver = {
                    if let started { self?.lastPartialLatencyMs = Date().timeIntervalSince(started) * 1000 }
                    self?.lastTranscriptChannel = channel
                    self?.onTranscript?(live.text, live.isFinal)
                    // Dock が listening のときは、そこにも途中経過を出す。
                    if !live.isFinal { VoiceHUDState.shared.updatePartial(live.text) }
                }
                if Thread.isMainThread { deliver() } else { DispatchQueue.main.async(execute: deliver) }
            }
            self.speech = st
            if systemAudioWanted {
                let remote = SpeechTranscriber()
                remote.onFailure = { [weak self] _ in self?.transcriptionUnavailable = true }
                try remote.start { [weak self] live in
                    let deliver = {
                        self?.lastTranscriptChannel = .remoteAudio
                        self?.onTranscript?(live.text, live.isFinal)
                    }
                    if Thread.isMainThread { deliver() } else { DispatchQueue.main.async(execute: deliver) }
                }
                remoteSpeech = remote
            }
        } catch {
            // オンデバイス資産が無い / 認識器が無い。録音だけ続け、画面に理由を出す。
            // ここで `requiresOnDeviceRecognition = false` にして取り直すことはしない。
            transcriptionUnavailable = true
            NSLog("on-device STT unavailable (recording continues, no server fallback): \(error)")
        }
    }

    /// 音声認識の許可の答えが来た（会議または Voice HUD の許可要求の完了）。
    /// 文字起こしを頼まれていて、まだ始まっていなければ、ここから始める。
    func speechAuthorizationChanged() {
        if !cloudRequestedForRecording, speechWanted, speech == nil, SpeechTranscriber.authorization == .authorized {
            startSpeech()
        }
        if voiceListening, voiceSpeech == nil, SpeechTranscriber.authorization == .authorized {
            startVoiceSpeechTranscriber()
        }
    }
    /// マイクの音量（0..1）を UI（波形）へ渡す。
    var onLevel: ((Float) -> Void)?
    /// 実 gateway に作った会議（サインイン時のみ）。無ければローカル録音だけ。
    private var meetingId: String?
    /// 実際に journal を作った id（サインイン時は gateway id、そうでなければローカル id）。
    private(set) var activeMeetingId: String = "adhoc"
    private var apiBase: String?
    private var accessToken: String?
    private(set) var cloudTranscriptionFailure: String?
    private(set) var cloudPendingIds: Set<String> = []
    private var cloudRequestedForRecording = false

    /// 録音を gateway へ**自動で**送ってよいか。既定 OFF、dev 専用。
    ///
    /// gateway が到達可能なだけで会議を作り、停止時に音声全体を送っていた（`docs/privacy-egress.md`）。
    /// 「確認して実行したものだけが外に出ます」と食い違う。release ビルドでは env に関わらず false
    /// （`#if DEBUG` の外に道が無い）。dev で E2E を回すときだけ `ASTRA_DEV_AUTO_UPLOAD=1`。
    /// selftest は `configureBackend` を自分で呼ぶので、この旗は本番の自動配線だけを止める。
    static var devAutoUploadEnabled: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["ASTRA_DEV_AUTO_UPLOAD"] == "1"
        #else
        return false
        #endif
    }

    /// 明示的に許可されたときだけ、録音音声を Gateway へ送り Google STT の
    /// ライブ文字起こしを表示する。オフのときだけ端末内 Speech を使う。
    ///
    /// UserDefaults の既定値は OFF。テスト用の dev upload は従来どおり有効にする。
    static let cloudTranscriptionDefaultsKey = "astra.transcription.cloudGoogleSTT"
    static func cloudConsentValue(_ stored: Any?, developmentUpload: Bool) -> Bool {
        stored as? Bool ?? developmentUpload
    }
    static var cloudTranscriptionAllowed: Bool {
        cloudConsentValue(UserDefaults.standard.object(forKey: cloudTranscriptionDefaultsKey),
                          developmentUpload: devAutoUploadEnabled)
    }
    static func setCloudTranscriptionAllowed(_ allowed: Bool) {
        if CommandLine.arguments.contains("--selftest") {
            // A test may be killed before cleanup. Its choices must never persist
            // over the user's consent, including a launch-time NO override.
            var arguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
            arguments[cloudTranscriptionDefaultsKey] = allowed
            UserDefaults.standard.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain)
        } else {
            UserDefaults.standard.set(allowed, forKey: cloudTranscriptionDefaultsKey)
        }
    }

    /// サインイン済みなら、実バックエンドの会議 id を使って録音する。
    func configureBackend(base: String, accessToken: String) {
        self.apiBase = base
        self.accessToken = accessToken
    }

    /// 保存先（Application Support/Genie/meetings）。core の既定と同じ。
    /// 置き場所は `LocalStore.dataRoot` に合わせる（DB と録音が別の場所へ行くと、
    /// 初回起動の検証で片方だけまっさらになる）。
    private var root: String {
        LocalStore.dataRoot.appendingPathComponent("meetings").path
    }

    /// core にセッションを作り、（可能なら）マイクを開く。live 取り込みは .app + 許可が要る。
    @discardableResult
    func begin(meetingId localId: String, captureMic: Bool = true,
               captureSystemAudio: Bool = false, transcribe: Bool = true) -> Bool {
        try? FileManager.default.createDirectory(
            atPath: root, withIntermediateDirectories: true)
        // サインイン済みなら実 gateway に会議を作り、その id で録音する（Tauri を介さない）
        cloudRequestedForRecording = Self.cloudTranscriptionAllowed
        cloudTranscriptionFailure = nil
        liveTranscriptionFailure = nil
        var id = localId
        if Self.devAutoUploadEnabled, let base = apiBase, let token = accessToken,
           let created = try? GenieCoreBridge.createMeeting(base, accessToken: token, title: "会議", language: "ja-JP") {
            id = created
            self.meetingId = created
        }
        guard let session = try? RecordingSession.start(root: root, meetingId: id) else {
            return false
        }
        self.session = session
        audioGeneration += 1
        let generation = audioGeneration
        paused = false
        systemAudioWanted = captureSystemAudio
        systemAudioFrames = 0; systemAudioPeak = 0
        audioBuffer = RecordingAudioBuffer()
        if captureSystemAudio {
            mixClock = ProcessInfo.processInfo.systemUptime; mixedFrames = 0
            mixTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
                self?.drainMixedAudio()
            }
        }
        self.activeMeetingId = id
        transcriptionUnavailable = false
        resetListening()
        speechWanted = transcribe
        if transcribe, cloudRequestedForRecording { startGoogleLive() }
        else if transcribe, SpeechTranscriber.authorization == .authorized { startSpeech() }
        // 未確認なら、許可の答えが来てから始める（`speechAuthorizationChanged`）。以前は答えを待たず
        // 「認可済みのときだけ」で、初回は**誰も音声認識を求めていなかった**ので、文字起こしが一度も
        // 動かなかった（REAL_MEETING の実マイク経路で 0 行。音は 45 秒届いていた）。
        if captureMic {
            let mic = micCapture
            // AVAudioEngine の起動を主スレッドで待つと、⌥Space から Dock が動くまでがそのぶん遅れる
            // （実測 170〜520ms、基準 <100ms）。画面は先に変わり、マイクは裏で開く。
            // 開くまでの数十 ms は「まだ音が届いていません」が出る（それが本当の姿）。
            micGeneration += 1
            let gen = micGeneration
            micActive = true
            micQueue.async { [weak self] in
                do {
                    try mic.start { frame in
                        DispatchQueue.main.async {
                            self?.receiveAudio(frame, channel: .localUser, generation: generation)
                        }
                    }
                } catch {
                    // マイクが開けなくてもセッションは成り立たせる（サンプルは外から push できる）
                    NSLog("mic capture unavailable: \(error)")
                }
                // 開いている間に end() が来ていたら、いま止める（開きっぱなしにしない）。
                DispatchQueue.main.async { [weak self] in
                    guard let self else { mic.stop(); return }
                    // 止めるのは、この開始がまだ最新で、もう要らないときだけ。世代が進んでいれば、
                    // 進めた側（end の stop → 次の start）が同じ列に並んでいる。ここで止めると次の取り込みを殺す。
                    if self.micGeneration == gen, !self.micActive { self.micQueue.async { mic.stop() } }
                }
            }
        }
        if captureSystemAudio, #available(macOS 13.0, *) {
            let sys = SystemAudioCapture()
            self.sysAudio = sys
            Task { [weak self] in
                guard self?.audioGeneration == generation else { return }
                do {
                    try await sys.start { [weak self] frame in
                        DispatchQueue.main.async {
                            self?.receiveAudio(frame, channel: .remoteAudio, generation: generation)
                        }
                    }
                    if self?.audioGeneration != generation { await sys.stop() }
                } catch {
                    // 画面収録許可が無ければ system audio 無しで続ける（mic だけで成り立つ）
                    NSLog("system audio capture unavailable: \(error)")
                    if self?.audioGeneration == generation { self?.onSystemAudioFailure?() }
                }
            }
        }
        return true
    }

    private func receiveAudio(_ frame: [Float], channel: SpeakerChannel, generation: Int) {
        guard generation == audioGeneration, session != nil, !paused else { return }
        markListening(channel)
        let peak = frame.reduce(Float(0)) { max($0, abs($1)) }
        if channel == .remoteAudio {
            systemAudioFrames += frame.count
            systemAudioPeak = max(systemAudioPeak, peak)
        }
        onLevel?(min(1, peak * 1.6))
        if channel == .localUser { VoiceHUDState.shared.receiveInputLevel(min(1, peak * 1.6)) }
        if systemAudioWanted { audioBuffer.append(frame, channel: channel) }
        else { _ = session?.pushSamples(samples: frame, sampleRate: 16_000) }
        currentChannel = channel
        if channel == .localUser { googleMic?.append(frame) }
        else { googleRemote?.append(frame) }
        if channel == .localUser, vad.accept(frame) {
            if speechStartedAt == nil { speechStartedAt = Date() }
            speech?.append(frame, sampleRate: 16_000)
        } else if channel == .remoteAudio, remoteVad.accept(frame) {
            remoteSpeech?.append(frame, sampleRate: 16_000)
        }
    }

    private func drainMixedAudio() {
        guard systemAudioWanted, !paused, let clock = mixClock else { return }
        let due = max(0, Int(max(0, ProcessInfo.processInfo.systemUptime - clock) * 16_000) - mixedFrames)
        guard due > 0 else { return }
        // Drain in bounded chunks even if the main run loop was delayed.
        var remaining = due
        while remaining > 0 {
            let count = min(remaining, 16_000)
            _ = session?.pushSamples(samples: audioBuffer.take(count), sampleRate: 16_000)
            remaining -= count
        }
        mixedFrames += due
    }

    /// テスト・外部音源用に直接サンプルを流す（headless E2E で使う）。
    func push(_ samples: [Float], sampleRate: UInt32) {
        guard !paused else { return }
        _ = session?.pushSamples(samples: samples, sampleRate: sampleRate)
        if sampleRate == 16_000 { googleMic?.append(samples) }
    }

    func snapshot() -> RecordingSnapshot? { session?.snapshot() }
    func recordedMs() -> UInt64 { session?.recordedMs() ?? 0 }

    /// マイク engine を先に用意する（⌥Space → 音が届くまでを短くする）。
    /// **許可済みのときだけ**。未確認なら何もしない（求めるのは録音を始める瞬間、§26）。
    func prewarmMic() {
        guard Permissions.microphone == .granted else { return }
        micQueue.async { [micCapture] in micCapture.prewarm() }
    }

    // MARK: - 声で頼む（Listening）

    /// Listening の取り込み。**会議の録音とは別物**で、`RecordingSession` を作らない
    /// ＝ディスクに音声を残さない（声の指示は保存しない）。文字起こしは
    /// `SpeechTranscriber`（オンデバイス固定）だけを通り、外へは出ない。
    ///
    /// 「聞いています」と名乗ってよいのは**最初の 1 フレームが届いてから**なので、
    /// `onFirstFrame` を返す。返り値 false は「始められなかった」（録音中・許可なし）。
    @discardableResult
    func beginVoiceListening(echoCancellation: Bool = false,
                             onFirstFrame: @escaping () -> Void,
                             onPartial: @escaping (String) -> Void,
                             onFinal: @escaping (String) -> Void) -> Bool {
        // 会議の録音中はマイクを二重に開かない。その間の partial は録音側の STT から流れる。
        guard session == nil, !voiceListening else { return false }
        let injected = voiceInjection
        voiceInjection = nil
        guard injected != nil || Permissions.microphone == .granted else { return false }
        voiceListening = true
        voiceTranscriptionUnavailable = false
        voiceVad.reset()
        onVoicePartial = onPartial
        onVoiceFinal = onFinal
        var sawFirst = false

        if SpeechTranscriber.authorization == .authorized {
            startVoiceSpeechTranscriber()
        } else if SpeechTranscriber.authorization == .notDetermined {
            SpeechTranscriber.requestAuthorization { [weak self] ok in
                DispatchQueue.main.async {
                    guard let self, self.voiceListening, ok else { return }
                    self.startVoiceSpeechTranscriber()
                }
            }
        }

        let mic = micCapture
        micGeneration += 1
        let gen = micGeneration
        if let injected {
            // 検査: マイクの代わりに、実時間で 0.1 秒ずつ流す（最後に 4 秒の無音）。
            let chunk = 1_600
            let frames = injected + [Float](repeating: 0, count: 64_000)
            micQueue.async { [weak self] in
                var offset = 0
                while offset < frames.count {
                    guard let self, self.voiceListening, self.micGeneration == gen else { return }
                    let frame = Array(frames[offset..<min(offset + chunk, frames.count)])
                    if offset == 0 { DispatchQueue.main.async { onFirstFrame() } }
                    if self.voiceVad.accept(frame) { self.voiceSpeech?.append(frame, sampleRate: 16_000) }
                    offset += chunk
                    Thread.sleep(forTimeInterval: 0.1)
                }
            }
            return true
        }
        micQueue.async { [weak self] in
            do {
                try mic.start(echoCancellation: echoCancellation) { frame in
                    guard let self, self.voiceListening else { return }
                    let first = !sawFirst
                    sawFirst = true
                    let level = min(1, frame.reduce(Float(0)) { max($0, abs($1)) } * 1.6)
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.voiceListening, self.micGeneration == gen else { return }
                        if first { onFirstFrame() }
                        VoiceHUDState.shared.receiveInputLevel(level)
                    }
                    if self.voiceVad.accept(frame) { self.voiceSpeech?.append(frame, sampleRate: 16_000) }
                }
            } catch {
                NSLog("voice listening: mic unavailable: \(error)")
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { mic.stop(); return }
                // 上の録音側と同じ: 世代が進んでいたら止めない（素早く閉じて開き直すと、新しい取り込みを殺していた）。
                if self.micGeneration == gen, !self.voiceListening { self.micQueue.async { mic.stop() } }
            }
        }
        return true
    }

    /// 直近の声の取り込みでエコー除去が効いたか（測定・表示用）。
    var voiceEchoCancellationActive: Bool { micCapture.voiceProcessingActive }

    /// Listening をやめる。マイクは閉じる（開いたままにしない）。
    func endVoiceListening() {
        guard voiceListening else { return }
        voiceListening = false
        onVoicePartial = nil
        onVoiceFinal = nil
        voiceSpeech?.finish(); voiceSpeech = nil
        voiceVad.reset()
        micQueue.async { [micCapture] in micCapture.stop(); micCapture.prewarm() }
    }
    func setPaused(_ paused: Bool) {
        if paused { drainMixedAudio() }
        self.paused = paused
        session?.setPaused(paused: paused)
        googleMic?.setPaused(paused); googleRemote?.setPaused(paused)
        if paused {
            speech?.pause()
            remoteSpeech?.pause()
        } else {
            do {
                try speech?.resume()
                try remoteSpeech?.resume()
            } catch {
                transcriptionUnavailable = true
                NSLog("on-device STT resume unavailable: \(error)")
            }
        }
        audioBuffer = RecordingAudioBuffer()
        mixClock = ProcessInfo.processInfo.systemUptime; mixedFrames = 0
        vad.reset(); remoteVad.reset()
    }

    /// 停止して確定。書けた断片は残り、回復候補になる。
    func end(cloudCompletion: ((String, String?) -> Void)? = nil, completion: (() -> Void)? = nil) {
        drainMixedAudio()
        mixTimer?.invalidate(); mixTimer = nil; mixClock = nil
        audioGeneration += 1
        vad.reset()
        remoteVad.reset()
        speechStartedAt = nil
        if micActive {
            micActive = false
            // 止めたあと次の録音のために資源だけ確保し直す（IO は始めない）。
            micQueue.async { [micCapture] in micCapture.stop(); micCapture.prewarm() }
        }
        let transcribers = [speech, remoteSpeech].compactMap { $0 }
        transcriptionUnavailable = false
        if #available(macOS 13.0, *), let sys = sysAudio as? SystemAudioCapture {
            Task { await sys.stop() }
        }
        sysAudio = nil
        let finishSession = { [self] in
            speech = nil
            remoteSpeech = nil
            try? session?.finish()
            session = nil
            let id = activeMeetingId
            meetingId = nil
            // Live results already went through onTranscript and the local transcript store.
            // Do not submit recording audio for a second, post-meeting recognition pass.
            completion?()

        }
        let liveClients = [googleMic, googleRemote].compactMap { $0 }
        googleMic = nil; googleRemote = nil
        if !liveClients.isEmpty {
            Task {
                for client in liveClients { await client.finish() }
                finishSession()
            }
        } else if completion != nil, !transcribers.isEmpty {
            var remaining = transcribers.count
            for transcriber in transcribers {
                transcriber.finishAsync {
                    remaining -= 1
                    if remaining == 0 { finishSession() }
                }
            }
        } else {
            for transcriber in transcribers { transcriber.finish() }
            finishSession()
        }
    }

    func retryCloudTranscription(id: String, completion: @escaping (String?) -> Void) {
        guard !cloudPendingIds.contains(id), session == nil || activeMeetingId != id else { return }
        cloudPendingIds.insert(id)
        CloudMeetingTranscription.setPending(true, id: id)
        Task {
            var failure: String?
            do {
                guard Self.cloudTranscriptionAllowed, let base = apiBase, let token = accessToken else {
                    throw CloudMeetingTranscription.Failure(message: "設定でクラウド文字起こしをオンにし、サーバーへの接続を確認してください。")
                }
                try await CloudMeetingTranscription.finalize(base: base, token: token, localId: id, root: root)
            } catch { failure = error.localizedDescription }
            CloudMeetingTranscription.saveFailure(failure, id: id)
            CloudMeetingTranscription.setPending(false, id: id)
            cloudPendingIds.remove(id)
            completion(failure)
        }
    }

    /// 録りかけを 1 件捨てる。**音は消える。戻せない。**
    ///
    /// 送り先が無いと `recover` は何もできないので、捨てる道が無いと
    /// 「録りかけが N 件あります」を永久に見続けることになる（実測で 150 件まで
    /// 溜まった）。消せないお知らせは、ただの雑音になる。
    @discardableResult
    func discard(meetingId id: String) -> Bool {
        // 走っている録音は消さない。
        //
        // 判定は**開いている journal**で見る。`meetingId` はサインインしている
        // ときしか入らず、`end()` で nil に戻るので、これだけでは録音中を
        // 取りこぼす（実際、録音中のものを消せてしまった）。
        guard !(session != nil && id == activeMeetingId) else { return false }
        guard id != meetingId else { return false }
        let dir = root + "/" + id
        // 置き場の外を消さない（id に .. などが混ざっても root の下に留める）。
        guard URL(fileURLWithPath: dir).standardizedFileURL.path.hasPrefix(
                URL(fileURLWithPath: root).standardizedFileURL.path + "/") else { return false }
        do { try FileManager.default.removeItem(atPath: dir); return true } catch { return false }
    }

    /// 前回落ちたまま残っている録音（未アップロードの断片）。起動時に surface する。
    /// 落ちたまま残っている録音。**正常に終わったものは含めない。**
    ///
    /// journal は送り終えるまで残るので、サインインしていない機械では
    /// 普通に停止した会議まで候補に入っていた。Home が
    /// 「保存し切る前に終わった録音です」と言うが、それは嘘になる。
    /// 手元で ready / processing まで進んだ会議は、落ちていない。
    func recoverableMeetings() -> [RecoverableMeeting] {
        let finished = Set(MeetingSessionStore.shared.sessions
            .filter { $0.status == .ready || $0.status == .processing }
            .map { $0.id })
        return GenieCoreBridge.recoverable(root: root, active: nil)
            .filter { !finished.contains($0.meetingId) }
    }

    /// クラッシュした録音を復旧する: その会議の断片を gateway に送って finalize する。
    /// サインイン済みでなければ 0（送れない）。送ったバイト数を返す。
    ///
    /// **オフライン録音**（サインイン前に録った local id, `meeting-…`）は gateway 会議が無いので、
    /// 新しく会議を作り、journal ディレクトリをその id にリネームしてから送る（でないと永久に候補に残る）。
    @discardableResult
    func recover(meetingId id: String) -> UInt64 {
        guard Self.cloudTranscriptionAllowed, let base = apiBase, let token = accessToken else { return 0 }
        var uploadId = id
        if id.hasPrefix("meeting-") {   // オフライン録音 → 新しい gateway 会議を作って紐付ける
            guard let created = try? GenieCoreBridge.createMeeting(base, accessToken: token, title: "会議（復旧）", language: "ja-JP") else { return 0 }
            let from = root + "/" + id, to = root + "/" + created
            do { try FileManager.default.moveItem(atPath: from, toPath: to) } catch { return 0 }
            uploadId = created
        }
        let sent = (try? GenieCoreBridge.uploadMeetingAudio(base, accessToken: token, meetingId: uploadId, journalRoot: root)) ?? 0
        guard sent > 0, (try? GenieCoreBridge.finishMeeting(base, accessToken: token, meetingId: uploadId)) != nil else { return 0 }
        if sent > 0 { GenieCoreBridge.markUploaded(root: root, meetingId: uploadId) }  // 二重回復を防ぐ
        return sent
    }
}
