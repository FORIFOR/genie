import SwiftUI

extension SelfTest {
    /// Render the real settings view with deterministic, unconfigured providers.
    /// Provider settings use a fresh read-only suite and never access Keychain.
    @MainActor
    static func settingsFixture(showAdditionalPermissions: Bool = false, pane: SettingsPane? = nil) -> SettingsView {
        let defaults = UserDefaults(suiteName: "genie.selftest.settings.\(UUID().uuidString)")!
        let selection: SettingsPaneSelection? = pane.map { pane in
            let s = SettingsPaneSelection(); s.pane = pane; return s
        }
        return SettingsView(showAdditionalPermissions: showAdditionalPermissions,
                            gemini: GeminiLiveSettings(defaults: defaults, initialHasKey: false),
                            places: PlacesSettings(defaults: defaults, initialHasKey: false),
                            selection: selection)
    }

    /// 設定のどの面も、この高さ（中身の実寸）に収める。1440x900 の画面で、タイトルバーと Dock を除いて収まる高さ。
    /// 1 列に積んでいたころは 1159pt で、画面の下の節に届かなかった（DESIGN.md §8.3）。
    static let settingsPaneMaxHeight: CGFloat = 640
}
