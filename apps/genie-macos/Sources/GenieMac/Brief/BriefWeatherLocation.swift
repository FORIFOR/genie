import CoreLocation
import Foundation

/// 日次まとめに渡す現在地は小数2桁だけ。取得は1回で、座標を保存・記録しない。
@MainActor
enum BriefWeatherLocation {
    static func input(allowPrompt: Bool = false) async -> [String: Any] {
        await input(allowPrompt: allowPrompt) { allowPrompt in
            try await CurrentLocation.shared.once(allowPrompt: allowPrompt)
        }
    }

    /// テストでは位置情報サービスを呼ばず、許可と失敗の境界を確かめる。
    static func input(allowPrompt: Bool,
                      read: (Bool) async throws -> CLLocation) async -> [String: Any] {
        do {
            return value(try await read(allowPrompt))
        } catch CurrentLocation.Failure.notAuthorized {
            return ["status": "none", "reason": "現在地の天気には位置情報の許可が必要です"]
        } catch CurrentLocation.Failure.denied {
            return ["status": "none", "reason": "位置情報が許可されていません"]
        } catch {
            return unavailable
        }
    }

    static func value(_ location: CLLocation, now: Date = Date()) -> [String: Any] {
        let coordinate = location.coordinate
        let age = now.timeIntervalSince(location.timestamp)
        guard coordinate.latitude.isFinite, coordinate.longitude.isFinite,
              CLLocationCoordinate2DIsValid(coordinate),
              location.horizontalAccuracy.isFinite, location.horizontalAccuracy >= 0,
              age.isFinite, age >= -5, age <= 15 * 60 else {
            return unavailable
        }
        return ["status": "ok",
                "latitude": (coordinate.latitude * 100).rounded() / 100,
                "longitude": (coordinate.longitude * 100).rounded() / 100]
    }

    private static var unavailable: [String: Any] {
        ["status": "stale", "reason": "現在地を取得できませんでした。時間をおいて更新してください"]
    }
}
