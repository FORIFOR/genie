import CoreLocation
import Foundation

/// いまの位置を 1 回だけ取る。近くの店を頼まれたときにだけ呼ぶ（常に追いかけない）。
///
/// 許可は OS のダイアログで本人が決める（Genie は自動で許可しない）。拒否・未決定のまま・10 秒で取れない
/// ときは理由を返し、カードの代わりに次の一手を出す。
@MainActor
final class CurrentLocation: NSObject, CLLocationManagerDelegate {
    static let shared = CurrentLocation()

    enum Failure: Error, Equatable {
        case denied
        case unavailable
    }

    private let manager = CLLocationManager()
    private var waiting: [CheckedContinuation<CLLocation, Error>] = []
    private var timeout: Task<Void, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    /// 許可が拒否・制限されているか（聞く前に分かるもの）。
    var isDenied: Bool {
        switch manager.authorizationStatus {
        case .denied, .restricted: return true
        default: return false
        }
    }

    func once(timeoutSeconds: Double = 10) async throws -> CLLocation {
        guard CLLocationManager.locationServicesEnabled(), !isDenied else { throw Failure.denied }
        return try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
            guard waiting.count == 1 else { return }
            if manager.authorizationStatus == .notDetermined {
                manager.requestWhenInUseAuthorization()   // 決まると didChangeAuthorization から requestLocation
            } else {
                manager.requestLocation()
            }
            timeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeoutSeconds))
                guard !Task.isCancelled else { return }
                self?.finish(.failure(Failure.unavailable))
            }
        }
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        timeout?.cancel(); timeout = nil
        let all = waiting; waiting.removeAll()
        for c in all { c.resume(with: result) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            guard !self.waiting.isEmpty else { return }
            switch manager.authorizationStatus {
            case .denied, .restricted: self.finish(.failure(Failure.denied))
            case .notDetermined: break
            default: manager.requestLocation()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        Task { @MainActor in self.finish(.success(last)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor in self.finish(.failure(denied ? Failure.denied : Failure.unavailable)) }
    }
}
