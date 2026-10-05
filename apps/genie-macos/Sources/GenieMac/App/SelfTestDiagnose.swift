import Foundation

extension SelfTest {
    /// `--selftest diagnose`: 声と接続の診断を実際の状態で走らせ、項目ごとに出す。
    @MainActor static func diagnose() async {
        setvbuf(stdout, nil, _IONBF, 0)
        let items = await VoiceDiagnosis.run()
        for i in items { print("\(i.ok ? "OK" : "NG") \(i.name): \(i.detail)\(i.fix.map { " → \($0)" } ?? "")") }
        print("SELFTEST_OK diagnose")
        exit(0)
    }
}
