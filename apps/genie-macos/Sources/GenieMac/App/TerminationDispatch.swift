import AppKit

/// AppKit's terminateLater path runs a nested event loop. The originating main
/// dispatch callback must return before any MainActor cleanup can make progress.
enum TerminationDispatch {
    static func perform(_ action: @escaping @MainActor @Sendable () -> Void) {
        RunLoop.main.perform(inModes: [.default, .modalPanel, .eventTracking]) {
            MainActor.assumeIsolated { action() }
        }
    }

    static func afterCleanup(
        _ cleanup: @escaping @Sendable () async -> Void,
        reply: @escaping @MainActor @Sendable () -> Void
    ) {
        Task.detached {
            await cleanup()
            // A caller other than the signal handler may still invoke terminate
            // from a main-dispatch callback. Do not queue the reply behind it.
            perform(reply)
        }
    }
}
