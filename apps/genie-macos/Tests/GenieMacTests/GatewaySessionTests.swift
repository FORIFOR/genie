import XCTest
import GenieCore
@testable import GenieMac

final class GatewaySessionTests: XCTestCase {
    private func token(_ n: Int) -> Tokens { Tokens(accessToken: "access-\(n)", refreshToken: "refresh-\(n)", deviceToken: "same-device", expiresIn: 900) }

    func testExplicitCredentialReadIsOneBackgroundReadWithoutAuthenticationOrWrites() async throws {
        let readStarted = expectation(description: "one existing-item read")
        readStarted.assertForOverFulfill = true
        let session = GatewaySession(read: { XCTFail("passive tokens read is not recovery"); return nil },
            save: { _ in XCTFail("no save") }, signIn: { XCTFail("no sign-in"); return self.token(0) },
            exchange: { _ in XCTFail("no refresh"); return self.token(0) }, readAfterUserRequest: {
                XCTAssertFalse(Thread.isMainThread)
                readStarted.fulfill()
                Thread.sleep(forTimeInterval: 0.1)
                return .init(refreshToken: "synthetic-existing", deviceToken: "synthetic-device")
            })
        async let first = session.confirmCredentialReadAfterUserRequest()
        await fulfillment(of: [readStarted], timeout: 2)
        async let second = session.confirmCredentialReadAfterUserRequest()
        do { _ = try await session.tokens(); XCTFail("cannot authenticate while OS confirmation is active") }
        catch { XCTAssertEqual(error as? KeychainStore.KeychainError, .operationInProgress) }
        let results = try await [first, second]
        XCTAssertEqual(results, [true, true])
    }

    func testExplicitCredentialReadCannotTreatMissingOrMalformedItemsAsSuccess() async throws {
        for value in [nil, GatewaySession.Credentials(refreshToken: "", deviceToken: "device")] {
            let session = GatewaySession(read: { XCTFail("no passive read"); return nil }, save: { _ in XCTFail("no save") },
                signIn: { XCTFail("no sign-in"); return self.token(0) }, exchange: { _ in XCTFail("no refresh"); return self.token(0) },
                readAfterUserRequest: { value })
            do {
                let read = try await session.confirmCredentialReadAfterUserRequest()
                XCTAssertNil(value); XCTAssertFalse(read)
            } catch { XCTAssertNotNil(value); XCTAssertTrue(error is GatewaySession.SessionError) }
        }
    }

    func testExplicitReconnectRepairsAnUncertainSessionWithoutErasingItOnFailure() async throws {
        var stored = GatewaySession.Credentials(refreshToken: "old", deviceToken: "same", pending: true)
        var attempts = 0, available = false
        let session = GatewaySession(read: { stored }, save: { stored = $0 }, signIn: {
            attempts += 1
            if !available { throw URLError(.notConnectedToInternet) }
            return self.token(2)
        }, exchange: { _ in XCTFail("uncertain refresh must not be replayed"); return self.token(0) })
        do { _ = try await session.tokens(); XCTFail("must need reconnect") } catch {}
        XCTAssertEqual(attempts, 0)
        do { _ = try await session.tokens(reauthenticate: true); XCTFail("offline") } catch {}
        XCTAssertEqual(stored.refreshToken, "old")
        available = true
        let result = try await session.tokens(reauthenticate: true)
        XCTAssertEqual(result.accessToken, "access-2")
        XCTAssertEqual(stored.refreshToken, "refresh-2")
        XCTAssertNil(stored.pending)
        _ = try await session.tokens()
        XCTAssertEqual(attempts, 2)
    }

