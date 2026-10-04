import CryptoKit
import Foundation

/// Genie の声は Gemini TTS だけ（本人の指示 2026-10-04:「必ず Gemini の TTS にしてください」）。
/// macOS 標準の読み上げには戻さない。作れなければ黙り、理由を genie.log に残す。
///
/// - 送るのは読み上げる文だけ（会話の文脈・画像・キー以外の識別子は送らない）
/// - 同じ文の音声は端末に残して使い回す（「はい、何でしょう。」を毎回作らない。呼んでから返事までを短くする）
/// - API: Interactions（`POST /v1beta/interactions`、WAV 24 kHz mono 16-bit。公式 speech-generation、2026-10-04 確認）
enum GeminiSpeech {
    static let model = "gemini-3.8-flash-tts"
    /// 落ち着いた声（Kore: Firm）。秘書の口調は style で添える。
    static let voice = "Kore"
    static let style = "落ち着いた、丁寧で親しみのある秘書の口調"
    /// 長い答えは先頭だけ読む（全部は Dock の文で読める）。
    static let maxCharacters = 600

    enum Failure: Error, CustomStringConvertible {
        case noKey, http(Int, String), noAudio, invalidResponse
        var description: String {
            switch self {
            case .noKey: return "Gemini のキーがありません"
            case .http(let status, let message): return "HTTP \(status) \(message)"
            case .noAudio: return "音声が返りませんでした"
            case .invalidResponse: return "応答を読めませんでした"
            }
        }
    }

    static var cacheDirectory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Genie/speech", isDirectory: true)
    }

    static func cacheURL(for text: String) -> URL {
        let digest = SHA256.hash(data: Data("\(model)|\(voice)|\(style)|\(text)".utf8))
        return cacheDirectory.appendingPathComponent(digest.map { String(format: "%02x", $0) }.joined() + ".wav")
    }

    static func requestBody(for text: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "model": model,
            "input": [[
                "type": "user_input",
                "content": [[
                    "type": "text", "text": text,
                    "annotations": [["type": "speech_metadata", "style": style]],
                ]],
            ]],
            "response_format": ["type": "audio", "mime_type": "audio/wav"],
            "generation_config": ["speech_config": [["voice": voice]]],
            "stream": false,
        ] as [String: Any])
    }

    /// 応答から最後の音声を取り出す（`steps[type=model_output].content[type=audio].data`）。
    static func audio(from data: Data) throws -> Data {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let steps = root["steps"] as? [[String: Any]] else { throw Failure.invalidResponse }
        let blocks = steps.filter { ($0["type"] as? String) == "model_output" }
            .flatMap { ($0["content"] as? [[String: Any]]) ?? [] }
            .filter { ($0["type"] as? String) == "audio" }
        guard let encoded = blocks.last?["data"] as? String, let audio = Data(base64Encoded: encoded), !audio.isEmpty
        else { throw Failure.noAudio }
        return audio
    }

    /// 文を音声（WAV）にする。端末に同じ文があればそれを返す。
    static func synthesize(_ text: String, apiKey: String?) async throws -> Data {
        let text = String(text.prefix(maxCharacters))
        let cached = cacheURL(for: text)
        if let data = try? Data(contentsOf: cached), !data.isEmpty { return data }
        guard let apiKey, !apiKey.isEmpty else { throw Failure.noKey }
        var request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/interactions")!,
                                 timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.httpBody = try requestBody(for: text)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let message = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
                .flatMap { $0["error"] as? [String: Any] }.flatMap { $0["message"] as? String } ?? ""
            throw Failure.http(status, String(message.prefix(160)))
        }
        let audio = try audio(from: data)
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? audio.write(to: cached, options: .atomic)
        return audio
    }
}
