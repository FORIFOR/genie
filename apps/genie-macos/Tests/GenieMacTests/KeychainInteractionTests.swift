import XCTest
import Security
import LocalAuthentication
@testable import GenieMac

final class KeychainInteractionTests: XCTestCase {
    func testQueryDisablesInteractionWithoutChangingServiceOrRequestingData() throws {
        let query = KeychainStore.noninteractiveQuery(service: "fixture-service", account: "fixture-account")
        XCTAssertEqual(query[kSecAttrService as String] as? String, "fixture-service")
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "fixture-account")
        XCTAssertTrue(try XCTUnwrap(query[kSecUseAuthenticationContext as String] as? LAContext).interactionNotAllowed)
        XCTAssertNil(query[kSecReturnData as String])
        XCTAssertEqual(KeychainStore.error(errSecInteractionNotAllowed), .interactionRequired)
        XCTAssertEqual(KeychainStore.error(errSecAuthFailed), .accessDenied)
    }

    func testSuccessfulAndThrowingOperationsRestorePriorState() throws {
        enum Failure: Error { case fixture }
        for original in [true, false] {
            var allowed = original
            let guarder = KeychainInteractionGuard(readAllowed: { allowed }, setAllowed: { allowed = $0 })
            let result = try guarder.perform { XCTAssertFalse(allowed); return "synthetic" }
            XCTAssertEqual(result, "synthetic"); XCTAssertEqual(allowed, original)
            XCTAssertThrowsError(try guarder.perform { XCTAssertFalse(allowed); throw Failure.fixture })
            XCTAssertEqual(allowed, original)
            XCTAssertTrue(try guarder.perform { !allowed })
        }
    }

    func testPolicySetupFailureNeverRunsOperation() {
        var ran = false
        let guarder = KeychainInteractionGuard(readAllowed: { true }, setAllowed: { _ in throw KeychainStore.KeychainError.interactionPolicy(-1) })
        XCTAssertThrowsError(try guarder.perform { ran = true })
        XCTAssertFalse(ran)
    }

    func testRestoreFailureDoesNotReturnSecretOrAllowLaterOperations() {
        var allowed = true, writes: [Bool] = [], runs = 0
        let guarder = KeychainInteractionGuard(readAllowed: { allowed }, setAllowed: { value in
            writes.append(value)
            if value { throw KeychainStore.KeychainError.interactionPolicy(-1) }
            allowed = value
        })
        XCTAssertThrowsError(try guarder.perform { runs += 1; return "synthetic-secret" })
        XCTAssertEqual(writes, [false, true, false]); XCTAssertFalse(allowed)
        XCTAssertThrowsError(try guarder.perform { runs += 1 })
        XCTAssertEqual(runs, 1)
    }

    func testConcurrentOwnedOperationsRemainSerialized() {
        let group = DispatchGroup()
        var allowed = true, operations = 0, observedInteractive = false
        let guarder = KeychainInteractionGuard(readAllowed: { allowed }, setAllowed: { allowed = $0 })
        for _ in 0..<8 {
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                try? guarder.perform {
                    observedInteractive = observedInteractive || allowed
                    operations += 1
                    Thread.sleep(forTimeInterval: 0.003)
                    observedInteractive = observedInteractive || allowed
                }
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(operations, 8); XCTAssertFalse(observedInteractive); XCTAssertTrue(allowed)
    }

    func testExplicitReadRestoresPriorPolicyAfterSuccessAndUserCancellation() throws {
        for original in [false, true] {
            var allowed = original
            let guarder = KeychainInteractionGuard(readAllowed: { allowed }, setAllowed: { allowed = $0 })
            XCTAssertTrue(try guarder.perform(allowInteraction: true) { allowed })
            XCTAssertEqual(allowed, original)
            XCTAssertThrowsError(try guarder.perform(allowInteraction: true) {
                XCTAssertTrue(allowed); throw KeychainStore.error(errSecUserCanceled)
            })
            XCTAssertEqual(allowed, original)
        }
    }

    func testOutstandingOSConfirmationMakesOtherOwnedOperationsBusyWithoutBlockingMainActor() async throws {
        let entered = expectation(description: "synthetic OS confirmation started")
        let finished = expectation(description: "synthetic OS confirmation finished")
        let release = DispatchSemaphore(value: 0)
        var allowed = false
        let guarder = KeychainInteractionGuard(readAllowed: { allowed }, setAllowed: { allowed = $0 })
        DispatchQueue.global().async {
            defer { finished.fulfill() }
            try? guarder.perform(allowInteraction: true) {
                XCTAssertTrue(allowed); entered.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 3), .success)
            }
        }
        await fulfillment(of: [entered], timeout: 2)
        try await MainActor.run {
            XCTAssertThrowsError(try guarder.perform { XCTFail("must not read/write/delete while interactive read is pending") }) {
                XCTAssertEqual($0 as? KeychainStore.KeychainError, .operationInProgress)
            }
        }
        for interactive in [false, true] {
            XCTAssertThrowsError(try guarder.perform(allowInteraction: interactive) { XCTFail("no queued second attempt") }) {
                XCTAssertEqual($0 as? KeychainStore.KeychainError, .operationInProgress)
            }
        }
        release.signal()
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertFalse(allowed)
        XCTAssertTrue(try guarder.perform { !allowed })
    }
}
