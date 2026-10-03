import XCTest
import SwiftUI
import Security
@testable import GenieMac

@MainActor final class GatewayCredentialRecoveryTests: XCTestCase {
    func testReadConfirmationDoesNotResumeConnectionUntilNextUserSubmission() async {
        let recovery = GatewayCredentialRecovery()
        var reads = 0
        await recovery.confirm {
            reads += 1
            XCTAssertTrue(recovery.holdsAutomaticConnection)
            XCTAssertFalse(recovery.resumeForUserSubmission(), "send cannot race OS confirmation")
            await recovery.confirm { reads += 1; return true }
            return true
        }
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(recovery.state, .readable)
        XCTAssertTrue(recovery.holdsAutomaticConnection, "OS completion/activation must not restart authentication")
        XCTAssertTrue(recovery.resumeForUserSubmission())
        XCTAssertEqual(recovery.state, .idle)
        XCTAssertFalse(recovery.holdsAutomaticConnection)
    }

    func testMissingDeniedCancelledInvalidAndBusyNeverReportReadable() async {
        let cases: [(GatewayCredentialRecovery.State, () async throws -> Bool)] = [
            (.missing, { false }),
            (.denied, { throw KeychainStore.KeychainError.accessDenied }),
            (.denied, { throw KeychainStore.error(errSecUserCanceled) }),
            (.invalid, { throw GatewaySession.SessionError.invalidResponse }),
            (.busy, { throw KeychainStore.KeychainError.operationInProgress })]
        for (state, read) in cases {
            let recovery = GatewayCredentialRecovery()
            await recovery.confirm(read: read)
            XCTAssertEqual(recovery.state, state)
            XCTAssertTrue(recovery.holdsAutomaticConnection)
        }
    }

    func testRecoveryStatesRenderWithoutShowingWindowOrAccessingOSCredentials() async throws {
        for (name, state) in [("required", GatewayCredentialRecovery.State.idle), ("checking", .checking),
                              ("readable", .readable), ("denied", .denied), ("missing", .missing)] {
            for dark in [false, true] {
                let view = GatewayCredentialRecoveryView(state: state) { XCTFail("rendering cannot request credentials") }
                    .padding(Space.cardPadding)
                    .frame(width: Metrics.homeContentWidth, alignment: .leading)
                    .background(Palette.canvas(dark))
                    .environment(\.colorScheme, dark ? .dark : .light)
                try await DisclosureCopyFixture.capture(view, name: "keychain-\(name)-\(dark ? "dark" : "light")", width: Metrics.homeContentWidth)
            }
        }
    }
}
