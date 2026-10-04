import AVFoundation
import Foundation
import Speech

/// オンデバイスの Streaming STT（Apple Speech）。正本 §3「Streaming STT」/ §11「音は手元で文字に」。
///
/// **sherpa-onnx の dylib もモデルも要らず、外部 STT にも送らない。**Apple のオンデバイス認識
/// (`requiresOnDeviceRecognition = true`)で、マイクの 16 kHz mono を途中経過/確定へ変える。
/// live 認識は音声認識許可(TCC)が要る（署名 .app でユーザーが許可）。**許可・可用性・ロケールの確認は
/// prompt 無しで読め**、headless で検証できる。
///
/// **黙ってサーバへ落とさない。**このロケールのオンデバイス資産が無い Mac では、以前は
/// `requiresOnDeviceRecognition = supportsOnDeviceRecognition` で Apple のサーバ認識に切り替わり、
/// 「音は端末から出しません」と言いながら音声が外へ出ていた（de-DE で実測、`docs/privacy-egress.md`）。
/// いまは on-device が使えなければ `start` が throw し、録音だけが続く。クラウド文字起こしを
/// 足すなら、「音声が外部へ送られます」と言う別の opt-in 機能として作る。ここで false にはしない。
final class SpeechTranscriber {
    struct Live { let text: String; let isFinal: Bool }

    private let recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let format: AVAudioFormat

    // **発話の区切りは自分で付ける。**
    // 1 本の request を会議のあいだ流し続けると、Apple の認識器は途中で isFinal を返さず、partial の全文を
    // 出し続ける（区切りは request の終わりだけ）。しかも無音のあとに partial が新しい発話から始まり直す
    // ことがあり、前の発話の文は消える。REAL_MEETING（BlackHole + 固定 WAV）で 4 発話のうち最後の 1 つしか
    // 残らなかった（2026-09-06、RC 3c1e93a）。
    //
    // 区切りの合図は**音の無音**（VAD を通った frame が `utteranceGap` 来ない）。文字が変わらないことを合図に
    // すると、認識器の partial が遅れているだけの途中で閉じ、まだ処理していない音を捨てる（「了解です。Windows 版は
    // 次の…」の「Windows 版は」が消えた）。閉じるときは endAudio で認識器に最後まで処理させ、その final を待って
    // から確定する。次の発話の request は先に開いておくので、その間の音は落ちない。
    private var onEvent: ((Live) -> Void)?
    var onFailure: ((Error) -> Void)?
    private var consecutiveFailures = 0
    private var pausedEvent: ((Live) -> Void)?
    private var finishTimer: Timer?
    private var finishCompletion: (() -> Void)?
    private var generation = 0            // 取り直した古い task の結果を見分けるため
    private var lastText = ""
    private var lastChange = Date()
    private var segmentStartedAt = Date()
    private var lastAudioAt = Date()      // VAD を通った音が最後に来た時刻（マイクのスレッドから書く）
    private var gapTimer: Timer?
    private let requestLock = NSLock()    // append / lastAudioAt はマイクのスレッドから来る
    private struct Closing { let gen: Int; var text: String; let since: Date; let task: SFSpeechRecognitionTask? }
    /// 閉じている途中の前の発話。認識器の final を待つ（`closeTimeout` を超えたら手元の文で確定）。
    private var closing: Closing?
    /// 前の発話を閉じている間に届いた次の発話の partial（順番を守るため、確定のあとに流す）。
    private var pendingPartial: String?
    /// 音がこの秒数来なければ、その発話は終わったとみなして閉じる。
    static let utteranceGap: TimeInterval = 0.9
    let utteranceGap: TimeInterval
    /// 閉じた request の final を待つ上限。
    static let closeTimeout: TimeInterval = 1.5
    /// 1 本の request の上限（連続認識は 1 分前後で止まる。切れる前に取り直す）。
    static let requestMaxSeconds: TimeInterval = 50
    /// 診断: この録音で確定した発話の数 / 受け取った partial の数。
    private(set) var finalsEmitted = 0
    private(set) var partialsSeen = 0

