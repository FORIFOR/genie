import Foundation
import Security

/// Native-only registration storage. There is deliberately no export, lookup-secret,
/// overwrite or delete operation in the helper protocol.
enum RegistrationVault {
    static let service = "com.astra.registration.v1"
    static let signingIdentifier = "com.astra.computer.registration"
    static let passwordLength = 32
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

    enum VaultError: String, Error, CustomStringConvertible {
        case invalidOrigin = "registration_invalid_origin"
        case invalidEmail = "registration_invalid_email"
        case signingRequired = "registration_signed_helper_required"
        case randomUnavailable = "registration_random_unavailable"
        case alreadyStored = "registration_account_already_stored"
        case storageUnavailable = "registration_storage_unavailable"
        var description: String { rawValue }
    }

    /// Never serialize this object. Only the native field writer may access secret.
    /// Swift can copy strings, so buffer wiping is best effort, not a memory-erasure guarantee.
    final class Stored: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
        let reference: String
        private var bytes: [UInt8]
        fileprivate init(reference: String, bytes: [UInt8]) { self.reference = reference; self.bytes = bytes }
        var secret: String { String(decoding: bytes, as: UTF8.self) }
        var description: String { "RegistrationVault.Stored(reference: \(reference), secret: <redacted>)" }
        var debugDescription: String { description }
        var customMirror: Mirror { Mirror(self, children: ["reference": reference, "secret": "<redacted>"]) }
        deinit { bytes.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) } }
    }

    struct Account: Equatable {
        let origin: String
        let email: String
        // Neither validated component can contain a newline; the pair is unambiguous.
        var key: String { origin + "\n" + email }
    }

    static func account(origin: String, email: String) throws -> Account {
        guard let parts = URLComponents(string: origin), parts.scheme == "https",
              let host = parts.host, canonicalHost(host),
              parts.user == nil, parts.password == nil, parts.path.isEmpty,
              parts.query == nil, parts.fragment == nil,
              parts.port == nil || ((1...65535).contains(parts.port!) && parts.port != 443),
              !origin.contains("%"), !origin.contains("\\"),
              origin == "https://" + host + (parts.port.map { ":\($0)" } ?? "")
        else { throw VaultError.invalidOrigin }
        // Preserve the exact email, including local-part case; never merge two accounts.
        guard email.utf8.count <= 254, email.utf8.allSatisfy({ (33...126).contains($0) }),
              email.range(of: #"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$"#,
                          options: .regularExpression) != nil,
              let local = email.split(separator: "@").first,
              local.utf8.count <= 64, !local.hasPrefix("."), !local.hasSuffix("."), !local.contains("..")
        else { throw VaultError.invalidEmail }
        return Account(origin: origin, email: email)
    }

    private static func canonicalHost(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf8.count <= 253,
              host.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 })
        else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ label in
            !label.isEmpty && label.utf8.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-")
        }) else { return false }
        let finalLabel = String(labels.last!)
        if finalLabel.utf8.allSatisfy({ (48...57).contains($0) }) ||
            finalLabel.range(of: #"^0x[0-9a-f]*$"#, options: .regularExpression) != nil {
            // Numeric hosts must be canonical dotted IPv4, not a browser-dependent
            // shortened/decimal/octal spelling. IPv6 is deliberately unsupported.
            return labels.count == 4 && labels.allSatisfy { label in
                guard label.utf8.allSatisfy({ (48...57).contains($0) }),
                      let value = Int(label), (0...255).contains(value) else { return false }
                return String(value) == label
            }
        }
        return true
    }

    static func generateAndStore(origin: String, email: String) throws -> Stored {
        try create(origin: origin, email: email, verifySigner: verifyOwnSignature,
                   random: randomBytes, add: addToKeychain)
    }

    private static func create(origin: String, email: String, verifySigner: () throws -> Void,
                               random: (Int) throws -> [UInt8],
                               add: (Account, String, Data) throws -> Void) throws -> Stored {
        let account = try account(origin: origin, email: email)
        try verifySigner()
        let bytes = try password(random: random)
        // Opaque ref is independently random and never derived from the password/account.
        let reference = UUID().uuidString.lowercased()
        // An add-only write must complete before a native caller receives input bytes.
        try add(account, reference, Data(bytes))
        return Stored(reference: reference, bytes: bytes)
    }

    private static func randomBytes(_ count: Int) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess
        else { throw VaultError.randomUnavailable }
        return bytes
    }

    private static func password(random: (Int) throws -> [UInt8]) throws -> [UInt8] {
        // 64 characters: a six-bit mask is unbiased. Reject missing character classes
        // instead of introducing a predictable prefix/suffix to satisfy site policies.
        for _ in 0..<64 {
            let raw = try random(passwordLength)
            guard raw.count == passwordLength else { throw VaultError.randomUnavailable }
            let bytes = raw.map { alphabet[Int($0 & 63)] }
            if bytes.contains(where: { (65...90).contains($0) }) &&
                bytes.contains(where: { (97...122).contains($0) }) &&
                bytes.contains(where: { (48...57).contains($0) }) &&
                bytes.contains(where: { $0 == 45 || $0 == 95 }) { return bytes }
        }
        throw VaultError.randomUnavailable
    }

    static func signatureMatches(identifier: String?, team: String?, flags: UInt32, expectedTeam: String?) -> Bool {
        guard let expectedTeam, expectedTeam.range(of: #"^[A-Z0-9]{10}$"#, options: .regularExpression) != nil
        else { return false }
        return identifier == signingIdentifier && team == expectedTeam && (flags & 0x2) == 0
    }

    static func verifyOwnSignature() throws {
        #if GENIE_REGISTRATION_SIGNED
        let expectedTeam: String? = RegistrationBuildSigning.expectedTeam
        #else
        let expectedTeam: String? = nil
        #endif
        guard let expectedTeam else { throw VaultError.signingRequired }
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(rawValue: 0), &code) == errSecSuccess, let code else { throw VaultError.signingRequired }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(rawValue: 0), &staticCode) == errSecSuccess, let staticCode
        else { throw VaultError.signingRequired }
        var raw: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &raw) == errSecSuccess,
              let info = raw as? [String: Any],
              signatureMatches(identifier: info[kSecCodeInfoIdentifier as String] as? String,
                               team: info[kSecCodeInfoTeamIdentifier as String] as? String,
                               flags: (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0x2,
                               expectedTeam: expectedTeam)
        else { throw VaultError.signingRequired }
        var requirement: SecRequirement?
        let expression = "identifier \"\(signingIdentifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(expectedTeam)\""
        guard SecRequirementCreateWithString(expression as CFString, SecCSFlags(rawValue: 0), &requirement) == errSecSuccess,
              let requirement, SecCodeCheckValidity(code, SecCSFlags(rawValue: 0), requirement) == errSecSuccess
        else { throw VaultError.signingRequired }
    }

    private static func addToKeychain(_ account: Account, _ reference: String, _ secret: Data) throws {
        var me: SecTrustedApplication?
        var access: SecAccess?
        guard SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess, let me,
              SecAccessCreate("Genie registration password" as CFString, [me] as CFArray, &access) == errSecSuccess,
              let access else { throw VaultError.storageUnavailable }
        var interactive: DarwinBoolean = false
        guard SecKeychainGetUserInteractionAllowed(&interactive) == errSecSuccess,
              SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { throw VaultError.storageUnavailable }
        let result = Result { try addItem(account, reference, secret, access: access) }
        guard SecKeychainSetUserInteractionAllowed(interactive.boolValue) == errSecSuccess else { throw VaultError.storageUnavailable }
        try result.get()
    }

    private static func addItem(_ account: Account, _ reference: String, _ secret: Data,
                                access: SecAccess? = nil, keychain: SecKeychain? = nil) throws {
        var item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account.key,
            kSecAttrLabel as String: "Genie — \(account.origin) — \(account.email)",
            kSecAttrGeneric as String: try JSONSerialization.data(withJSONObject: ["version": 1, "reference": reference, "origin": account.origin, "email": account.email, "state": "generated_not_submitted"]),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
            kSecValueData as String: secret,
        ]
        if let access { item[kSecAttrAccess as String] = access }
        if let keychain { item[kSecUseKeychain as String] = keychain }
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem { throw VaultError.alreadyStored }
        guard status == errSecSuccess else { throw VaultError.storageUnavailable }
    }

    #if GENIE_REGISTRATION_TEST
    static func testCreate(origin: String, email: String, verifySigner: () throws -> Void = {},
                           random: (Int) throws -> [UInt8], add: (Account, String, Data) throws -> Void) throws -> Stored {
        try create(origin: origin, email: email, verifySigner: verifySigner, random: random, add: add)
    }
    static func testSecureRandom(origin: String, email: String, add: (Account, String, Data) throws -> Void) throws -> Stored {
        try create(origin: origin, email: email, verifySigner: {}, random: randomBytes, add: add)
    }
    static func testAdd(_ account: Account, reference: String, secret: Data, keychain: SecKeychain) throws {
        try addItem(account, reference, secret, keychain: keychain)
    }
    #endif
}
