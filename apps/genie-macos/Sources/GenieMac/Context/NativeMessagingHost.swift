import Foundation

/// §9 Chrome の Native Messaging を受ける側。
///
/// 形式は Chrome が決めている: **4 バイトのリトルエンディアン長 + UTF-8 JSON**。
/// 1 通ずつ読み、Genie の文脈へ入れる。長さは上限で切る（壊れた/悪意ある長さで
/// メモリを食い尽くさない）。
enum NativeMessagingHost {
    /// Chrome 側の上限も 1MB。それより大きいものは読まない。
    static let maxMessageBytes = 1 << 20

    enum FrameError: Error, Equatable {
        case truncated
        case tooLarge(Int)
        case notJSON
    }

    /// 受信フレームを 1 通ぶん切り出す。戻りは (JSON, 消費したバイト数)。
    /// まだ 1 通ぶん届いていなければ nil（エラーではない）。
    static func decode(_ buffer: Data) throws -> (json: [String: Any], consumed: Int)? {
        guard buffer.count >= 4 else { return nil }
        let length = buffer.prefix(4).withUnsafeBytes { raw -> Int in
            Int(UInt32(littleEndian: raw.loadUnaligned(as: UInt32.self)))
        }
        guard length > 0 else { throw FrameError.truncated }
        guard length <= maxMessageBytes else { throw FrameError.tooLarge(length) }
        guard buffer.count >= 4 + length else { return nil }
        let body = buffer.subdata(in: 4..<(4 + length))
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            throw FrameError.notJSON
        }
        return (object, 4 + length)
    }

    /// 送る側の形式（応答用）。
    static func encode(_ object: [String: Any]) -> Data? {
        guard let body = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        var length = UInt32(body.count).littleEndian
        var out = Data(bytes: &length, count: 4)
        out.append(body)
        return out
    }

    /// 1 通を処理する。文脈に入れたら true。
    @MainActor
    @discardableResult
    static func handle(_ message: [String: Any], now: Date = Date()) -> Bool {
        guard let privacy = try? RegistrationPrivacyGuard.observe(), !privacy.blocked, message["type"] as? String == "context",
              let payloadJSON = message["payload"] as? [String: Any],
              let payload = BrowserPayload.from(json: payloadJSON)
        else { return false }
        let fact = payload.fact(now: now)
        guard (try? RegistrationPrivacyGuard.validate(privacy)) != nil else { return false }
        GenieStateStore.shared.updateContext([fact], now: now)
        return true
    }

    /// `--native-messaging` で起動されたときの本体。stdin を読み続ける。
    @MainActor
    static func runLoop() {
        var buffer = Data()
        var privacy: RegistrationPrivacyGuard.Observation?
        let input = FileHandle.standardInput
        while true {
            if buffer.isEmpty { privacy = try? RegistrationPrivacyGuard.observe() }
            let chunk = input.availableData
            if chunk.isEmpty { break }   // Chrome が切った
            buffer.append(chunk)
            while true {
                do {
                    guard let (json, consumed) = try decode(buffer) else { break }
                    buffer.removeFirst(consumed)
                    // Keep the observation from before the blocking read, including
                    // partially received frames. A browser exit cannot release a
                    // context message buffered during protected registration.
                    if let privacy, (try? RegistrationPrivacyGuard.validate(privacy)) != nil { handle(json) }
                } catch {
                    // 壊れたフレームは復帰できないので捨てて終わる（黙って誤読しない）。
                    NSLog("astra native messaging: bad frame \(error)")
                    return
                }
            }
        }
    }
}
