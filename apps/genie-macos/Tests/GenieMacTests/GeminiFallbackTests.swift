import XCTest
@testable import GenieMac

/// 会話は Gemini Live だけ。標準の会話には切り替えない（2026-10-04 本人の指示: 標準の音声認識は一切使わない）。
@MainActor
final class GeminiFallbackTests: XCTestCase {
    private func settings() -> (GeminiLiveSettings, UserDefaults) {
        let suite = "gemini-fallback-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(true, forKey: "genie.geminiLive.enabled")
        defaults.set(60, forKey: "genie.geminiLive.monthlyMinutes")
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return (GeminiLiveSettings(defaults: defaults, initialHasKey: true), defaults)
    }

    func testCreditAndQuotaClosesAreBillingNotKeyProblems() {
        let credits = GeminiLive.fatalCloseMessage(code: 1011, reason: "Your prepayment credits are depleted. Please go to AI Studio")
        let quota = GeminiLive.fatalCloseMessage(code: 1011, reason: "You exceeded your current quota")
        let key = GeminiLive.fatalCloseMessage(code: 1008, reason: "API key not valid")
        XCTAssertTrue(GeminiLive.isBillingUnavailable(credits ?? ""))
        XCTAssertTrue(GeminiLive.isBillingUnavailable(quota ?? ""))
        XCTAssertFalse(GeminiLive.isBillingUnavailable(key ?? ""))
        XCTAssertFalse(GeminiLive.isBillingUnavailable("Gemini との接続が切れました。"))
    }

    func testConversationNeedsGeminiLiveAndNeverPausesIntoAnotherPath() {
        let (gemini, defaults) = settings()
        XCTAssertTrue(gemini.canConverse)
        gemini.setEnabled(false)
        XCTAssertFalse(gemini.canConverse)
        let noKey = GeminiLiveSettings(defaults: defaults, initialHasKey: false)
        XCTAssertFalse(noKey.canConverse)
    }

    func testTheReasonIsShownWhenGeminiLiveCannotBeUsed() {
        XCTAssertTrue(Facts.geminiLiveOff.contains("Gemini Live"))
        XCTAssertTrue(Facts.geminiLiveNoKey.contains("API キー"))
    }
}
