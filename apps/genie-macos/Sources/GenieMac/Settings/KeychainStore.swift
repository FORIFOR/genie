import Foundation
import LocalAuthentication
import Security

/// Serialize every owned Keychain operation while optional UI is disabled.
/// Legacy file-based items do not consistently honor the per-query LAContext.
/// This changes process interaction policy only; it never changes an item's ACL.
final class KeychainInteractionGuard {
    private let condition = NSCondition()
    private var operationRunning = false
    private var interactiveRequested = false
    private var restoreFailed = false
    private let readAllowed: () throws -> Bool
    private let setAllowed: (Bool) throws -> Void

    init(readAllowed: @escaping () throws -> Bool = {
        var allowed: DarwinBoolean = false
        let status = SecKeychainGetUserInteractionAllowed(&allowed)
        guard status == errSecSuccess else { throw KeychainStore.KeychainError.interactionPolicy(status) }
        return allowed.boolValue
    }, setAllowed: @escaping (Bool) throws -> Void = { allowed in
        let status = SecKeychainSetUserInteractionAllowed(allowed)
        guard status == errSecSuccess else { throw KeychainStore.KeychainError.interactionPolicy(status) }
    }) {
        self.readAllowed = readAllowed; self.setAllowed = setAllowed
    }

    func perform<T>(allowInteraction: Bool = false, _ operation: () throws -> T) throws -> T {
        // Never queue another operation behind a human's outstanding OS prompt.
        // Ordinary background reads serialize; a main-thread action fails promptly.
        condition.lock()
        guard !interactiveRequested else {
            condition.unlock(); throw KeychainStore.KeychainError.operationInProgress
        }
        if allowInteraction { interactiveRequested = true }
        while operationRunning {
            if Thread.isMainThread || (!allowInteraction && interactiveRequested) {
                if allowInteraction { interactiveRequested = false }
                condition.unlock(); throw KeychainStore.KeychainError.operationInProgress
            }
            condition.wait()
        }
        if !allowInteraction && interactiveRequested {
            condition.unlock(); throw KeychainStore.KeychainError.operationInProgress
        }
        operationRunning = true
        condition.unlock()
        defer {
            condition.lock()
            operationRunning = false
            if allowInteraction { interactiveRequested = false }
            condition.broadcast()
            condition.unlock()
        }
        guard !restoreFailed else { throw KeychainStore.KeychainError.interactionPolicy(errSecInteractionNotAllowed) }
        let previous = try readAllowed()
        try setAllowed(allowInteraction)
        let result = Result { try operation() }
        do { try setAllowed(previous) }
        catch {
            // Never return a secret/success after restoration failed, or run another
            // operation with an unknown policy. Best-effort leave interaction disabled.
            restoreFailed = true
            try? setAllowed(false)
            throw error
        }
        return try result.get()
    }
}

/// Credentials remain in the existing Keychain service. Passive app reads never
/// open a security prompt, and unavailable items are errors rather than missing keys.
enum KeychainStore {
    static let service = "com.astra.mac"
    private static let interaction = KeychainInteractionGuard()

    enum KeychainError: Error, Equatable, CustomStringConvertible {
        case interactionRequired, accessDenied, invalidData, operationInProgress
        case interactionPolicy(OSStatus), unexpected(OSStatus)
        var description: String {
            switch self {
            case .interactionRequired: return "Keychain interaction is required"
            case .accessDenied: return "Keychain access is denied"
            case .invalidData: return "Keychain item could not be decoded"
            case .operationInProgress: return "A Keychain operation is already in progress"
            case .interactionPolicy(let status): return "Keychain interaction policy failed (\(status))"
            case .unexpected(let status): return "Keychain operation failed (\(status))"
            }
        }
    }

    static let accessMessage = "キーチェーンでGenieのアクセスを確認してください。"

    static func error(_ status: OSStatus) -> KeychainError {
        GenieLog.write("keychain", "status \(status) (\(SecCopyErrorMessageString(status, nil) as String? ?? "?"))")
        switch status {
        case errSecInteractionNotAllowed: return .interactionRequired
        case errSecAuthFailed, errSecUserCanceled: return .accessDenied
        default: return .unexpected(status)
        }
    }

    /// The modern per-query policy covers Data Protection items; the serialized
    /// guard additionally covers the existing legacy service without migrating it.
    static func noninteractiveQuery(service: String, account: String) -> [String: Any] {
        let context = LAContext()
        context.interactionNotAllowed = true
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: account,
                kSecUseAuthenticationContext as String: context]
    }

    static func set(_ key: String, _ value: String) throws {
        try setGeneric(service: service, account: key, value: value)
    }
    static func get(_ key: String) throws -> String? {
        try getGeneric(service: service, account: key)
    }
    static func contains(_ key: String) throws -> Bool {
        try containsGeneric(service: service, account: key)
    }
    static func delete(_ key: String) throws {
        try deleteGeneric(service: service, account: key)
    }

    static func connectorService(_ pluginId: String, _ connectorId: String) -> String {
        "com.astra.connector.\(pluginId)/\(connectorId)"
    }

    static func setGeneric(service: String, account: String, value: String) throws {
        try interaction.perform {
            let query = noninteractiveQuery(service: service, account: account)
            let data = Data(value.utf8)
            let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if updated == errSecSuccess { return }
            guard updated == errSecItemNotFound else { throw error(updated) }
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(add as CFDictionary, nil)
            guard status == errSecSuccess else { throw error(status) }
        }
    }

    /// Attribute-only presence is enough for settings; it does not request key data.
    static func containsGeneric(service: String, account: String) throws -> Bool {
        try interaction.perform {
            var query = noninteractiveQuery(service: service, account: account)
            query[kSecReturnAttributes as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &out)
            if status == errSecItemNotFound { return false }
            guard status == errSecSuccess else { throw error(status) }
            return true
        }
    }

    /// Kept for a read-only selftest assertion; denial fails that assertion.
    static func hasGeneric(service: String, account: String) -> Bool {
        (try? containsGeneric(service: service, account: account)) ?? false
    }

    static func getGeneric(service: String, account: String) throws -> String? {
        try readGeneric(service: service, account: account, allowInteraction: false)
    }

    /// Only the explicit Home recovery action calls this existing-session read.
    /// It cannot save/delete an item, select an OS answer, or alter an ACL.
    static func readGatewaySessionAfterUserRequest(account: String) throws -> String? {
        guard account.hasPrefix("astra.gateway.session.") else { throw KeychainError.invalidData }
        return try readGeneric(service: service, account: account, allowInteraction: true)
    }

    private static func readGeneric(service: String, account: String, allowInteraction: Bool) throws -> String? {
        try interaction.perform(allowInteraction: allowInteraction) {
            var query: [String: Any]
            if allowInteraction {
                query = [kSecClass as String: kSecClassGenericPassword,
                         kSecAttrService as String: service, kSecAttrAccount as String: account]
            } else { query = noninteractiveQuery(service: service, account: account) }
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &out)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess else { throw error(status) }
            guard let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
                throw KeychainError.invalidData
            }
            return value
        }
    }

    static func deleteGeneric(service: String, account: String) throws {
        try interaction.perform {
            let query = noninteractiveQuery(service: service, account: account)
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw error(status) }
        }
    }
}
