import AVFoundation

/// 呼びかけを聞き分ける部品（端末の中だけで動く）。16 kHz mono の音を渡し、呼びかけらしさが閾値を超えたら true。
/// 標準の音声認識（文字起こし）は使わない（本人の指示 2026-10-04）。
protocol WakeDetector: AnyObject {
    /// 音声処理の専用の列から、順に 1 回ずつ呼ばれる（並行して呼ばれない）。
    func process(_ frame: [Float]) -> Bool
    func reset()
}

/// Genie のマイクを 1 本にまとめる。
///
/// - 待機中: 音を呼びかけ検出（`WakeDetector`）にだけ渡し、直近 `prerollSeconds` 秒を手元に残す。外へは送らない
/// - 呼びかけを検出: そこからの音をすべて預かる（接続を待つ間に話した言葉を捨てない。上限 `holdLimitSeconds` 秒）
/// - 会話: `attach` した受け手（Gemini Live）へ、預かった音 → 以降の音の順で渡す
///
/// 「待ち受けのマイクを止めてから会話のマイクを開く」切り替えはしない（切り替えの間の言葉が消える）。
final class VoiceInputHub: @unchecked Sendable {
    static let shared = VoiceInputHub()

    static let sampleRate = 16_000.0
    /// 呼びかけを含む発話の頭を落とさないため、検出の前から残しておく長さ。
    static let prerollSeconds = 2.0
    /// 検出から会話の受け手がつながるまで、預かる上限（これを超えた古い音は捨てる）。
    static let holdLimitSeconds = 15.0

    enum State: Equatable { case off, standby, holding, streaming, paused }

    /// nil は実マイクを開かない（検査は `inject` で音を流す）。
    private let mic: MicCapture?
    private let queue = DispatchQueue(label: "genie.voice.hub")
    // 以下は `queue` の上だけで触る。
    private var stateValue: State = .off
    private var ring: [[Float]] = []
    private var ringSamples = 0
    private var held: [[Float]] = []
    private var heldSamples = 0
    private var consumer: (([Float]) -> Void)?
    private var detectorValue: WakeDetector?
    private var onWakeValue: (() -> Void)?
    private var micRunning = false
    /// エコー除去（会話で Genie の声を鳴らしている間だけ。待ち受けの音は変えない）。
    private var echoCancellation = false

    // MARK: - 再生（同じ engine で鳴らす = エコー除去で消える）

    /// このハブで鳴らせるか（実マイクがあるとき。検査では鳴らしたことにできる）。
    var canPlay: Bool { mic != nil || simulatedPlayback }
    /// 検査: 実マイク無しでも本番と同じ全二重で動かす。鳴らす代わりに、声の長さだけ待って終わったことにする。
    var simulatedPlayback = false
    private var simulatedGeneration = 0

    /// エコー除去の切り替え。engine を開き直すので、切り替えの間（0.1〜0.3 秒）の音は落ちる。
    /// だから話し始め（Gemini が答え始めた時）と会話の終わりにだけ切り替える。
    func setEchoCancellation(_ on: Bool) {
        queue.sync {
            guard echoCancellation != on else { return }
            guard !on || Self.echoCancellationAllowed(state: stateValue) else {
                GenieLog.write("voice", "echo cancellation kept off (no conversation: \(stateValue))")
                return
            }
            echoCancellation = on
            guard micRunning, let mic else { return }
            mic.stop()
            micRunning = false
            do {
                try startMicLocked()
            } catch {
                // 閉じたままにしない。見張りが stallSeconds 後に engine を作り直して開き直す
                // （genie.log 2026-10-16 07:27Z、-10875 のあと待ち受けが翌日まで止まった）。
                GenieLog.write("voice", "could not reopen the microphone: \(error)")
                lastFrameAt = Date()
                startWatchdogLocked()
                // エコー除去を切った直後は入力機器が一瞬 0ch に見える。少し待って engine を作り直せば開ける
                // （--selftest wakereturn 2026-10-18: 見張りだけだと毎回 6.5 秒聞こえなかった）。
                queue.asyncAfter(deadline: .now() + Self.quickRetrySeconds) { [weak self] in self?.quickRetryLocked() }
            }
            GenieLog.write("voice", "echo cancellation \(on ? "on" : "off") (active: \(mic.voiceProcessingActive))")
        }
    }

