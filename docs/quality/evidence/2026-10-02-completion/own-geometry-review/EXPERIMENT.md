# Own-process geometry probe — not adopted

The implementation and independent read-only review retain **FAIL**. See [result.json](result.json) and the historical [review.json](review.json). The old review source path predates moving the unused collector out of application Sources; its hashes remain historical evidence.

The two source files live under `scripts/tests`. To reproduce in an explicitly allocated native UI slot, compile `OwnAccessibilityGeometry.swift` and `OwnAccessibilityGeometryHarness.swift` together with `swiftc -parse-as-library -framework AppKit -framework SwiftUI`, then run the resulting executable with `--output <fresh-report-path>`. `--hold` keeps only the fixture's own two windows for a bounded 120 seconds so an external reader can compare the semantics. It creates no model process, network request, credential read, or permission request. It returns failure if the required SwiftUI identifiers or enabled states are missing.

This is an experimental negative result, not a regular passing test or a substitute for the application's AX-based six-state gate. No geometry baseline was produced or adopted from this probe. The later application record-path regression uses synthetic file data only and separately verifies error reporting; it does not claim actual UI geometry coverage.
