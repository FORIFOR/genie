import Foundation
import Combine

/// The OS confirmation may finish after Home disappears. Keep its single attempt
/// and automatic-connection hold outside the view's lifetime; never submit a draft.
@MainActor
final class GatewayCredentialRecovery: ObservableObject {
    enum State: Equatable { case idle, checking, readable, missing, denied, invalid, busy }
    @Published private(set) var state = State.idle
    private(set) var holdsAutomaticConnection = false
    var isChecking: Bool { state == .checking }

    func confirm(read: () async throws -> Bool) async {
        guard !isChecking else { return }
        holdsAutomaticConnection = true
        state = .checking
        do { state = try await read() ? .readable : .missing }
        catch let error as KeychainStore.KeychainError {
            state = error == .operationInProgress ? .busy : .denied
        } catch { state = .invalid }
    }

    /// Only a new explicit submission/reconnect resumes ordinary connection work.
    /// Resolving an OS prompt or making the application active cannot do this.
    func resumeForUserSubmission() -> Bool {
        guard !isChecking else { return false }
        holdsAutomaticConnection = false
        state = .idle
        return true
    }
}
