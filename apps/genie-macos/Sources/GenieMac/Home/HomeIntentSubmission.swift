import Foundation

/// Wait only before dispatch. Cancellation or edited text never becomes a late send.
@MainActor
enum HomeIntentSubmission {
    enum Outcome: Equatable { case submitted, rejected, unavailable, cancelled, draftChanged }

    static func run(needsConnection: Bool,
                    connect: () async -> Bool,
                    isCurrent: () -> Bool,
                    submit: () -> Bool) async -> Outcome {
        guard !Task.isCancelled else { return .cancelled }
        if needsConnection {
            let connected = await connect()
            guard !Task.isCancelled else { return .cancelled }
            guard connected else { return .unavailable }
        }
        guard isCurrent() else { return .draftChanged }
        return submit() ? .submitted : .rejected
    }
}
