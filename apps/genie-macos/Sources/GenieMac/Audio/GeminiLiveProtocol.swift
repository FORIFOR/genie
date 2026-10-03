import Foundation

/// Gemini Live（BidiGenerateContent）の送受信の形。**通信しない純粋な部品**なので、キーが無くても検査できる。
///
/// 形は公式の API 参照（https://ai.google.dev/api/live、2026-09-27 に確認）に合わせる:
/// setup → setupComplete、realtimeInput.audio（16 kHz・16bit PCM・little-endian）、
/// serverContent（modelTurn.parts[].inlineData / inputTranscription / outputTranscription /
/// interrupted / turnComplete）、toolCall / toolResponse、usageMetadata、goAway。
enum GeminiLive {
    static let endpoint = URL(string: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent")!
    static let host = "generativelanguage.googleapis.com"
    static let defaultModel = "gemini-3.8-live"
    static let inputRate = 16_000

    /// 仕事を Genie に渡す道具。会話の中で「やって」と言われたらこれを呼ばせる。
    /// 返すのは受け付けたかだけ（仕事の中身・結果の本文は渡さない）。
    static let delegateTool = "delegate_task"

    /// サーバーが接続を閉じた理由のうち、つなぎ直しても直らないもの（本人が直す）を言葉にする。それ以外は nil。
    /// 例: 利用枠の超過は close 1011「You exceeded your current quota…」、前払いの残高切れは
    /// close 1011「Your prepayment credits are depleted…」（どちらも 2026-09-29 に実機で確認）。
    /// 支払い・利用枠で使えない（キーは正しい）。本人がクレジットを足すまで、ほかの経路で会話する。
    static let creditsDepletedMessage = "Gemini の前払いクレジットが残っていません。AI Studio のプロジェクトでクレジットを追加してください。"
    static let quotaMessage = "Gemini の利用枠の上限に達しました。Google AI Studio で API キーのプランと請求を確かめてください。"
    static func isBillingUnavailable(_ message: String) -> Bool {
        message == creditsDepletedMessage || message == quotaMessage
    }

    static func fatalCloseMessage(code: Int, reason: String?) -> String? {
        let r = (reason ?? "").lowercased()
        if r.contains("prepayment") || r.contains("credits are depleted") {
            return creditsDepletedMessage
        }
        if r.contains("quota") || r.contains("resource_exhausted") {
            return quotaMessage
        }
        if r.contains("api key") || r.contains("api_key") || r.contains("permission denied") {
            return "Gemini の API キーが使えません。設定でキーを確かめてください。"
        }
        return nil
    }

    // MARK: - 送る

    /// 話し終わりの判定（ミリ秒）。公式の推奨は 500〜800ms（100〜200ms に縮めると一つの発話が分かれる）。
    /// 言い直し（「木曜……いや、金曜」）を待てるよう、推奨の中ほどから始める。実機の日本語で詰める。
    static let silenceDurationMs = 650
    /// 話し始めの直前も拾う（語頭の欠け防止）。
    static let prefixPaddingMs = 200
    /// 声（本人の指定、2026-09-29）。公式の prebuilt voice の名前（`speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`）。
    static let voiceName = "Kore"

    /// 接続の設定。**3.8 Live で送ってはいけない設定を入れない**（`thinkingConfig`・`enableAffectiveDialog`・
    /// `proactivity`・`languageCode`。3.8 では proactive audio が常に有効で、false はエラー。言語は指示で決める）。
    /// 公式: ai.google.dev/gemini-api/docs/models/gemini-3.8-live、live-api/capabilities、session-management（2026-09-29 確認）。
    /// `resumeHandle`: 前の接続が渡した再開の鍵（接続は約 10 分で切れる。鍵は切れてから 2 時間有効）。
    static func setup(model: String = defaultModel, instruction: String, resumeHandle: String? = nil) -> [String: Any] {
        var resumption: [String: Any] = [:]
        if let resumeHandle { resumption["handle"] = resumeHandle }
        return [
            "setup": [
                "model": "models/\(model)",
                "generationConfig": [
                    "responseModalities": ["AUDIO"],
                    "speechConfig": ["voiceConfig": ["prebuiltVoiceConfig": ["voiceName": voiceName]]],
                ],
                "systemInstruction": ["parts": [["text": instruction]]],
                "inputAudioTranscription": [String: Any](),
                "outputAudioTranscription": [String: Any](),
                // 話し終わりはサーバーの自動判定に任せ、独自の区切りを重ねない。話し始めたら出力を止める（割り込み）。
                "realtimeInputConfig": [
                    "automaticActivityDetection": [
                        "disabled": false,
                        "prefixPaddingMs": prefixPaddingMs,
                        "silenceDurationMs": silenceDurationMs,
                        "endOfSpeechSensitivity": "END_SENSITIVITY_LOW",
                    ],
                    "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
                ],
                // 接続が切れても同じ会話へ戻る（goAway・回線の切断）。長い会話は履歴を圧縮する（音声だけなら無いと 15 分）。
                "sessionResumption": resumption,
                "contextWindowCompression": ["slidingWindow": [String: Any]()],
                // 天気・ニュースなどの公開情報は Gemini が Google 検索で調べて答える（Genie の仕事の中身は渡さない）。
                // 3.8 Live は googleSearch と functionDeclarations を併用できる（公式: live-api/tools、2026-09-29 確認）。
                "tools": [[
                    "googleSearch": [String: Any](),
                ], [
                    "functionDeclarations": [[
                        "name": delegateTool,
                        // 仕事の完了を待たずに会話を続ける（3.8 の既定だが、意図として明示する）。
                        "behavior": "NON_BLOCKING",
                        "description": "利用者が Mac での作業・アプリの操作・送信・注文や予約などを頼んだときに、その依頼文を Genie に渡す。受け付けたかどうかだけが返る。完了を待たない。支払いや確定の前には Genie が画面で本人に確認する。",
                        "parameters": [
                            "type": "OBJECT",
                            "properties": ["request": ["type": "STRING", "description": "依頼文（利用者の言葉のまま）"]],
                            "required": ["request"],
                        ],
                    ]],
                ]],
            ],
        ]
    }

    /// 16 kHz mono の float フレーム → 16bit little-endian PCM → base64。
    static func audioChunk(_ frame: [Float]) -> [String: Any] {
        var data = Data(capacity: frame.count * 2)
        for sample in frame {
            let clamped = max(-1, min(1, sample))
            var value = Int16(clamped * Float(Int16.max)).littleEndian
            withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
        }
        return ["realtimeInput": ["audio": ["data": data.base64EncodedString(), "mimeType": "audio/pcm;rate=\(inputRate)"]]]
    }

    static let audioStreamEnd: [String: Any] = ["realtimeInput": ["audioStreamEnd": true]]

    /// 仕事の受付を返す。話の途中に割り込ませず、区切りで伝える（`scheduling` は response の中）。
    static func toolResponse(id: String, name: String, response: [String: Any], scheduling: String = "WHEN_IDLE") -> [String: Any] {
        var body = response
        body["scheduling"] = scheduling
        return ["toolResponse": ["functionResponses": [["id": id, "name": name, "response": body]]]]
    }

    // MARK: - 受ける

    enum ServerEvent: Equatable {
        case setupComplete
        /// 相手の声（PCM・little-endian）と標本化周波数。
        case audio(Data, sampleRate: Int)
        case inputTranscript(String)
        case outputTranscript(String)
        case interrupted
        case generationComplete
        case turnComplete
        case toolCall(id: String, name: String, request: String)
        case toolCallCancelled([String])
        case usage(totalTokens: Int)
        /// もうすぐ接続が切れる（残り時間。読めなければ nil）。
        case goAway(timeLeft: String?)
        /// 再開の鍵。`resumable` が false の間（生成・道具の途中）は、その鍵では戻れない。
        case resumption(handle: String, resumable: Bool)
    }

    /// 1 つのメッセージから出来事を取り出す（1 通に複数入ることがある）。知らない形は無視する。
    static func parse(_ text: String) -> [ServerEvent] {
        guard let data = text.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        var events: [ServerEvent] = []
        if root["setupComplete"] != nil { events.append(.setupComplete) }
        if let content = root["serverContent"] as? [String: Any] {
            if let turn = content["modelTurn"] as? [String: Any], let parts = turn["parts"] as? [[String: Any]] {
                for part in parts {
                    guard let inline = part["inlineData"] as? [String: Any],
                          let b64 = inline["data"] as? String, let pcm = Data(base64Encoded: b64) else { continue }
                    events.append(.audio(pcm, sampleRate: rate(of: inline["mimeType"] as? String) ?? 24_000))
                }
            }
            if let t = (content["inputTranscription"] as? [String: Any])?["text"] as? String, !t.isEmpty { events.append(.inputTranscript(t)) }
            if let t = (content["outputTranscription"] as? [String: Any])?["text"] as? String, !t.isEmpty { events.append(.outputTranscript(t)) }
            if content["interrupted"] as? Bool == true { events.append(.interrupted) }
            if content["generationComplete"] as? Bool == true { events.append(.generationComplete) }
            if content["turnComplete"] as? Bool == true { events.append(.turnComplete) }
        }
        if let call = root["toolCall"] as? [String: Any], let calls = call["functionCalls"] as? [[String: Any]] {
            for c in calls {
                guard let id = c["id"] as? String, let name = c["name"] as? String else { continue }
                let request = ((c["args"] as? [String: Any])?["request"] as? String) ?? ""
                events.append(.toolCall(id: id, name: name, request: request))
            }
        }
        if let cancel = root["toolCallCancellation"] as? [String: Any], let ids = cancel["ids"] as? [String] {
            events.append(.toolCallCancelled(ids))
        }
        if let usage = root["usageMetadata"] as? [String: Any], let total = usage["totalTokenCount"] as? Int {
            events.append(.usage(totalTokens: total))
        }
        if let update = root["sessionResumptionUpdate"] as? [String: Any], let handle = update["newHandle"] as? String, !handle.isEmpty {
            events.append(.resumption(handle: handle, resumable: update["resumable"] as? Bool ?? false))
        }
        if let away = root["goAway"] as? [String: Any] { events.append(.goAway(timeLeft: away["timeLeft"] as? String)) }
        else if root["goAway"] != nil { events.append(.goAway(timeLeft: nil)) }
        return events
    }

    static func rate(of mimeType: String?) -> Int? {
        guard let mimeType, let r = mimeType.range(of: #"rate=(\d+)"#, options: .regularExpression) else { return nil }
        return Int(mimeType[r].dropFirst(5))
    }

    static func json(_ object: [String: Any]) -> String {
        (try? JSONSerialization.data(withJSONObject: object)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

/// Gemini Live の月の上限（分）。**上限を決めるまで使えない**（「上げたら青天井」を作らない）。
/// 使った時間は会話の接続時間で数える（音を送っていない間も接続は課金の対象になり得るので、
/// 「無音なら 0」とは数えない）。
struct GeminiLiveBudget: Equatable {
    /// 本人が決めた月の上限（分）。0 = 決めていない（使えない）。
    var monthlyMinutes: Int
    /// その月に使った秒数。
    var usedSeconds: Double
    /// 使った秒数の月（"2026-09"）。月が変われば 0 から数える。
    var month: String

    static func monthKey(_ date: Date, calendar: Calendar = Calendar(identifier: .gregorian)) -> String {
        let c = calendar.dateComponents(in: TimeZone(identifier: "Asia/Tokyo")!, from: date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }

    func current(at date: Date) -> GeminiLiveBudget {
        let key = Self.monthKey(date)
        return key == month ? self : GeminiLiveBudget(monthlyMinutes: monthlyMinutes, usedSeconds: 0, month: key)
    }

    /// 始めてよいか。理由つきで断る。
    func canStart(at date: Date) -> (ok: Bool, reason: String?) {
        let now = current(at: date)
        guard monthlyMinutes > 0 else { return (false, "Gemini Live の月の上限が決まっていません。設定で上限を決めてください。") }
        guard now.usedSeconds < Double(monthlyMinutes) * 60 else {
            return (false, "今月の Gemini Live の上限（\(monthlyMinutes) 分）に達しました。")
        }
        return (true, nil)
    }

    /// この月に残っている秒数。会話はこれを超えて続けない。
    func remainingSeconds(at date: Date) -> Double {
        let now = current(at: date)
        return max(0, Double(monthlyMinutes) * 60 - now.usedSeconds)
    }

    mutating func record(seconds: Double, at date: Date) {
        self = current(at: date)
        usedSeconds += max(0, seconds)
    }
}
