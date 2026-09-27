import Foundation

/// 「Genie と会話」の進み方。**入力（出来事）→ 状態 → 出力（やること）** だけの純粋な型。
///
/// 一回の音声入力（聞く → 入れる / 送る → 終わり）とは別の入口で、明示的に始めて複数ターン続く。
/// 半二重: 考えている間と読み上げている間はマイクを閉じ、読み上げが終わってから開き直す
/// （Genie の声が自分のマイクに入って次の依頼にならないように）。
///
/// 決まりごと（docs/ux-benchmark/compare/conversation-loop/ROUND.md）:
/// - 始めてから 5 分で終わる。無操作で早く終わらない。話すたびに延びない。
/// - 終わる 30 秒前に知らせる。延ばすのは本人の操作だけ（1 回 5 分、合計 15 分まで）。
/// - 終わるときは 1 つの手順（世代を進める → マイク・読み上げを止める）。**仕事は取り消さない。**
/// - 空の答え・コードだけの答え・失敗・時間のかかる仕事でも、次のターンを聞ける姿へ戻る。
/// - 世代の古い知らせ（終わった後の読み上げ完了・遅れた確定文）では何も起こさない。
struct ConversationLoop: Equatable {
    static let duration: TimeInterval = 5 * 60
    static let warningLead: TimeInterval = 30
    static let maximumTotal: TimeInterval = 15 * 60

    enum Phase: Equatable {
        case inactive
        /// マイクを開いた。最初の音声フレームを待っている。
        case preparing
        case listening
        /// 依頼を送った。答えを待っている（マイクは閉じている）。
        case waiting
        /// 答えを読み上げている（マイクは閉じている）。
        case speaking
    }

    enum Effect: Equatable {
        case openMicrophone(generation: Int)
        case closeMicrophone
        /// 依頼として送る（この会話の中の 1 ターン）。
        case send(String)
        /// 読み上げる。終わったら `speechFinished(generation:)` を返す。
        case speak(String, generation: Int)
        case stopSpeaking
        /// 終わる前の知らせ（表示だけ。音は出さない）。
        case warnEnding
        /// 聞ける状態になった合図（会話の最初の 1 回だけ）。マイクの最初のフレームが届いてから鳴らす
        /// —— 合図だけ鳴って言葉を聞けていない、を作らない。
        case readyCue
        /// 終わった。理由つき。Dock は仕事・確認の状態へ戻す（仕事は取り消さない）。
        case ended(reason: EndReason)
    }

    enum EndReason: String, Equatable {
        case user, timeout, sleep, microphoneLost, replaced
        /// 会話の提供元（Gemini Live など）との接続が切れた・上限に達した。
        case providerLost
    }

    enum Reply: Equatable {
        /// 答えが確定した。読み上げる文（空ならすぐ次を聞く）。
        case settled(String)
        /// 受け付けて裏で進んでいる。受付を知らせてから次を聞く。
        case working
        /// 失敗・接続できない。理由を短く知らせて次を聞く。
        case failed(String)
        /// 前の依頼の途中で送れなかった（預かった）。知らせて次を聞く。
        case held
    }

    private(set) var phase: Phase = .inactive
    private(set) var generation = 0
    private(set) var startedAt: Date?
    private(set) var endsAt: Date?
    private(set) var warned = false
    private(set) var cued = false

    var isActive: Bool { phase != .inactive }

    func remaining(at now: Date) -> TimeInterval {
        guard let endsAt else { return 0 }
        return max(0, endsAt.timeIntervalSince(now))
    }

    var canExtend: Bool {
        guard let startedAt, let endsAt else { return false }
        return endsAt.timeIntervalSince(startedAt) + Self.duration <= Self.maximumTotal
    }

    // MARK: - 出来事

    mutating func start(now: Date) -> [Effect] {
        guard !isActive else { return [] }
        generation += 1
        startedAt = now
        endsAt = now.addingTimeInterval(Self.duration)
        warned = false
        cued = false
        phase = .preparing
        return [.openMicrophone(generation: generation)]
    }

    mutating func firstFrame(generation g: Int) -> [Effect] {
        guard g == generation, phase == .preparing else { return [] }
        phase = .listening
        guard !cued else { return [] }
        cued = true
        return [.readyCue]
    }

    /// 言い終えた（確定文）。空なら聞き続ける。
    mutating func utterance(_ text: String, generation g: Int) -> [Effect] {
        guard g == generation, phase == .listening || phase == .preparing else { return [] }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        phase = .waiting
        return [.closeMicrophone, .send(trimmed)]
    }

    /// 答えが来た。読み上げるか、すぐ次を聞く。
    mutating func reply(_ reply: Reply) -> [Effect] {
        guard phase == .waiting else { return [] }
        let spoken: String
        switch reply {
        case .settled(let text): spoken = text
        // 受け付けた（仕事が作られた）ときだけ。受け付けられなかったものは .failed で理由を言う。
        case .working: spoken = "かしこまりました。進めています。結果は Work に届きます。"
        case .failed(let reason): spoken = reason
        case .held: spoken = "前の依頼に答えている途中です。いまの内容はまだ送っていません。"
        }
        if spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return listenAgain()
        }
        phase = .speaking
        return [.speak(spoken, generation: generation)]
    }

    /// 読み上げが終わった（止めた場合も）。この世代の知らせだけ受ける。
    mutating func speechFinished(generation g: Int) -> [Effect] {
        guard g == generation, phase == .speaking else { return [] }
        return listenAgain()
    }

    /// 読み上げだけを止める（会話は続け、次を聞く）。会話を終えるのは `end`。
    mutating func stopSpeaking() -> [Effect] {
        guard phase == .speaking else { return [] }
        return [.stopSpeaking] + listenAgain()
    }

    /// 時計。終わる前に 1 回だけ知らせ、時間が来たら終える。
    mutating func tick(now: Date) -> [Effect] {
        guard isActive else { return [] }
        let left = remaining(at: now)
        if left <= 0 { return end(.timeout) }
        if !warned, left <= Self.warningLead {
            warned = true
            return [.warnEnding]
        }
        return []
    }

    /// 本人が延ばす（1 回 5 分、合計 15 分まで）。知らせは次の終わり際にまた出す。
    mutating func extend(now: Date) -> Bool {
        guard isActive, canExtend, let endsAt else { return false }
        self.endsAt = endsAt.addingTimeInterval(Self.duration)
        warned = remaining(at: now) <= Self.warningLead
        return true
    }

    /// 終える。**先に世代を進める**ので、止める途中に届いた知らせは古い世代になる。
    mutating func end(_ reason: EndReason) -> [Effect] {
        guard isActive else { return [] }
        let wasSpeaking = phase == .speaking
        generation += 1
        phase = .inactive
        startedAt = nil
        endsAt = nil
        warned = false
        return (wasSpeaking ? [.stopSpeaking] : []) + [.closeMicrophone, .ended(reason: reason)]
    }

    private mutating func listenAgain() -> [Effect] {
        phase = .preparing
        return [.openMicrophone(generation: generation)]
    }
}
