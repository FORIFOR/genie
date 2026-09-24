import XCTest
@testable import GenieMac

final class VoiceSessionPolicyTests: XCTestCase {
    func testFiveMinuteHardLimitWins() {
        let policy = VoiceSessionPolicy(maximumDuration: 300, idleTimeout: 90)
        let start = Date(timeIntervalSince1970: 1_000)
        let recent = start.addingTimeInterval(290)
        XCTAssertEqual(policy.expiry(startedAt: start, lastActivityAt: recent),
                       start.addingTimeInterval(300))
    }

    func testIdleTimeoutEndsBeforeHardLimit() {
        let policy = VoiceSessionPolicy(maximumDuration: 300, idleTimeout: 90)
        let start = Date(timeIntervalSince1970: 1_000)
        let recent = start.addingTimeInterval(20)
        XCTAssertEqual(policy.expiry(startedAt: start, lastActivityAt: recent),
                       recent.addingTimeInterval(90))
    }

    func testRecentActivityExtendsOnlyUpToHardLimit() {
        let policy = VoiceSessionPolicy(maximumDuration: 300, idleTimeout: 90)
        let start = Date(timeIntervalSince1970: 1_000)
        let recent = start.addingTimeInterval(250)
        let now = start.addingTimeInterval(260)
        XCTAssertEqual(policy.remaining(startedAt: start, lastActivityAt: recent, now: now), 40, accuracy: 0.001)
    }

    func testExpiredSessionReportsInactive() {
        let policy = VoiceSessionPolicy(maximumDuration: 300, idleTimeout: 90)
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(policy.shouldRemainActive(
            startedAt: start,
            lastActivityAt: start,
            now: start.addingTimeInterval(91)
        ))
    }
}