    func testConcurrentRenewalAndRelaunchPreserveDeviceAndUseRotatedToken() async throws {
        var credentials: GatewaySession.Credentials?
        var signIns = 0, rotations = 0
        var now = Date()
        let create = { GatewaySession(read: { credentials }, save: { credentials = $0 }, signIn: {
            signIns += 1; return self.token(1)
        }, exchange: { refresh in
            rotations += 1
            XCTAssertEqual(refresh, "refresh-\(rotations)")
            try await Task.sleep(for: .milliseconds(20))
            return self.token(rotations + 1)
        }, now: { now }) }
        let session = create()
        _ = try await session.tokens()
        now = now.addingTimeInterval(800)
        let values = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<12 { group.addTask { try await session.tokens().accessToken } }
            var out: [String] = []; for try await token in group { out.append(token) }; return out
        }
        XCTAssertEqual(Set(values), ["access-2"])
        XCTAssertEqual(rotations, 1); XCTAssertEqual(signIns, 1)
        let relaunched = create()
        let next = try await relaunched.tokens()
        XCTAssertEqual(next.accessToken, "access-3")
        XCTAssertEqual(next.deviceToken, "same-device"); XCTAssertEqual(signIns, 1)
    }

    func testLostRefreshResponseNeverReplaysRefreshOrCreatesAnotherDevice() async {
        var calls = 0, signIns = 0
        let session = GatewaySession(read: { .init(refreshToken: "stored", deviceToken: "device") }, save: { _ in }, signIn: {
            signIns += 1; return self.token(1)
        }, exchange: { _ in calls += 1; throw URLError(.networkConnectionLost) })
        for _ in 0..<3 {
            do { _ = try await session.tokens(); XCTFail("must fail visibly") } catch { }
        }
        XCTAssertEqual(calls, 1); XCTAssertEqual(signIns, 0)
    }

    func testInterruptedRenewalIsNotReplayedAfterRestart() async {
        var stored = GatewaySession.Credentials(refreshToken: "old", deviceToken: "same")
        var requests = 0
        let create = { GatewaySession(read: { stored }, save: { stored = $0 }, signIn: { self.token(0) }, exchange: { _ in
            requests += 1; throw URLError(.networkConnectionLost)
        }) }
        for _ in 0..<2 { do { _ = try await create().tokens(); XCTFail("must not reuse") } catch {} }
        XCTAssertEqual(requests, 1)
        XCTAssertEqual(stored.pending, true)
    }

    func testAccessTokenIsNotReturnedIfRotatedCredentialsCannotBeSaved() async {
        var attempts = 0
        let session = GatewaySession(read: { .init(refreshToken: "stored", deviceToken: "device") }, save: { _ in throw URLError(.cannotWriteToFile) }, signIn: { self.token(0) }, exchange: { _ in attempts += 1; return self.token(2) })
        for _ in 0..<2 { do { _ = try await session.tokens(); XCTFail("save failure must not look connected") } catch {} }
        XCTAssertEqual(attempts, 0)
    }
    func testDeniedStoredCredentialsNeverBecomeMissingOrNewSession() async throws {
        var accessible = false, reads = 0, signIns = 0, exchanges = 0, saves = 0
        let session = GatewaySession(read: {
            reads += 1
            guard accessible else { throw KeychainStore.KeychainError.interactionRequired }
            return .init(refreshToken: "existing", deviceToken: "same")
        }, save: { _ in saves += 1 }, signIn: { signIns += 1; return self.token(0) }, exchange: { value in
            XCTAssertEqual(value, "existing"); exchanges += 1; return self.token(2)
        })
        for reconnect in [false, true] {
            do { _ = try await session.tokens(reauthenticate: reconnect); XCTFail("must require Keychain access") }
            catch GatewaySession.SessionError.credentialAccessRequired { }
        }
        XCTAssertEqual(reads, 2); XCTAssertEqual(signIns, 0); XCTAssertEqual(exchanges, 0); XCTAssertEqual(saves, 0)
        accessible = true
        let result = try await session.tokens()
        XCTAssertEqual(result.accessToken, "access-2"); XCTAssertEqual(signIns, 0); XCTAssertEqual(exchanges, 1)
    }

    func testDeniedSaveAfterRotationRetainsUncertainChainWithoutResending() async throws {
        var stored = GatewaySession.Credentials(refreshToken: "existing", deviceToken: "same")
        var exchanges = 0, signIns = 0
        let session = GatewaySession(read: { stored }, save: { value in
            if value.pending == true { stored = value }
            else { throw KeychainStore.KeychainError.accessDenied }
        }, signIn: { signIns += 1; return self.token(0) }, exchange: { _ in exchanges += 1; return self.token(2) })
        do { _ = try await session.tokens(); XCTFail("save denied") }
        catch GatewaySession.SessionError.credentialAccessRequired { }
        XCTAssertEqual(stored.pending, true)
        do { _ = try await session.tokens(); XCTFail("uncertain chain") }
        catch GatewaySession.SessionError.renewalUncertain { }
        XCTAssertEqual(exchanges, 1); XCTAssertEqual(signIns, 0)
    }

    func testDeniedFirstSaveNeverCreatesAnotherSessionOnAutomaticRetry() async throws {
        var signIns = 0, saves = 0
        let session = GatewaySession(read: { nil }, save: { _ in
            saves += 1; throw KeychainStore.KeychainError.accessDenied
        }, signIn: { signIns += 1; return self.token(1) }, exchange: { _ in
            XCTFail("there is no stored refresh chain"); return self.token(0)
        })
        do { _ = try await session.tokens(); XCTFail("first save denied") }
        catch GatewaySession.SessionError.credentialAccessRequired { }
        for _ in 0..<2 {
            do { _ = try await session.tokens(); XCTFail("issued chain remains uncertain") }
            catch GatewaySession.SessionError.renewalUncertain { }
        }
        XCTAssertEqual(signIns, 1); XCTAssertEqual(saves, 1)
    }

}