    /// エコー除去を入れてよいか。会話の間だけ。会話が終わってから届いた Gemini の声で入れると、待ち受けまで
    /// 加工した音になり、次の会話の終わりまで戻らなかった（genie.log 2026-10-18 15:12Z・16:00Z・16:28Z）。
    /// 呼びかけの検出器は加工していない音で学習している。
    static func echoCancellationAllowed(state: State) -> Bool {
        state == .holding || state == .streaming || state == .paused
    }

    func play(_ buffer: AVAudioPCMBuffer, completion: @escaping () -> Void) {
        if mic == nil, simulatedPlayback {
            let generation = queue.sync { simulatedGeneration }
            let seconds = Double(buffer.frameLength) / buffer.format.sampleRate
            simulatedUntil = max(simulatedUntil, Date()).addingTimeInterval(seconds)
            let due = simulatedUntil
            DispatchQueue.main.asyncAfter(deadline: .now() + due.timeIntervalSinceNow) { [weak self] in
                guard let self, self.queue.sync(execute: { self.simulatedGeneration }) == generation else { return }
                completion()
            }
            return
        }
        guard let player = mic?.player else { completion(); return }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in completion() }
        if !player.isPlaying { player.play() }
    }

    private var simulatedUntil = Date.distantPast
    func stopPlayback() {
        mic?.player.stop()
        queue.sync { simulatedGeneration += 1 }
        simulatedUntil = .distantPast
    }

    init(mic: MicCapture? = MicCapture()) { self.mic = mic }

    var state: State { queue.sync { stateValue } }

    /// 待ち受けを始める。検出器が無ければ始めない（検出しないマイクは開かない）。
    func startStandby(detector: WakeDetector, onWake: @escaping () -> Void) throws {
        try queue.sync {
            detectorValue = detector
            onWakeValue = onWake
            guard stateValue == .off || stateValue == .standby else { return }
            detector.reset()
            stateValue = .standby
            try startMicLocked()
        }
    }

    /// 検出器を外す（会話中なら会話はそのまま。会話が終わっても待機に戻らない）。
    func stopStandby() {
        queue.sync {
            detectorValue = nil; onWakeValue = nil
            if stateValue == .standby { stateValue = .off; stopMicLocked() }
        }
    }

    /// 検出器の代わりに、呼びかけがあったことにする（試験・メニューの「呼びかけを試す」）。
    func simulateWake() { queue.async { self.wakeLocked() } }

    /// 会話の受け手をつなぐ。預かった音（呼びかけの前後）を先に、以降の音を順に渡す。
    /// 戻り値は先に渡した預かりの長さ（秒）。
    @discardableResult
    func attach(_ receiver: @escaping ([Float]) -> Void) throws -> Double {
        try queue.sync {
            let flushed = Double(heldSamples) / Self.sampleRate
            for frame in held { receiver(frame) }
            held = []; heldSamples = 0
            consumer = receiver
            stateValue = .streaming
            try startMicLocked()
            return flushed
        }
    }

    /// 会話の途中で、受け手への音を止める（Genie が話している間。自分の声を送らない・呼びかけ検出もしない）。
    func pause() {
        queue.sync {
            guard stateValue == .streaming else { return }
            consumer = nil
            stateValue = .paused
        }
    }

    /// 会話の受け手を外す。検出器があれば待機へ戻り、無ければマイクを止める。
    func detach() {
        setEchoCancellation(false)
        queue.sync {
            consumer = nil
            held = []; heldSamples = 0
            ring = []; ringSamples = 0
            if let detector = detectorValue {
                detector.reset()
                stateValue = .standby
            } else {
                stateValue = .off
                stopMicLocked()
            }
        }
    }

    /// 試験用: マイクを通さず音を流す（`MicCapture` の 1 回分のフレームと同じ形）。
    func inject(_ frame: [Float]) { queue.sync { receiveLocked(frame) } }

    // MARK: - queue の上

    private func startMicLocked() throws {
        guard !micRunning else { return }
        guard let mic else { micRunning = true; return }
        try mic.start(echoCancellation: echoCancellation) { [weak self] frame in
            guard let self else { return }
            self.queue.async { self.receiveLocked(frame) }
        }
        micRunning = true
        lastFrameAt = Date()
        startWatchdogLocked()
    }

    // MARK: 音が届かなくなったマイクを開き直す

    /// 開いているマイクから、これだけの間 1 フレームも来なければ止まったとみなす（tap は無音でも届き続ける）。
    static let stallSeconds = 4.0
    /// 開き直しに失敗したら、次に試すまでの間。
    static let stallRetrySeconds = 30.0
    private var lastFrameAt = Date()
    private var watchdog: DispatchSourceTimer?

    /// マイクが止まったか。開き直しに失敗して閉じたまま（running: false）の待ち受け・会話も含む。
    /// Genie が話している間（paused）は開き直さない（再生まで止めてしまう）。
    static func micStalled(state: State, running: Bool, lastFrame: Date, now: Date) -> Bool {
        guard state != .off, state != .paused else { return false }
        return now.timeIntervalSince(lastFrame) >= stallSeconds
    }

    private func startWatchdogLocked() {
        guard watchdog == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in self?.checkStallLocked() }
        timer.resume()
        watchdog = timer
    }

    private func checkStallLocked() {
        let now = Date()
        guard let mic, Self.micStalled(state: stateValue, running: micRunning, lastFrame: lastFrameAt, now: now) else { return }
        GenieLog.write("voice", String(format: "microphone delivered nothing for %.0f s (%@) — reopening it",
                                       now.timeIntervalSince(lastFrameAt), "\(stateValue)"))
        mic.discard()
        micRunning = false
        do {
            try startMicLocked()
        } catch {
            GenieLog.write("voice", "could not reopen the microphone: \(error)")
            lastFrameAt = now.addingTimeInterval(Self.stallRetrySeconds - Self.stallSeconds)
        }
    }

    /// エコー除去の切り替えで開けなかったとき、見張りより先に一度だけ試すまでの間。
    static let quickRetrySeconds = 0.5

    private func quickRetryLocked() {
        guard !micRunning, stateValue != .off, stateValue != .paused, let mic else { return }
        mic.discard()
        do {
            try startMicLocked()
            GenieLog.write("voice", "microphone reopened on the quick retry")
        } catch {
            GenieLog.write("voice", "quick retry could not reopen the microphone: \(error)")
        }
    }

    private func stopMicLocked() {
        guard micRunning else { return }
        micRunning = false
        mic?.stop()
    }

    // 呼びかけの後に話が続いたか（「ジーニー」だけか、「ジーニー、〇〇して」か）を見るための大きさ。
    private var afterWakeSamples = 0
    private var afterWakeLoud = 0
    /// 声とみなす大きさ（RMS）。
    static let speechLevel: Float = 0.01

    /// 検出からいままでに、声らしい大きさの音がどれだけあったか（秒）と、見た長さ（秒）。
    /// 会話の受け手へ渡している音で、最後に声らしい大きさがあった時刻（言いかけの続きを待つため）。
    var lastSpeechAt: Date { queue.sync { lastSpeechAtValue } }
    private var lastSpeechAtValue = Date.distantPast

    func speechSinceWake() -> (speech: Double, observed: Double) {
        queue.sync { (Double(afterWakeLoud) / Self.sampleRate, Double(afterWakeSamples) / Self.sampleRate) }
    }

    private func receiveLocked(_ frame: [Float]) {
        lastFrameAt = Date()
        if stateValue == .holding || stateValue == .streaming {
            afterWakeSamples += frame.count
            let rms = sqrt(frame.reduce(0) { $0 + $1 * $1 } / Float(max(1, frame.count)))
            if rms >= Self.speechLevel {
                afterWakeLoud += frame.count
                lastSpeechAtValue = Date()
            }
        }
        switch stateValue {
        case .off:
            return
        case .standby:
            keep(frame, in: &ring, count: &ringSamples, limit: Self.prerollSeconds)
            if detectorValue?.process(frame) == true { wakeLocked() }
        case .holding:
            keep(frame, in: &held, count: &heldSamples, limit: Self.holdLimitSeconds)
        case .streaming:
            consumer?(frame)
        case .paused:
            return
        }
    }

    private func wakeLocked() {
        guard stateValue == .standby || stateValue == .off else { return }
        held = ring; heldSamples = ringSamples
        ring = []; ringSamples = 0
        afterWakeSamples = 0; afterWakeLoud = 0
        stateValue = .holding
        if !micRunning { try? startMicLocked() }
        let onWake = onWakeValue
        DispatchQueue.main.async { onWake?() }
    }

    private func keep(_ frame: [Float], in frames: inout [[Float]], count: inout Int, limit seconds: Double) {
        frames.append(frame); count += frame.count
        let limit = Int(seconds * Self.sampleRate)
        while count > limit, let first = frames.first {
            count -= first.count
            frames.removeFirst()
        }
    }
}
