import Foundation
import XCTest
@testable import GenieMac

final class RegistrationPrivacyGuardTests: XCTestCase {
    private let pid: Int32 = 123
    private let born = RegistrationPrivacyGuard.Generation(seconds: 789, microseconds: 10)

    private func fixture(_ work: (URL) throws -> Void) throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("genie-app-registration-privacy-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: dir) }
        try work(dir)
    }
    private func marker(_ directory: URL, name: String? = nil, data: Data = Data()) throws -> URL {
        let url = directory.appendingPathComponent(name ?? RegistrationPrivacyGuard.key(pid: pid, generation: born))
        try data.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return url
    }
    private func blocked(_ directory: URL, processes: [Int32]? = nil,
                         generation: RegistrationPrivacyGuard.Generation? = nil) throws -> Bool {
        try RegistrationPrivacyGuard.blocked(directory: directory, processes: { processes ?? [self.pid] }, generation: { _ in generation ?? self.born })
    }

    func testSharedNativeKeyAndCurrentProcessBlock() throws {
        XCTAssertEqual(RegistrationPrivacyGuard.key(pid: pid, generation: born), "70914e5657f58d5bfc427de00aa1d1fd79d6b0ae9657cea014ee935f62be7d6f")
        try fixture { directory in
            let path = try marker(directory)
            XCTAssertTrue(try blocked(directory))
            XCTAssertTrue(FileManager.default.fileExists(atPath: path.path))
        }
    }
    func testMissingAndEmptyDirectoriesNeedNoProcessLookup() throws {
        try fixture { directory in
            for path in [directory, directory.appendingPathComponent("absent")] {
                XCTAssertFalse(try RegistrationPrivacyGuard.blocked(directory: path,
                    processes: { XCTFail("unnecessary process lookup"); return [] },
                    generation: { _ in XCTFail("unnecessary process lookup"); return self.born }))
            }
        }
    }
    func testOnlySupportedBrowserBundlesCanProducePrivacyMarkers() {
        XCTAssertEqual(RegistrationPrivacyGuard.supportedBrowserBundles, [
            "com.apple.Safari", "com.google.Chrome", "com.google.Chrome.beta",
            "com.google.Chrome.dev", "com.google.Chrome.canary", "org.chromium.Chromium",
            "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi", "company.thebrowser.Browser",
        ])
        XCTAssertFalse(RegistrationPrivacyGuard.supportedBrowserBundles.contains("com.apple.Safari.evil"))
        XCTAssertFalse(RegistrationPrivacyGuard.supportedBrowserBundles.contains("com.apple.protected-system-agent"))
    }
    func testMarkerCreatedDuringProcessEnumerationInvalidatesObservation() throws {
        try fixture { directory in
            _ = try marker(directory, name: String(repeating: "0", count: 64))
            XCTAssertThrowsError(try RegistrationPrivacyGuard.observation(directory: directory,
                processes: { _ = try self.marker(directory); return [] }, generation: { _ in self.born }))
        }
    }
    func testWindowMovesAndClosingAllWindowsCannotUnblockRunningBrowser() throws {
        try fixture { directory in
            _ = try marker(directory)
            // The observation deliberately has no window identity or visible-window count.
            // A tab move, new window and final window close leave the process alive.
            for _ in 0..<3 { XCTAssertTrue(try blocked(directory, processes: [pid])) }
        }
    }
    func testTerminatedAndReplacedProcessesDoNotDeleteOldMarkers() throws {
        try fixture { directory in
            let path = try marker(directory)
            XCTAssertFalse(try blocked(directory, processes: []))
            XCTAssertFalse(try blocked(directory, processes: [999]))
            XCTAssertFalse(try blocked(directory, generation: .init(seconds: 790, microseconds: 10)))
            XCTAssertTrue(FileManager.default.fileExists(atPath: path.path))
            XCTAssertTrue(try Data(contentsOf: path).isEmpty)
        }
    }
    func testMalformedDirectoryAndMarkersFailClosed() throws {
        try fixture { directory in
            let path = try marker(directory)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
            XCTAssertThrowsError(try blocked(directory))
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path.path)
            XCTAssertThrowsError(try blocked(directory))
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            try Data("unexpected".utf8).write(to: path)
            XCTAssertThrowsError(try blocked(directory))
            try FileManager.default.removeItem(at: path)
            _ = try marker(directory, name: "not-a-marker")
            XCTAssertThrowsError(try blocked(directory))
        }
    }
    func testSymlinkDirectoryAndMarkerAreRefused() throws {
        try fixture { directory in
            let real = directory.appendingPathComponent("real")
            try FileManager.default.createDirectory(at: real, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let link = directory.appendingPathComponent("link")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
            XCTAssertThrowsError(try blocked(link))
            let outside = directory.appendingPathComponent("outside")
            try Data().write(to: outside)
            let key = RegistrationPrivacyGuard.key(pid: pid, generation: born)
            try FileManager.default.createSymbolicLink(at: real.appendingPathComponent(key), withDestinationURL: outside)
            XCTAssertThrowsError(try blocked(real))
        }
    }
    func testUnknownProcessMetadataCannotPermitCapture() throws {
        try fixture { directory in
            _ = try marker(directory)
            XCTAssertThrowsError(try RegistrationPrivacyGuard.blocked(directory: directory,
                processes: { throw RegistrationPrivacyGuard.GuardError.unavailable }, generation: { _ in self.born }))
            XCTAssertThrowsError(try RegistrationPrivacyGuard.blocked(directory: directory,
                processes: { [self.pid] }, generation: { _ in throw RegistrationPrivacyGuard.GuardError.unavailable }))
            XCTAssertThrowsError(try blocked(directory, processes: [0]))
            XCTAssertThrowsError(try blocked(directory, generation: .init(seconds: 0, microseconds: 0)))
        }
    }
    func testCaptureDoesNotStartWhileBlocked() {
        var captured = false
        XCTAssertThrowsError(try RegistrationPrivacyGuard.capture(observe: { .init(blocked: true, stamp: "epoch") }) { captured = true; return "pixels" })
        XCTAssertFalse(captured)
    }
    func testInFlightSynchronousCaptureIsDiscarded() {
        var blocked = false, captured = false
        XCTAssertThrowsError(try RegistrationPrivacyGuard.capture(observe: { .init(blocked: blocked, stamp: "epoch") }) {
            captured = true; blocked = true; return "pixels"
        })
        XCTAssertTrue(captured)
    }
    func testInFlightAsynchronousCaptureIsDiscarded() async throws {
        var blocked = false, captured = false
        do {
            _ = try await RegistrationPrivacyGuard.captureAsync(observe: { .init(blocked: blocked, stamp: "epoch") }) {
                await Task.yield()
                captured = true; blocked = true; return "pixels"
            }
            XCTFail("protected image escaped")
        } catch RegistrationPrivacyGuard.GuardError.protectedWindow { }
        XCTAssertTrue(captured)
    }
    func testNewMarkerInvalidatesCaptureEvenAfterBrowserHasQuit() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("genie-app-registration-privacy-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        var processes: [Int32] = [pid]
        let observe = {
            try RegistrationPrivacyGuard.observation(directory: directory, processes: { processes }, generation: { _ in self.born })
        }
        let before = try observe()
        XCTAssertFalse(before.blocked)
        do {
            _ = try await RegistrationPrivacyGuard.captureAsync(observe: observe) {
                // A different process can fill the form and exit during an OS capture await.
                _ = try self.marker(directory)
                processes = []
                await Task.yield()
                return "protected pixels"
            }
            XCTFail("image escaped after the protected process quit")
        } catch RegistrationPrivacyGuard.GuardError.protectedWindow { }
        let after = try observe()
        XCTAssertFalse(after.blocked)
        XCTAssertNotEqual(before.stamp, after.stamp)
        XCTAssertThrowsError(try RegistrationPrivacyGuard.validate(before, observe: observe))
    }
    func testUnchangedMarkerHistoryAllowsOrdinaryCapture() throws {
        try fixture { directory in
            _ = try marker(directory)
            let observe = {
                try RegistrationPrivacyGuard.observation(directory: directory, processes: { [] }, generation: { _ in self.born })
            }
            XCTAssertEqual(try RegistrationPrivacyGuard.capture(observe: observe) { "safe pixels" }, "safe pixels")
        }
    }
    func testProductionMetadataLookupAllowsClosedSyntheticMarker() throws {
        try fixture { directory in
            _ = try marker(directory)
            // Real bundle/PID/birth metadata only. No TCC, image, AX, window title,
            // credential, or production marker directory is accessed by this test.
            XCTAssertFalse(try RegistrationPrivacyGuard.observe(directory: directory).blocked)
        }
    }
    @MainActor func testChangedEpochCannotEnterVisualContextStore() {
        var checks = 0
        let store = VisualContextStore(privacyObservation: {
            checks += 1
            return .init(blocked: false, stamp: checks == 1 ? "before" : "after")
        })
        XCTAssertNil(store.ingest(url: URL(fileURLWithPath: "/unread/capture.png"), kind: .screenshot,
            confidence: 1, pixelSize: .init(width: 800, height: 600), capturedAt: Date(), app: nil, window: nil))
        XCTAssertTrue(store.recent.isEmpty)
        XCTAssertNil(store.justCaptured)
        XCTAssertEqual(checks, 2)
    }
    @MainActor func testProtectedVisualContextCannotBeIngestedOrAttached() {
        var checks = 0
        let store = VisualContextStore(privacyObservation: { checks += 1; return .init(blocked: true, stamp: "epoch") })
        let url = URL(fileURLWithPath: "/unread/private-capture.png")
        XCTAssertNil(store.ingest(url: url, kind: .screenshot, confidence: 1, pixelSize: .init(width: 800, height: 600), capturedAt: Date(), app: nil, window: nil))
        XCTAssertTrue(store.recent.isEmpty)
        let artifact = VisualContextArtifact(id: UUID(), conversationID: nil, imageURL: url, capturedAt: Date(), sourceApp: nil, sourceWindow: nil, pixelSize: .init(width: 800, height: 600), confidence: 1, kind: .screenshot, state: .available)
        XCTAssertTrue(store.attach([artifact]).isEmpty)
        XCTAssertNil(store.offeredCapture)
        XCTAssertEqual(store.attachCount, 0)
        XCTAssertEqual(checks, 3)
    }
}