    /// 認識器に句読点を付けさせる（声の入力だけ。会議の文字起こしは今までどおり）。
    /// 言葉は変えない（端末内の認識器が付ける。生成モデルで書き直さない）。
    private let punctuate: Bool

    /*
     * 声の入力だけ: 音が途切れなくても、**文字が変わらなくなって**この秒数たてば閉じる。
     * 周りに音（空調・音楽・配信の音）があると無音の判定に届かず、話し終えても送られなかった
     * （2026-10-03 実機:「今日の天気教えて」が出たまま送られない）。閉じるときは endAudio で
     * 認識器に最後まで処理させるので、未処理の音は捨てない。会議の文字起こしでは使わない（nil）。
     */
    let textStableGap: TimeInterval?

    init(localeId: String = "ja-JP", utteranceGap: TimeInterval = SpeechTranscriber.utteranceGap, punctuate: Bool = false,
         textStableGap: TimeInterval? = nil) {
        self.utteranceGap = utteranceGap
        self.textStableGap = textStableGap
        self.punctuate = punctuate
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId))
        format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000,
                               channels: 1, interleaved: false)!
    }

    /// 認可状態（prompt を出さない）。
    static var authorization: SFSpeechRecognizerAuthorizationStatus {
        SFSpeechRecognizer.authorizationStatus()
    }
    static func requestAuthorization(_ done: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { s in
            DispatchQueue.main.async { done(s == .authorized) }
        }
    }

    /// `start` / `recognizeFile` が「このロケールのオンデバイス資産が無い」で断ったときの code。
    static let onDeviceUnavailableCode = 3

    /// この Mac で認識器は在るがオンデバイス資産が無いロケール（検証が「落とさない」を確かめる材料）。
    static func localesWithoutOnDeviceAsset() -> [String] {
        SFSpeechRecognizer.supportedLocales().map(\.identifier).sorted().filter { id in
            guard let r = SFSpeechRecognizer(locale: Locale(identifier: id)), r.isAvailable else { return false }
            return !r.supportsOnDeviceRecognition
        }
    }

    /// オンデバイス認識が使えるか（可用性 + オンデバイス対応）。prompt を出さない。
    var canRunOnDevice: Bool {
        guard let recognizer, recognizer.isAvailable else { return false }
        return recognizer.supportsOnDeviceRecognition
    }

    /// 認識を始める。許可が無い / 使えなければ throw。
    func start(onEvent: @escaping (Live) -> Void) throws {
        guard Self.authorization == .authorized else {
            throw NSError(domain: "SpeechTranscriber", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "speech recognition not authorized"])
        }
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: "SpeechTranscriber", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "recognizer unavailable"])
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw NSError(domain: "SpeechTranscriber", code: Self.onDeviceUnavailableCode,
                          userInfo: [NSLocalizedDescriptionKey: "on-device recognition unavailable for \(recognizer.locale.identifier)"])
        }
        self.onEvent = onEvent
        openRequest()
        // 区切りの見張り。認識器の callback は main queue（SFSpeechRecognizer.queue の既定）なので、ここも main で回す。
        let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        gapTimer = t
    }

    /// 新しい request / task を開く。古い task の結果は generation で見分ける。
    private func openRequest() {
        guard let recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = punctuate
        req.requiresOnDeviceRecognition = true   // 資産が無ければ error 102。false で再試行しない
        generation += 1
        let gen = generation
        requestLock.lock(); request = req; requestLock.unlock()
        lastText = ""; lastChange = Date(); segmentStartedAt = Date()
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if result == nil, let error {
                guard gen == self.generation, self.onEvent != nil, self.finishCompletion == nil else { return }
                if self.closing?.gen == gen { self.finishClosing(); return }
                self.consecutiveFailures += 1
                if self.consecutiveFailures <= 2 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                        guard let self, self.generation == gen, self.onEvent != nil, self.finishCompletion == nil else { return }
                        self.emitFinal(self.lastText)
                        self.reopen()
                    }
                } else { self.onFailure?(error) }
                return
            }
            guard let result else { return }
            self.consecutiveFailures = 0
            let text = result.bestTranscription.formattedString
            if let c = self.closing, c.gen == gen {
                // 閉じている前の発話。認識器が最後まで処理した文で確定する。
                if !text.isEmpty { self.closing?.text = text }
                if result.isFinal { self.finishClosing() }
                return
            }
            guard gen == self.generation else { return }
            self.partialsSeen += 1
            if text != self.lastText { self.lastText = text; self.lastChange = Date() }
            if result.isFinal {
                // 認識器が自分で終えた（request の上限など）。手元の文で確定して取り直す。
                self.emitFinal(text)
                self.reopen()
            } else if self.closing != nil {
                self.pendingPartial = text
            } else {
                self.onEvent?(Live(text: text, isFinal: false))
            }
        }
    }

    private func emitFinal(_ text: String) {
        guard !text.isEmpty else { return }
        finalsEmitted += 1
        onEvent?(Live(text: text, isFinal: true))
    }

    private func tick() {
        let now = Date()
        if let c = closing, now.timeIntervalSince(c.since) >= Self.closeTimeout {
            finishClosing()   // final が来ない。手元の文で確定する。
        }
        guard closing == nil, !lastText.isEmpty else { return }
        requestLock.lock(); let audioAt = lastAudioAt; requestLock.unlock()
        if Self.shouldClose(now: now, lastAudio: audioAt, lastTextChange: lastChange, segmentStart: segmentStartedAt,
                            utteranceGap: utteranceGap, textStableGap: textStableGap) {
            beginClose(reopen: true)
        }
    }

    /// 発話を閉じるか。音の無音・文字の静止（声の入力だけ）・request の上限のどれか。
    static func shouldClose(now: Date, lastAudio: Date, lastTextChange: Date, segmentStart: Date,
                            utteranceGap: TimeInterval, textStableGap: TimeInterval?) -> Bool {
        if now.timeIntervalSince(lastAudio) >= utteranceGap { return true }
        if let gap = textStableGap, now.timeIntervalSince(lastTextChange) >= gap { return true }
        return now.timeIntervalSince(segmentStart) >= requestMaxSeconds
    }

    /// いまの発話を閉じ始める。認識器には endAudio で最後まで処理させる（cancel は残りの音を捨てる）。
    private func beginClose(reopen: Bool) {
        requestLock.lock(); let old = request; request = nil; requestLock.unlock()
        closing = Closing(gen: generation, text: lastText, since: Date(), task: task)
        old?.endAudio()
        task = nil
        lastText = ""
        if reopen { openRequest() }
    }

    private func finishClosing() {
        guard let c = closing else { return }
        closing = nil
        c.task?.cancel()
        emitFinal(c.text)
        if let p = pendingPartial { pendingPartial = nil; onEvent?(Live(text: p, isFinal: false)) }
    }

    /// 認識器が自分で終えた request を取り直す。
    private func reopen() {
        requestLock.lock(); let old = request; request = nil; requestLock.unlock()
        old?.endAudio(); task?.cancel(); task = nil
        lastText = ""
        guard onEvent != nil else { return }
        openRequest()
    }

    /// マイクの 16 kHz mono f32 フレームを渡す（VAD を通った、声の乗った frame だけ）。
    func append(_ frames: [Float], sampleRate: Double = 16_000) {
        requestLock.lock(); let request = request; lastAudioAt = Date(); requestLock.unlock()
        guard let request, !frames.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                            frameCapacity: AVAudioFrameCount(frames.count))
        else { return }
        buffer.frameLength = AVAudioFrameCount(frames.count)
        if let ch = buffer.floatChannelData {
            frames.withUnsafeBufferPointer { src in
                ch[0].update(from: src.baseAddress!, count: frames.count)
            }
        }
        request.append(buffer)
    }

    /// Close recognition without keeping the caller inside a nested run loop.
    /// Both a closing utterance and a newer partial are finalized in order.
    func finishAsync(completion: @escaping () -> Void) {
        pausedEvent = nil
        gapTimer?.invalidate(); gapTimer = nil
        finishCompletion = completion
        func advance() -> Bool {
            if let c = closing {
                guard Date().timeIntervalSince(c.since) >= Self.closeTimeout else { return false }
                finishClosing()
            }
            if !lastText.isEmpty {
                beginClose(reopen: false)
                return false
            }
            finish() // No pending utterance remains, so this cannot wait.
            return true
        }
        if advance() { return }
        let timer = Timer(timeInterval: 0.05, repeats: true) { _ in _ = advance() }
        RunLoop.main.add(timer, forMode: .common)
        finishTimer = timer
    }

    /// `waitForTail`: 止めた瞬間の発話の末尾を待つか。呼びかけの待ち受けは末尾が要らない
    /// （待つと main を最大 closeTimeout 止め、呼んでから返事までが 1.5 秒遅れた。2026-10-04 計測）。
    func finish(waitForTail: Bool = true) {
        finishTimer?.invalidate(); finishTimer = nil
        pausedEvent = nil
        gapTimer?.invalidate(); gapTimer = nil
        // 止めた瞬間の発話も、認識器に最後まで処理させてから確定する（途中で切ると末尾が欠ける:
        // 「共有します」が「共有しま」で残った）。待つのは closeTimeout まで。
        if waitForTail, closing == nil, !lastText.isEmpty { beginClose(reopen: false) }
        let deadline = Date().addingTimeInterval(Self.closeTimeout)
        while closing != nil, Date() < deadline { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        if closing != nil { finishClosing() }
        onEvent = nil
        generation += 1
        requestLock.lock(); let req = request; request = nil; requestLock.unlock()
        req?.endAudio()
        task?.cancel()
        task = nil
        let completion = finishCompletion
        finishCompletion = nil
        completion?()
    }

    /// Finish the pre-pause utterance and release its recognition request.
    /// A request opened during silence can become stale before recording resumes.
    func pause() {
        let callback = onEvent
        finish()
        pausedEvent = callback
    }

    func resume() throws {
        guard let callback = pausedEvent else { return }
        try start(onEvent: callback)
        pausedEvent = nil
    }

    /// 音声ファイルを 1 回で認識する（オンデバイス）。会議録音の後処理や検証に使う。
    /// 許可が無い / 使えなければ nil。**オンデバイス資産が無くても nil**（サーバへは出さない）。認識結果の確定文字列を返す。
    ///
    /// **重要**: `SFSpeechRecognitiontask` の完了は現在の run loop 経由で届くため、
    /// セマフォで待つとメインスレッドを塞いで callback が永遠に来ない（空文字になる）。
    /// ここでは run loop を回して待つ（メイン/バックグラウンドどちらから呼んでも成立する）。
    func recognizeFile(_ url: URL, timeout: TimeInterval = 20) -> String? {
        guard Self.authorization == .authorized, let recognizer, recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition else { return nil }
        let req = SFSpeechURLRecognitionRequest(url: url)
        req.requiresOnDeviceRecognition = true
        let lock = NSLock()
        var latest = ""            // partial も貯める（isFinal が遅いことがある）
        var done = false
        let t = recognizer.recognitionTask(with: req) { result, error in
            if let result {
                lock.lock(); latest = result.bestTranscription.formattedString
                if result.isFinal { done = true }
                lock.unlock()
            }
            if error != nil { lock.lock(); done = true; lock.unlock() }
        }
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            lock.lock(); let d = done; lock.unlock()
            if d || Date() > deadline { break }
            CFRunLoopRunInMode(.defaultMode, 0.05, true)   // 塞がず回して callback を届かせる
        }
        t.cancel()
        lock.lock(); let out = latest; lock.unlock()
        return out.isEmpty ? nil : out
    }
}
