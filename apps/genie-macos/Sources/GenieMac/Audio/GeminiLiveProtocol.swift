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

    // MARK: - 送る

    static func setup(model: String = defaultModel, instruction: String) -> [String: Any] {
        [
            "setup": [
                "model": "models/\(model)",
                "generationConfig": ["responseModalities": ["AUDIO"]],
                "systemInstruction": ["parts": [["text": instruction]]],
                "inputAudioTranscription": [String: Any](),
                "outputAudioTranscription": [String: Any](),
                "tools": [[
                    "functionDeclarations": [[
                        "name": delegateTool,
                        "description": "利用者が作業・操作・調べものを頼んだときに、その依頼文を Genie に渡す。受け付けたかどうかだけが返る。完了を待たない。",
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

    static func toolResponse(id: String, name: String, response: [String: Any]) -> [String: Any] {
        ["toolResponse": ["functionResponses": [["id": id, "name": name, "response": response]]]]
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
        case goAway
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
        if root["goAway"] != nil { events.append(.goAway) }
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
