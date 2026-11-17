import XCTest
@testable import GenieMac

final class GenieLogTests: XCTestCase {
    func testLongUtterancesAreClippedToTheirStart() {
        XCTAssertEqual(GenieLog.clip("短い"), "短い")
        XCTAssertEqual(GenieLog.clip(String(repeating: "あ", count: 50), 10), String(repeating: "あ", count: 10) + "…")
        XCTAssertEqual(GenieLog.clip("一行目\n二行目"), "一行目 二行目")
    }

    func testTheLogLivesInTheUsersLogsFolder() {
        XCTAssertTrue(GenieLog.url.path.hasSuffix("Library/Logs/Genie/genie.log"))
    }
}
