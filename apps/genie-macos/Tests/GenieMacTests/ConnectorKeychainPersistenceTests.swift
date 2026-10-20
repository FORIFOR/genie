import XCTest
import Security
import LocalAuthentication
@testable import GenieMac

final class ConnectorKeychainPersistenceTests: XCTestCase {
    func testExistingConnectorOnlyRequestsDataUpdateWithoutRecreation() throws {
        var updates = 0
        let writer = KeychainStore.ConnectorSecretWriter(update: { query, attributes in
            updates += 1
            XCTAssertEqual(query[kSecAttrService as String] as? String, "fixture-service")
            XCTAssertEqual(query[kSecAttrAccount as String] as? String, "fixture-account")
            XCTAssertTrue((query[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed == true)
            XCTAssertEqual(Set(attributes.keys), [kSecValueData as String])
            XCTAssertEqual(attributes[kSecValueData as String] as? Data, Data("new".utf8))
            return errSecSuccess
        }, add: { _ in XCTFail("existing items must not be recreated"); return errSecInternalError },
        access: { _ in XCTFail("existing access must not be explicitly replaced"); return nil })

        try writer.save(service: "fixture-service", account: "fixture-account", value: "new")
        XCTAssertEqual(updates, 1)
    }

    func testDeniedOrUnavailableUpdateDoesNotReplaceExistingItem() {
        for status in [errSecAuthFailed, errSecInteractionNotAllowed, errSecUserCanceled, errSecNotAvailable] {
            var updates = 0
            let writer = KeychainStore.ConnectorSecretWriter(update: { _, _ in
                updates += 1; return status
            }, add: { _ in XCTFail("denial must not fall back to add"); return errSecInternalError },
            access: { _ in XCTFail("denial must not alter access"); return nil })
            XCTAssertThrowsError(try writer.save(service: "fixture", account: "fixture", value: "new")) {
                XCTAssertEqual($0 as? KeychainStore.KeychainError, KeychainStore.error(status))
            }
            XCTAssertEqual(updates, 1)
        }
    }

    func testAbsentConnectorAddsDataWithConfiguredAccess() throws {
        var access: SecAccess?
        XCTAssertEqual(SecAccessCreate("fixture" as CFString, [] as CFArray, &access), errSecSuccess)
        let expectedAccess = try XCTUnwrap(access)
        var calls: [String] = []
        let writer = KeychainStore.ConnectorSecretWriter(update: { _, _ in
            calls.append("update"); return errSecItemNotFound
        }, add: { attributes in
            calls.append("add")
            XCTAssertEqual(attributes[kSecAttrService as String] as? String, "fixture-service")
            XCTAssertEqual(attributes[kSecAttrAccount as String] as? String, "fixture-account")
            XCTAssertEqual(attributes[kSecValueData as String] as? Data, Data("new".utf8))
            XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
            XCTAssertTrue((attributes[kSecAttrAccess as String] as AnyObject?) === expectedAccess)
            return errSecSuccess
        }, access: { service in
            calls.append("access"); XCTAssertEqual(service, "fixture-service"); return expectedAccess
        })

        try writer.save(service: "fixture-service", account: "fixture-account", value: "new")
        XCTAssertEqual(calls, ["update", "access", "add"])
    }

    func testReconnectReplacesOnlyAnItemTheAppCanNoLongerRead() throws {
        var calls: [String] = []
        let writer = KeychainStore.ConnectorSecretWriter(update: { _, _ in
            calls.append("update"); return calls.filter { $0 == "update" }.count == 1 ? errSecAuthFailed : errSecItemNotFound
        }, add: { _ in calls.append("add"); return errSecSuccess },
        access: { _ in calls.append("access"); return nil },
        delete: { query in
            calls.append("delete")
            XCTAssertTrue((query[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed == true)
            return errSecSuccess
        })
        try writer.replaceLocked(service: "fixture", account: "fixture", value: "new")
        XCTAssertEqual(calls, ["update", "delete", "update", "access", "add"])
        // 取り消し・確認待ち・使えないときは、つなぎ直しでも消さない
        for status in [errSecUserCanceled, errSecInteractionNotAllowed, errSecNotAvailable] {
            let keep = KeychainStore.ConnectorSecretWriter(update: { _, _ in status },
                add: { _ in XCTFail("must not add"); return errSecInternalError },
                access: { _ in nil }, delete: { _ in XCTFail("must not delete"); return errSecInternalError })
            XCTAssertThrowsError(try keep.replaceLocked(service: "fixture", account: "fixture", value: "new"))
        }
    }

    func testFailedAddIsReportedWithoutRetryOrReplacement() {
        var calls: [String] = []
        let writer = KeychainStore.ConnectorSecretWriter(update: { _, _ in
            calls.append("update"); return errSecItemNotFound
        }, add: { _ in calls.append("add"); return errSecAuthFailed },
        access: { _ in calls.append("access"); return nil })
        XCTAssertThrowsError(try writer.save(service: "fixture", account: "fixture", value: "new")) {
            XCTAssertEqual($0 as? KeychainStore.KeychainError, .accessDenied)
        }
        XCTAssertEqual(calls, ["update", "access", "add"])
    }
}
