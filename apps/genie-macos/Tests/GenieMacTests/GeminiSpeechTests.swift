import XCTest
@testable import GenieMac

final class GeminiSpeechTests: XCTestCase {
    func testTheRequestAsksTheTTSModelForAWaveFileInTheSecretaryVoice() throws {
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: GeminiSpeech.requestBody(for: "はい、何でしょう。")) as? [String: Any])
        XCTAssertEqual(body["model"] as? String, "gemini-3.8-flash-tts")
        XCTAssertEqual((body["response_format"] as? [String: String])?["mime_type"], "audio/wav")
        let input = try XCTUnwrap(body["input"] as? [[String: Any]])
        let content = try XCTUnwrap(input.first?["content"] as? [[String: Any]])
        XCTAssertEqual(content.first?["text"] as? String, "はい、何でしょう。")
        let speech = try XCTUnwrap((body["generation_config"] as? [String: Any])?["speech_config"] as? [[String: String]])
        XCTAssertEqual(speech.first?["voice"], GeminiSpeech.voice)
    }

    func testTheLastAudioOfTheModelOutputIsUsed() throws {
        let wav = Data("RIFF....WAVE".utf8)
        let response: [String: Any] = ["steps": [
            ["type": "user_input", "content": [["type": "text", "text": "x"]]],
            ["type": "model_output", "content": [["type": "audio", "data": Data("old".utf8).base64EncodedString()],
                                                 ["type": "audio", "data": wav.base64EncodedString()]]],
        ]]
        XCTAssertEqual(try GeminiSpeech.audio(from: JSONSerialization.data(withJSONObject: response)), wav)
        XCTAssertThrowsError(try GeminiSpeech.audio(from: JSONSerialization.data(withJSONObject: ["steps": []])))
        XCTAssertThrowsError(try GeminiSpeech.audio(from: Data("not json".utf8)))
    }

    func testTheSameSentenceReusesOneStoredVoice() {
        XCTAssertEqual(GeminiSpeech.cacheURL(for: "はい"), GeminiSpeech.cacheURL(for: "はい"))
        XCTAssertNotEqual(GeminiSpeech.cacheURL(for: "はい"), GeminiSpeech.cacheURL(for: "いいえ"))
        XCTAssertEqual(GeminiSpeech.cacheURL(for: "はい").pathExtension, "wav")
    }

    func testWithoutAKeyNothingIsSentAndItStaysSilent() async {
        do { _ = try await GeminiSpeech.synthesize("鍵のない時の確認 \(UUID())", apiKey: nil); XCTFail("should not speak") }
        catch { XCTAssertEqual(String(describing: error), "Gemini のキーがありません") }
    }
}
