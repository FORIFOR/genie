import XCTest
@testable import GenieMac

private final class PresenceProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var denied = true
    private(set) var calls = 0
    private(set) var ranOnMainThread = false
    func allow() { lock.lock(); denied = false; lock.unlock() }
    func read() throws -> Bool {
        lock.lock(); calls += 1; ranOnMainThread = ranOnMainThread || Thread.isMainThread
        let reject = denied; lock.unlock()
        Thread.sleep(forTimeInterval: 0.03)
        if reject { throw KeychainStore.KeychainError.interactionRequired }
        return true
    }
}

@MainActor
final class SettingsKeyPresenceTests: XCTestCase {
    func testGeminiConstructionDoesNotReadSecretOrBlockMainAndCoalescesPresence() async throws {
        let name = "genie.key-presence.fixture.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(true, forKey: "genie.geminiLive.enabled")
        defaults.set(10, forKey: "genie.geminiLive.monthlyMinutes")
        let probe = PresenceProbe()
        let settings = GeminiLiveSettings(defaults: defaults, presenceReader: { try probe.read() })
        XCTAssertTrue(settings.checkingKey)
        XCTAssertFalse(settings.setKey("synthetic-unused"), "unresolved state must not enter a write")
        let first = Task { await settings.refreshKeyPresence() }
        let second = Task { await settings.refreshKeyPresence() }
        await first.value; await second.value
        XCTAssertEqual(probe.calls, 1); XCTAssertFalse(probe.ranOnMainThread)
        XCTAssertNotNil(settings.keyAccessIssue); XCTAssertFalse(settings.hasKey)
        XCTAssertTrue(settings.enabled, "access denial does not erase the user's chosen provider")
        XCTAssertFalse(settings.active)
        XCTAssertFalse(settings.setKey("synthetic-unused"), "denial must not become missing-key replacement")
        settings.setEnabled(false)
        XCTAssertFalse(settings.enabled, "turning a provider off never needs Keychain access")
        probe.allow(); await settings.refreshKeyPresence()
        XCTAssertNil(settings.keyAccessIssue); XCTAssertTrue(settings.hasKey); XCTAssertFalse(settings.active)
        settings.setEnabled(true); XCTAssertTrue(settings.active)
    }

    func testPlacesDeniedPresenceIsDistinctFromMissingAndCanBeRetried() async throws {
        let name = "genie.key-presence.fixture.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let probe = PresenceProbe()
        let settings = PlacesSettings(defaults: defaults, presenceReader: { try probe.read() })
        await settings.refreshKeyPresence()
        XCTAssertNotNil(settings.keyAccessIssue); XCTAssertFalse(settings.hasKey)
        XCTAssertFalse(settings.setKey("synthetic-unused")); XCTAssertFalse(probe.ranOnMainThread)
        probe.allow(); await settings.refreshKeyPresence()
        XCTAssertTrue(settings.hasKey); XCTAssertNil(settings.keyAccessIssue)
    }

    func testInjectedAbsentFixturesRemainReadFree() async throws {
        let name = "genie.key-presence.fixture.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let gemini = GeminiLiveSettings(defaults: defaults, initialHasKey: false)
        let places = PlacesSettings(defaults: defaults, initialHasKey: false)
        await gemini.refreshKeyPresence(); await places.refreshKeyPresence()
        XCTAssertFalse(gemini.checkingKey); XCTAssertFalse(places.checkingKey)
        XCTAssertNil(gemini.keyAccessIssue); XCTAssertNil(places.keyAccessIssue)
    }
}
