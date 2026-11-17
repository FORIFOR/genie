import XCTest
@testable import GenieMac

@MainActor
final class HomeIntentSubmissionTests: XCTestCase {
    func testUnavailableConnectionNeverDispatchesOrClearsDraft() async {
        var text = "synthetic draft", sends = 0
        let result = await HomeIntentSubmission.run(needsConnection: true, connect: { false }, isCurrent: { true }, submit: { sends += 1; text = ""; return true })
        XCTAssertEqual(result, .unavailable); XCTAssertEqual(sends, 0); XCTAssertEqual(text, "synthetic draft")
    }

    func testEditedDraftIsNotSentAfterConnectionCompletes() async {
        var current = "original", sends = 0
        let result = await HomeIntentSubmission.run(needsConnection: true, connect: { current = "edited"; return true }, isCurrent: { current == "original" }, submit: { sends += 1; return true })
        XCTAssertEqual(result, .draftChanged); XCTAssertEqual(sends, 0); XCTAssertEqual(current, "edited")
    }

    func testCancelledWaitNeverDispatchesAfterLateConnection() async {
        var waiter: CheckedContinuation<Bool, Never>?, sends = 0
        let task = Task { await HomeIntentSubmission.run(needsConnection: true, connect: {
            await withCheckedContinuation { waiter = $0 }
        }, isCurrent: { true }, submit: { sends += 1; return true }) }
        while waiter == nil { await Task.yield() }
        task.cancel(); waiter?.resume(returning: true)
        let result = await task.value
        XCTAssertEqual(result, .cancelled); XCTAssertEqual(sends, 0)
    }

    func testLocalPreparationDoesNotRequireGateway() async {
        var connections = 0, sends = 0
        let result = await HomeIntentSubmission.run(needsConnection: false, connect: { connections += 1; return false }, isCurrent: { true }, submit: { sends += 1; return true })
        XCTAssertEqual(result, .submitted); XCTAssertEqual(connections, 0); XCTAssertEqual(sends, 1)
    }

    func testConnectionErrorsExposeOnlyActionableClassification() {
        XCTAssertEqual(GatewayConnectionIssue.classify(GatewaySession.SessionError.credentialAccessRequired), .credentialAccess)
        XCTAssertEqual(GatewayConnectionIssue.classify(KeychainStore.KeychainError.accessDenied), .credentialAccess)
        XCTAssertEqual(GatewayConnectionIssue.classify(GatewaySession.SessionError.renewalUncertain), .reconnect)
        XCTAssertEqual(GatewayConnectionIssue.credentialAccess.diagnosticCode, "credential_access_required")
    }
}
