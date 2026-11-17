import CoreLocation
import Foundation

/// いまの位置を 1 回だけ取る。近くの店や現在地の天気で使う（常に追いかけない）。
///
/// 許可は OS のダイアログで本人が決める（Genie は自動で許可しない）。拒否・未決定のまま・10 秒で取れない
/// ときは理由を返し、カードの代わりに次の一手を出す。
@MainActor
final class CurrentLocation: NSObject, CLLocationManagerDelegate {
    static let shared = CurrentLocation()

    enum Failure: Error, Equatable {
        case denied
        case notAuthorized
        case unavailable
    }

    enum RequestPolicy: Equatable {
        case locate
        case requestAuthorization
        case refuse(Failure)
    }

    /// 定期処理では、許可が未決定のときに OS の確認を開かない。
    static func requestPolicy(status: CLAuthorizationStatus, servicesEnabled: Bool,
                              allowPrompt: Bool) -> RequestPolicy {
        guard servicesEnabled else { return .refuse(.denied) }
        switch status {
        case .authorizedAlways, .authorizedWhenInUse: return .locate
        case .notDetermined: return allowPrompt ? .requestAuthorization : .refuse(.notAuthorized)
        case .denied, .restricted: return .refuse(.denied)
        @unknown default: return .refuse(.unavailable)
        }
    }

    /// The same request flow is exercised with a device-free access layer in tests.
    struct Access {
        let authorizationStatus: () -> CLAuthorizationStatus
        let servicesEnabled: () -> Bool
        let requestAuthorization: () -> Void
        let requestLocation: () -> Void
    }

    private let manager: CLLocationManager?
    private let access: Access
    private var authorizationReady = false
    private var authorizationWaiters: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var authorizationTimeouts: [UUID: Task<Void, Never>] = [:]
    private var waiting: [CheckedContinuation<CLLocation, Error>] = []
    private var timeout: Task<Void, Never>?
    private var locationDeadline: ContinuousClock.Instant?
    private var locationRequested = false

    override init() {
        let manager = CLLocationManager()
        self.manager = manager
        self.access = Access(authorizationStatus: { manager.authorizationStatus },
                             servicesEnabled: { CLLocationManager.locationServicesEnabled() },
                             requestAuthorization: { manager.requestWhenInUseAuthorization() },
                             requestLocation: { manager.requestLocation() })
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    init(access: Access) {
        self.manager = nil
        self.access = access
        super.init()
    }

    /// 許可が拒否・制限されているか（聞く前に分かるもの）。
    var isDenied: Bool {
        switch access.authorizationStatus() {
        case .denied, .restricted: return true
        default: return false
        }
    }

    func once(timeoutSeconds: Double = 10, allowPrompt: Bool = true) async throws -> CLLocation {
        let deadline = ContinuousClock.now.advanced(by: .seconds(timeoutSeconds))
        // A newly created manager can report notDetermined before its initial
        // delegate notification. Do not mistake initialization for missing consent.
        try await awaitInitialAuthorization(until: deadline)
        try Task.checkCancellation()
        guard ContinuousClock.now < deadline else { throw Failure.unavailable }
        let policy = Self.requestPolicy(status: access.authorizationStatus(),
                                        servicesEnabled: access.servicesEnabled(),
                                        allowPrompt: allowPrompt)
        if case .refuse(let failure) = policy { throw failure }
        return try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
            armLocationTimeout(until: deadline)
            guard waiting.count == 1 else { return }
            if policy == .requestAuthorization {
                access.requestAuthorization()   // 決まると didChangeAuthorization から requestLocation
            } else {
                requestLocationIfNeeded()
            }
        }
    }

    private func armLocationTimeout(until deadline: ContinuousClock.Instant) {
        // Initial-authorization continuations may resume in any order. A later
        // arrival must not extend an earlier caller's total time budget.
        if let locationDeadline, locationDeadline <= deadline { return }
        locationDeadline = deadline
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await ContinuousClock().sleep(until: deadline)
            guard !Task.isCancelled else { return }
            self?.finish(.failure(Failure.unavailable))
        }
    }

    private func awaitInitialAuthorization(until deadline: ContinuousClock.Instant) async throws {
        guard !authorizationReady else { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                guard !Task.isCancelled else { continuation.resume(throwing: CancellationError()); return }
                guard !authorizationReady else { continuation.resume(); return }
                authorizationWaiters[id] = continuation
                authorizationTimeouts[id] = Task { [weak self] in
                    try? await ContinuousClock().sleep(until: deadline)
                    guard !Task.isCancelled else { return }
                    self?.finishInitialAuthorization(id, result: .failure(Failure.unavailable))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finishInitialAuthorization(id, result: .failure(CancellationError()))
            }
        }
    }

    private func finishInitialAuthorization(_ id: UUID, result: Result<Void, Error>) {
        authorizationTimeouts.removeValue(forKey: id)?.cancel()
        authorizationWaiters.removeValue(forKey: id)?.resume(with: result)
    }

    private func requestLocationIfNeeded() {
        guard !locationRequested else { return }
        locationRequested = true
        access.requestLocation()
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        timeout?.cancel(); timeout = nil
        locationDeadline = nil
        locationRequested = false
        let all = waiting; waiting.removeAll()
        for c in all { c.resume(with: result) }
    }

    /// Called for the initial delegate notification even when no location is pending.
    func authorizationDidChange() {
        authorizationReady = true
        for id in Array(authorizationWaiters.keys) {
            finishInitialAuthorization(id, result: .success(()))
        }
        guard !waiting.isEmpty else { return }
        switch access.authorizationStatus() {
        case .denied, .restricted: finish(.failure(Failure.denied))
        case .notDetermined: break
        case .authorizedAlways, .authorizedWhenInUse: requestLocationIfNeeded()
        @unknown default: finish(.failure(Failure.unavailable))
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.authorizationDidChange() }
    }

    func receivedLocation(_ location: CLLocation) { finish(.success(location)) }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        Task { @MainActor in self.receivedLocation(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor in self.finish(.failure(denied ? Failure.denied : Failure.unavailable)) }
    }
}
