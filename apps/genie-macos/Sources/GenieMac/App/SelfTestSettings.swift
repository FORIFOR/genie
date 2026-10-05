import SwiftUI

extension SelfTest {
    /// Render the real settings view with deterministic, unconfigured providers.
    /// Provider settings use a fresh read-only suite and never access Keychain.
    @MainActor
    static func settingsFixture(showAdditionalPermissions: Bool = false) -> SettingsView {
        let defaults = UserDefaults(suiteName: "genie.selftest.settings.\(UUID().uuidString)")!
        return SettingsView(showAdditionalPermissions: showAdditionalPermissions,
                            gemini: GeminiLiveSettings(defaults: defaults, initialHasKey: false),
                            places: PlacesSettings(defaults: defaults, initialHasKey: false))
    }
}
