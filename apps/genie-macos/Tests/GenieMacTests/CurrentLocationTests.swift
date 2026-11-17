import CoreLocation
import XCTest
@testable import GenieMac

@MainActor
final class CurrentLocationTests: XCTestCase {
    /// No CLLocationManager is created by these tests; only synthetic locations
    /// and explicit delegate events enter the production request state machine.
    @MainActor private final class Device {
        var status: CLAuthorizationStatus = .notDetermined
        var servicesEnabled = true
        var authorizationRequests = 0
        var locationRequests = 0

        func makeSubject() -> CurrentLocation {
            CurrentLocation(access: .init(
                authorizationStatus: { self.status },
                servicesEnabled: { self.servicesEnabled },
                requestAuthorization: { self.authorizationRequests += 1 },
                requestLocation: { self.locationRequests += 1 }))
        }
    }

    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    private func assertUnavailable(_ task: Task<CLLocation, Error>, file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await task.value; XCTFail("Expected bounded unavailability", file: file, line: line) }
        catch { XCTAssertEqual(error as? CurrentLocation.Failure, .unavailable, file: file, line: line) }
    }

    func testColdLaunchWaitsForInitialAuthorizedEventWithoutPrompting() async throws {
        let device = Device()
        let subject = device.makeSubject()
        let request = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        await settle()
        XCTAssertEqual(device.locationRequests, 0)
        XCTAssertEqual(device.authorizationRequests, 0)

        device.status = .authorizedAlways
        subject.authorizationDidChange()
        await settle()
        XCTAssertEqual(device.locationRequests, 1)
        XCTAssertEqual(device.authorizationRequests, 0)
        let location = CLLocation(latitude: 35, longitude: 139)
        subject.receivedLocation(location)
        let result = try await request.value
        XCTAssertEqual(result.coordinate.latitude, 35)
    }

    func testInitialEventIsRememberedWithoutPendingRequest() async throws {
        let device = Device()
        let subject = device.makeSubject()
        device.status = .authorizedAlways
        subject.authorizationDidChange()
        XCTAssertEqual(device.locationRequests, 0)
        let request = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        await settle()
        XCTAssertEqual(device.locationRequests, 1)
        subject.receivedLocation(CLLocation(latitude: 35, longitude: 139))
        _ = try await request.value
        XCTAssertEqual(device.authorizationRequests, 0)
    }

    func testConfirmedUndeterminedBackgroundRequestNeverRequestsConsentOrLocation() async {
        let device = Device()
        let subject = device.makeSubject()
        let request = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        await settle()
        subject.authorizationDidChange()
        do { _ = try await request.value; XCTFail("Expected an explicit consent requirement") }
        catch { XCTAssertEqual(error as? CurrentLocation.Failure, .notAuthorized) }
        XCTAssertEqual(device.authorizationRequests, 0)
        XCTAssertEqual(device.locationRequests, 0)
    }

    func testNoInitialCallbackTimesOutWithoutLocationOrConsent() async {
        let device = Device()
        device.status = .authorizedAlways
        let subject = device.makeSubject()
        let request = Task { try await subject.once(timeoutSeconds: 0.03, allowPrompt: false) }
        await assertUnavailable(request)
        subject.authorizationDidChange() // A late initial event cannot start the expired request.
        await settle()
        XCTAssertEqual(device.authorizationRequests, 0)
        XCTAssertEqual(device.locationRequests, 0)
    }

    func testInitialWaitAndLocationReadShareOneDeadline() async throws {
        let device = Device()
        let subject = device.makeSubject()
        let started = ContinuousClock.now
        let request = Task { try await subject.once(timeoutSeconds: 0.3, allowPrompt: false) }
        await settle()
        try await Task.sleep(for: .milliseconds(200))
        device.status = .authorizedAlways
        subject.authorizationDidChange()
        await assertUnavailable(request)
        // Resetting the location timeout after initialization would take >=0.5s.
        XCTAssertLessThan(started.duration(to: ContinuousClock.now), .milliseconds(450))
        XCTAssertEqual(device.locationRequests, 1)
        XCTAssertEqual(device.authorizationRequests, 0)
    }

    func testConcurrentRequestsKeepTheirOwnPermissionPolicy() async throws {
        let device = Device()
        let subject = device.makeSubject()
        let background = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        let explicit = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: true) }
        await settle()
        subject.authorizationDidChange()
        do { _ = try await background.value; XCTFail("Background must not join a consent request") }
        catch { XCTAssertEqual(error as? CurrentLocation.Failure, .notAuthorized) }
        await settle()
        XCTAssertEqual(device.authorizationRequests, 1)
        XCTAssertEqual(device.locationRequests, 0)
        device.status = .authorizedAlways
        subject.authorizationDidChange()
        XCTAssertEqual(device.locationRequests, 1)
        subject.receivedLocation(CLLocation(latitude: 35, longitude: 139))
        _ = try await explicit.value
    }

    func testConcurrentAuthorizedRequestsShareOneLocationRead() async throws {
        let device = Device()
        let subject = device.makeSubject()
        let first = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        let second = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        await settle()
        device.status = .authorizedAlways
        subject.authorizationDidChange()
        await settle()
        subject.authorizationDidChange() // Repeated notifications must not duplicate the read.
        XCTAssertEqual(device.locationRequests, 1)
        XCTAssertEqual(device.authorizationRequests, 0)
        subject.receivedLocation(CLLocation(latitude: 35, longitude: 139))
        _ = try await first.value
        _ = try await second.value
    }

    func testShorterDeadlineJoiningLocationReadShortensTheSharedTimeout() async {
        let device = Device()
        let subject = device.makeSubject()
        device.status = .authorizedAlways
        subject.authorizationDidChange()
        let long = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        await settle()
        XCTAssertEqual(device.locationRequests, 1)
        let joinedAt = ContinuousClock.now
        let short = Task { try await subject.once(timeoutSeconds: 0.05, allowPrompt: false) }
        await assertUnavailable(long)
        await assertUnavailable(short)
        XCTAssertLessThan(joinedAt.duration(to: ContinuousClock.now), .milliseconds(250))
        XCTAssertEqual(device.locationRequests, 1)
        XCTAssertEqual(device.authorizationRequests, 0)
    }

    func testCancelledInitialWaitCannotStartAfterLateAuthorization() async throws {
        let device = Device()
        let subject = device.makeSubject()
        let cancelled = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        await settle()
        cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        device.status = .authorizedAlways
        subject.authorizationDidChange()
        await settle()
        XCTAssertEqual(device.locationRequests, 0)
        XCTAssertEqual(device.authorizationRequests, 0)
        let next = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        await settle()
        XCTAssertEqual(device.locationRequests, 1)
        subject.receivedLocation(CLLocation(latitude: 35, longitude: 139))
        _ = try await next.value
    }

    func testCancellingOneInitialWaiterPreservesTheOther() async throws {
        let device = Device()
        let subject = device.makeSubject()
        let cancelled = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        let kept = Task { try await subject.once(timeoutSeconds: 1, allowPrompt: false) }
        await settle()
        cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        device.status = .authorizedAlways
        subject.authorizationDidChange()
        await settle()
        XCTAssertEqual(device.locationRequests, 1)
        subject.receivedLocation(CLLocation(latitude: 35, longitude: 139))
        _ = try await kept.value
        XCTAssertEqual(device.authorizationRequests, 0)
    }

    func testConfirmedDeniedStillRefusesBothRequestModes() async {
        for allowPrompt in [false, true] {
            let device = Device()
            let subject = device.makeSubject()
            device.status = .denied
            subject.authorizationDidChange()
            do { _ = try await subject.once(timeoutSeconds: 1, allowPrompt: allowPrompt); XCTFail("Expected denial") }
            catch { XCTAssertEqual(error as? CurrentLocation.Failure, .denied) }
            XCTAssertEqual(device.authorizationRequests, 0)
            XCTAssertEqual(device.locationRequests, 0)
        }
    }
}
