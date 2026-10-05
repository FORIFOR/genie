import XCTest
@testable import GenieMac

@MainActor
final class WakeControllerTests: XCTestCase {
    func testAfterABillingFailureOnlyTheUsersOwnActionReconnects() {
        let wake = WakeController(hub: VoiceInputHub(mic: nil))
        XCTAssertNil(wake.billingBlocked)
        wake.noteBillingFailure("Gemini の前払いクレジットが残っていません。")
        XCTAssertNotNil(wake.billingBlocked, "a detected call must not reconnect after a billing failure")
        wake.clearBillingFailure()
        XCTAssertNil(wake.billingBlocked)
    }
}
