import XCTest
@testable import GenieMac

/// Gemini のクレジット切れ・利用枠の上限では、止めずに標準の会話へ切り替える（2026-10-03 本人の指示）。
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

    func testAfterRunningOutOfCreditsConversationUsesTheStandardPathForAWhile() {
        let (gemini, _) = settings()
        let now = Date()
        XCTAssertTrue(gemini.usableForConversation(at: now))
        gemini.pauseForBilling(at: now)
        XCTAssertFalse(gemini.usableForConversation(at: now.addingTimeInterval(60)))
        XCTAssertFalse(gemini.usableForConversation(at: now.addingTimeInterval(GeminiLiveSettings.billingPause - 60)))
        // Time passes: try Gemini again (whether credits were added cannot be known from here).
        XCTAssertTrue(gemini.usableForConversation(at: now.addingTimeInterval(GeminiLiveSettings.billingPause + 1)))
    }

    func testSettingANewKeyTriesGeminiAgainAtOnce() {
        let (gemini, _) = settings()
        gemini.pauseForBilling()
        gemini.clearBillingPause()
        XCTAssertTrue(gemini.usableForConversation())
    }

    func testTheSwitchIsShownInWords() {
        XCTAssertTrue(Facts.conversationSwitchedFromGemini.contains("標準の会話に切り替えました"))
    }
}
