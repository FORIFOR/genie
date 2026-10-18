import CoreLocation
import XCTest
@testable import GenieMac

@MainActor
final class BriefWeatherLocationTests: XCTestCase {
    func testBackgroundNeverRequestsUndeterminedPermission() {
        XCTAssertEqual(CurrentLocation.requestPolicy(status: .notDetermined, servicesEnabled: true,
                                                     allowPrompt: false), .refuse(.notAuthorized))
        XCTAssertEqual(CurrentLocation.requestPolicy(status: .notDetermined, servicesEnabled: true,
                                                     allowPrompt: true), .requestAuthorization)
        for status in [CLAuthorizationStatus.authorizedAlways] {
            XCTAssertEqual(CurrentLocation.requestPolicy(status: status, servicesEnabled: true,
                                                         allowPrompt: false), .locate)
        }
        for status in [CLAuthorizationStatus.denied, .restricted] {
            for allowPrompt in [false, true] {
                XCTAssertEqual(CurrentLocation.requestPolicy(status: status, servicesEnabled: true,
                                                             allowPrompt: allowPrompt), .refuse(.denied))
            }
        }
        XCTAssertEqual(CurrentLocation.requestPolicy(status: .authorizedAlways, servicesEnabled: false,
                                                     allowPrompt: true), .refuse(.denied))
    }

    func testLocationBecomesOnlyTwoDecimalCoordinates() throws {
        for (latitude, longitude, coarseLatitude, coarseLongitude) in [
            (35.681236, 139.767125, 35.68, 139.77),
            (-33.86882, -151.20929, -33.87, -151.21),
            (90.0, -180.0, 90.0, -180.0),
        ] {
            let result = BriefWeatherLocation.value(CLLocation(latitude: latitude, longitude: longitude))
            XCTAssertEqual(result["status"] as? String, "ok")
            XCTAssertEqual(result["latitude"] as? Double, coarseLatitude)
            XCTAssertEqual(result["longitude"] as? Double, coarseLongitude)
            XCTAssertEqual(Set(result.keys), ["status", "latitude", "longitude"])
            XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: result))
        }
    }

    func testInvalidLocationNeverReturnsCoordinates() {
        let badAccuracy = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 35, longitude: 139),
                                     altitude: 0, horizontalAccuracy: -1, verticalAccuracy: -1,
                                     timestamp: Date(timeIntervalSince1970: 0))
        for location in [CLLocation(latitude: 91, longitude: 0),
                         CLLocation(latitude: 0, longitude: 181), badAccuracy] {
            let result = BriefWeatherLocation.value(location)
            XCTAssertEqual(result["status"] as? String, "stale")
            XCTAssertEqual(Set(result.keys), ["status", "reason"])
        }
    }

    func testOldAndFutureFixesAreNotReportedAsCurrentLocation() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for (age, expected) in [(0.0, "ok"), (900.0, "ok"), (-5.0, "ok"),
                                (900.001, "stale"), (-5.001, "stale"), (1_800_000_000.0, "stale")] {
            let location = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 35.681236, longitude: 139.767125),
                                      altitude: 0, horizontalAccuracy: 100, verticalAccuracy: 100,
                                      timestamp: now.addingTimeInterval(-age))
            let result = BriefWeatherLocation.value(location, now: now)
            XCTAssertEqual(result["status"] as? String, expected)
            if expected == "stale" { XCTAssertEqual(Set(result.keys), ["status", "reason"]) }
        }
    }

    func testPromptFlagAndFixedFailureReasonsWithoutReadingDeviceLocation() async {
        for allowPrompt in [false, true] {
            var receivedPrompt: Bool?
            let result = await BriefWeatherLocation.input(allowPrompt: allowPrompt) { supplied in
                receivedPrompt = supplied
                return CLLocation(latitude: 35.681236, longitude: 139.767125)
            }
            XCTAssertEqual(receivedPrompt, allowPrompt)
            XCTAssertEqual(result["status"] as? String, "ok")
        }
        for failure in [CurrentLocation.Failure.notAuthorized, .denied] {
            let result = await BriefWeatherLocation.input(allowPrompt: false) { _ in throw failure }
            XCTAssertEqual(result["status"] as? String, "none")
            XCTAssertEqual(Set(result.keys), ["status", "reason"])
        }
        let privateError = NSError(domain: "do-not-expose-35.681236-139.767125", code: 1)
        let result = await BriefWeatherLocation.input(allowPrompt: false) { _ in throw privateError }
        XCTAssertEqual(result["status"] as? String, "stale")
        XCTAssertEqual(result["reason"] as? String, "現在地を取得できませんでした。時間をおいて更新してください")
        XCTAssertEqual(Set(result.keys), ["status", "reason"])
    }
}
