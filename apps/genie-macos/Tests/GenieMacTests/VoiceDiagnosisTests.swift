import XCTest
@testable import GenieMac

/// U109「声が返ってこない。何が原因？」
@MainActor
final class VoiceDiagnosisTests: XCTestCase {
    func testItIsAskedForInPlainWords() {
        for text in ["声が返ってこない", "ジーニーが反応しない", "返事が聞こえない", "診断して", "なぜ反応しないの？"] {
            XCTAssertTrue(VoiceDiagnosis.isRequest(text), text)
        }
        for text in ["天気を教えて", "声の大きさを変えて"] { XCTAssertFalse(VoiceDiagnosis.isRequest(text), text) }
    }

    func testEachCauseIsNamedWithAFix() async {
        let suite = "genie.test.diagnosis.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let noKey = GeminiLiveSettings(defaults: defaults, initialHasKey: false)
        let items = await VoiceDiagnosis.run(gemini: noKey, ping: { _ in 200 })
        let key = items.first { $0.name == "Gemini のキー" }
        XCTAssertEqual(key?.ok, false)
        XCTAssertNotNil(key?.fix)
        XCTAssertNil(items.first { $0.name == "Gemini の利用" }, "without a key Google is not called")
        XCTAssertTrue(VoiceDiagnosis.summary(items).contains("Gemini のキー"))
    }

    func testAllGoodSaysSoInOneSentence() {
        let ok = [VoiceDiagnosis.Item(ok: true, name: "マイク", detail: "許可されています", fix: nil)]
        XCTAssertEqual(VoiceDiagnosis.summary(ok), "マイク・呼びかけ・Gemini・接続はすべて正常です。")
    }
}
