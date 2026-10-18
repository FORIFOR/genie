import Foundation
import Security

@main struct RegistrationVaultTests {
    static func require(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        if !condition() { throw TestFailure(label) }
    }
    struct TestFailure: Error { let label: String; init(_ label: String) { self.label = label } }
    static func rejected(_ label: String, _ work: () throws -> Void) throws {
        do { try work() } catch is RegistrationVault.VaultError { return }
        throw TestFailure(label)
    }
    static let origin = "https://accounts.example.test"
    static let email = "person+registration@example.test"
    static func random(_ count: Int) -> [UInt8] {
        Array(repeating: [UInt8(0), 26, 52, 62], count: count / 4).flatMap { $0 }
    }
    static func main() throws {
        for origin in ["http://example.test", "https://example.test/", "https://Example.test", "https://example.test:443", "https://user:pass@example.test", "https://example.test/path", "https://example.test?q=x", "https://example.test#x", "https://example.test%2f.evil", "https://例え.test", "https://exa mple.test", "https://exa_mple.test", "https://example..test", "https://example.test.", "https://-example.test", "https://example-.test", "https://256.0.0.1", "https://127.1", "https://127.00.0.1", "https://2130706433", "https://[::1]"] {
            try rejected("invalid origin accepted") { _ = try RegistrationVault.account(origin: origin, email: email) }
        }
        for email in ["", " name@example.test", "name@example.test\n", "name\n@example.test", "name\t@example.test", "名@example.test", ".name@example.test", "name..x@example.test", "name@", "name@example.test/path"] {
            try rejected("invalid email accepted") { _ = try RegistrationVault.account(origin: origin, email: email) }
        }
        for origin in ["https://0x7f.0.0.1", "https://0x7f000001", "https://example.123"] {
            try rejected("ambiguous numeric host accepted") { _ = try RegistrationVault.account(origin: origin, email: email) }
        }
        let account = try RegistrationVault.account(origin: origin, email: email)
        _ = try RegistrationVault.account(origin: "https://127.0.0.1:8443", email: email)
        try require(account.key == origin + "\n" + email, "account identity changed")
        let team = "ABCDE12345"
        try require(RegistrationVault.signatureMatches(identifier: RegistrationVault.signingIdentifier, team: team, flags: 0, expectedTeam: team), "valid identity rejected")
        for (identifier, actualTeam, flags, expectedTeam) in [
            (RegistrationVault.signingIdentifier, team, UInt32(2), team),
            ("other.helper", team, UInt32(0), team),
            (RegistrationVault.signingIdentifier, "OTHER12345", UInt32(0), team),
            (RegistrationVault.signingIdentifier, team, UInt32(0), ""),
        ] {
            try require(!RegistrationVault.signatureMatches(identifier: identifier, team: actualTeam, flags: flags, expectedTeam: expectedTeam), "invalid identity accepted")
        }
        var randomCalls = 0, saved: [String: Data] = [:]
        try rejected("signature bypass") {
            _ = try RegistrationVault.testCreate(origin: origin, email: email,
                verifySigner: { throw RegistrationVault.VaultError.signingRequired },
                random: { count in randomCalls += 1; return random(count) },
                add: { _, _, _ in throw TestFailure("write before signature") })
        }
        try require(randomCalls == 0, "generated before signature")
        let store: (RegistrationVault.Account, String, Data) throws -> Void = { account, reference, secret in
            try require(UUID(uuidString: reference) != nil, "reference not opaque UUID")
            guard saved[account.key] == nil else { throw RegistrationVault.VaultError.alreadyStored }
            saved[account.key] = secret
        }
        let result = try RegistrationVault.testCreate(origin: origin, email: email, random: random, add: store)
        try require(result.secret.utf8.count >= 24 && result.secret.utf8.count == 32, "password length")
        try require(saved[account.key] == Data(result.secret.utf8), "returned before save")
        try require(!String(describing: result).contains(result.secret), "description leaked")
        var reflected = ""; dump(result, to: &reflected)
        try require(!reflected.contains(result.secret), "reflection leaked")
        let old = saved[account.key]
        try rejected("duplicate overwritten") { _ = try RegistrationVault.testCreate(origin: origin, email: email, random: random, add: store) }
        try require(saved[account.key] == old && saved.count == 1, "duplicate changed storage")
        try rejected("missing randomness accepted") { _ = try RegistrationVault.testCreate(origin: origin, email: email, random: { _ in [] }, add: store) }
        try rejected("poor randomness accepted") { _ = try RegistrationVault.testCreate(origin: origin, email: email, random: { Array(repeating: 0, count: $0) }, add: store) }
        try rejected("failed write returned secret") { _ = try RegistrationVault.testCreate(origin: origin, email: email, random: random, add: { _, _, _ in throw RegistrationVault.VaultError.storageUnavailable }) }
        let generated1 = try RegistrationVault.testSecureRandom(origin: origin, email: email, add: { _, _, _ in })
        let generated2 = try RegistrationVault.testSecureRandom(origin: origin, email: email, add: { _, _, _ in })
        try require(generated1.secret.utf8.count == 32 && generated2.secret.utf8.count == 32 && generated1.secret != generated2.secret, "native random generation")
        // Even a signed-feature build must reject this unsigned/ad-hoc test binary.
        try rejected("unsigned production gate bypass") { try RegistrationVault.verifyOwnSignature() }
        print("REGISTRATION_VAULT_POLICY_PASS: origin/email, signing gate, entropy shape, add-only save, redacted output")
        if ProcessInfo.processInfo.environment["GENIE_REGISTRATION_ISOLATED_KEYCHAIN_TEST"] == "1" {
            try isolatedKeychain(account)
        }
    }

    static func isolatedKeychain(_ account: RegistrationVault.Account) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("genie-registration-vault-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        var allowed: DarwinBoolean = false
        guard SecKeychainGetUserInteractionAllowed(&allowed) == errSecSuccess,
              SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { throw TestFailure("isolated keychain interaction policy") }
        defer { _ = SecKeychainSetUserInteractionAllowed(allowed.boolValue) }
        var password = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, password.count, &password) == errSecSuccess else { throw TestFailure("isolated keychain randomness") }
        var keychain: SecKeychain?
        let created = root.appendingPathComponent("fixture.keychain-db").path.withCString { path in
            password.withUnsafeBytes { SecKeychainCreate(path, UInt32(password.count), $0.baseAddress, false, nil, &keychain) }
        }
        guard created == errSecSuccess, let keychain else { throw TestFailure("isolated keychain creation") }
        defer { _ = SecKeychainDelete(keychain) }
        let secret = Data(random(32)), reference = UUID().uuidString.lowercased()
        try RegistrationVault.testAdd(account, reference: reference, secret: secret, keychain: keychain)
        try rejected("real duplicate overwritten") { try RegistrationVault.testAdd(account, reference: UUID().uuidString.lowercased(), secret: Data("different".utf8), keychain: keychain) }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: RegistrationVault.service, kSecAttrAccount as String: account.key,
            kSecMatchSearchList as String: [keychain], kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne]
        var data: CFTypeRef?
        try require(SecItemCopyMatching(query as CFDictionary, &data) == errSecSuccess && data as? Data == secret, "isolated stored value changed")
        print("REGISTRATION_VAULT_ISOLATED_KEYCHAIN_PASS: add/readback/duplicate-preserved; no user keychain item")
    }
}
