import Foundation

/// `--selftest geminismoke`: 本人のキーで Gemini Live につながり、1 ターン答えが返るか。
///
/// マイク・スピーカーは使わない。テキストで 1 回だけ話しかけ、setupComplete → 声の答え → turnComplete を見る。
/// 本人がオンにし、キーと月の上限を置いていなければ SKIP（勝手に課金しない）。使った時間は上限に記録する。
extension SelfTest {
    @MainActor
    static func geminiSmoke() async {
        let settings = GeminiLiveSettings.shared
        guard settings.active, let key = settings.apiKey() else {
            print("SELFTEST_SKIP geminismoke: Gemini Live is not enabled with a key and a monthly limit"); exit(0)
        }
        let check = settings.budget.canStart(at: Date())
        guard check.ok else { print("SELFTEST_SKIP geminismoke: \(check.reason ?? "limit")"); exit(0) }

        var request = URLRequest(url: GeminiLive.endpoint)
        request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
        let socket = URLSession.shared.webSocketTask(with: request)
        let started = Date()
        socket.resume()
        defer { settings.record(seconds: Date().timeIntervalSince(started)) }

        func send(_ object: [String: Any]) async throws { try await socket.send(.string(GeminiLive.json(object))) }
        var seen: [String] = []
        var audioBytes = 0
        do {
            try await send(GeminiLive.setup(instruction: "日本語で一言だけ返事をしてください。"))
            let deadline = Date().addingTimeInterval(30)
            var sentTurn = false
            loop: while Date() < deadline {
                let message = try await socket.receive()
                let text: String? = switch message {
                case .string(let s): s
                case .data(let d): String(data: d, encoding: .utf8)
                @unknown default: nil
                }
                for event in GeminiLive.parse(text ?? "") {
                    switch event {
                    case .setupComplete:
                        seen.append("setupComplete")
                        if !sentTurn {
                            sentTurn = true
                            try await send(["clientContent": ["turns": [["role": "user", "parts": [["text": "こんにちは"]]]], "turnComplete": true]])
                        }
                    case .audio(let pcm, let rate):
                        if audioBytes == 0 { seen.append("audio@\(rate)") }
                        audioBytes += pcm.count
                    case .outputTranscript(let t): if !seen.contains("transcript") { seen.append("transcript:\(t.prefix(20))") }
                    case .turnComplete: seen.append("turnComplete"); break loop
                    case .goAway: seen.append("goAway"); break loop
                    default: break
                    }
                }
            }
        } catch {
            socket.cancel(with: .normalClosure, reason: nil)
            print("SELFTEST_FAIL geminismoke: \(error.localizedDescription) seen=\(seen)"); exit(2)
        }
        socket.cancel(with: .normalClosure, reason: nil)
        if seen.contains("setupComplete"), audioBytes > 0, seen.contains("turnComplete") {
            print("SELFTEST_OK geminismoke: \(seen.joined(separator: " → ")) audioBytes=\(audioBytes)"); exit(0)
        }
        print("SELFTEST_FAIL geminismoke: seen=\(seen) audioBytes=\(audioBytes)"); exit(2)
    }
}
