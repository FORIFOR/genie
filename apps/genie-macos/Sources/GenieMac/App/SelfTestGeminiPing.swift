import Foundation

extension SelfTest {
    /// Gemini API の状態を 3 段で見る（キーは表示しない）: キーが通るか（モデル一覧）・文章・声。
    @MainActor static func geminiPing() async {
        guard let key = GeminiLiveSettings.shared.apiKey() else { print("SELFTEST_FAIL geminiping: key missing"); exit(2) }
        func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) async -> (Int, String, Data) {
            var request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/" + path)!, timeoutInterval: 30)
            request.httpMethod = method
            request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            }
            guard let (data, response) = try? await URLSession.shared.data(for: request) else { return (0, "network", Data()) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let error = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? [String: Any]
            let message = [error?["status"] as? String, error?["message"] as? String].compactMap { $0 }.joined(separator: " ")
            return (status, String(message.prefix(200)), data)
        }
        let (listStatus, listMessage, listData) = await call("GET", "models?pageSize=200")
        let names = (((try? JSONSerialization.jsonObject(with: listData)) as? [String: Any])?["models"] as? [[String: Any]] ?? [])
            .compactMap { $0["name"] as? String }
        let textModel = names.first { $0.contains("flash-lite") && !$0.contains("tts") && !$0.contains("live") && !$0.contains("image") }
            ?? names.first { $0.contains("flash") && !$0.contains("tts") && !$0.contains("live") }
        print("models: HTTP \(listStatus) \(listMessage) count=\(names.count) live=\(names.filter { $0.contains("live") }.prefix(3)) tts=\(names.filter { $0.contains("tts") }.prefix(3))")
        if let textModel {
            let (status, message, _) = await call("POST", "\(textModel):generateContent",
                                                  ["contents": [["parts": [["text": "OK とだけ答えて"]]]]])
            print("text(\(textModel)): HTTP \(status) \(message)")
        }
        let (ttsStatus, ttsMessage, _) = await call("POST", "interactions", (try? JSONSerialization.jsonObject(with: GeminiSpeech.requestBody(for: "はい"))) as? [String: Any])
        print("tts(\(GeminiSpeech.model)): HTTP \(ttsStatus) \(ttsMessage)")
        print("SELFTEST_OK geminiping")
        exit(0)
    }
}
