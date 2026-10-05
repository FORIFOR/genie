import Foundation
import Security

extension SelfTest {
    /// Genie のキーチェーン読み書きが、どの段で何の状態コードで断られるかを出す（値は出さない）。
    @MainActor static func keychainProbe() async {
        let identity = UserDefaults.standard.string(forKey: "astra.dev.identity.http://127.0.0.1:3000") ?? "?"
        let session = "astra.gateway.session.http://127.0.0.1:3000.\(identity)"
        func status(_ account: String) -> OSStatus {
            var q = KeychainStore.noninteractiveQuery(service: KeychainStore.service, account: account)
            q[kSecReturnAttributes as String] = true
            var out: CFTypeRef?
            return SecItemCopyMatching(q as CFDictionary, &out)
        }
        print("read session: \(status(session))")
        print("read gemini key: \(status(GeminiLiveSettings.keychainKey))")
        do { _ = try KeychainStore.get(session); print("KeychainStore.get session: ok") }
        catch { print("KeychainStore.get session: \(error)") }
        let probe = "genie.keychain.probe"
        do { try KeychainStore.set(probe, "x"); print("write probe: ok"); try? KeychainStore.delete(probe) }
        catch { print("write probe: \(error)") }
        print("SELFTEST_OK keychainprobe")
        exit(0)
    }
}
