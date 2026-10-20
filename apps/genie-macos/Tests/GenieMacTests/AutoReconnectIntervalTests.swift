import XCTest
@testable import GenieMac

/// この Mac の中のサービスを起動し直したあと、入り直すまでの間。
@MainActor
final class AutoReconnectIntervalTests: XCTestCase {
    func testStartsShortAndNeverExceedsFiveMinutes() {
        let intervals = (0..<7).map { MainData.autoReconnectInterval(after: $0) }
        XCTAssertEqual(intervals, [30, 60, 120, 240, 300, 300, 300])
    }
}
