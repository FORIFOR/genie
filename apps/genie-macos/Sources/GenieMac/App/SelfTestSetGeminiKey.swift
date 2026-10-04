import Foundation

extension SelfTest {
    /// `GENIE_GEMINI_KEY` の値を、設定画面と同じ経路（`GeminiLiveSettings.setKey`）で Genie のキーチェーンへ登録する。
    /// キーは表示しない・ファイルに書かない。登録後に読み戻して一致を確かめる。
    @MainActor static func setGeminiKey() async {
        guard let key = ProcessInfo.processInfo.environment["GENIE_GEMINI_KEY"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else {
            print("SELFTEST_FAIL setgeminikey: GENIE_GEMINI_KEY is empty"); exit(2)
        }
        let settings = GeminiLiveSettings.shared
        await settings.refreshKeyPresence()
        guard settings.setKey(key) else {
            print("SELFTEST_FAIL setgeminikey: could not save (\(settings.keyAccessIssue ?? "unknown"))"); exit(2)
        }
        let same = settings.apiKey() == key
        print((same ? "SELFTEST_OK" : "SELFTEST_FAIL") + " setgeminikey: saved=\(same) length=\(key.count)")
        exit(same ? 0 : 2)
    }
}
