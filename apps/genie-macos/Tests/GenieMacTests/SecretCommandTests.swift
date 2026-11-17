import XCTest
@testable import GenieMac

final class SecretCommandTests: XCTestCase {
    final class Box { var values: [String: String] = [:]; var out = "" }
    func run(_ args: [String], _ box: Box, input: String = "", deny: Bool = false) -> Int32 {
        let store = SecretCommand.Store(
            get: { if deny { throw KeychainStore.KeychainError.accessDenied }; return box.values[$0] },
            set: { box.values[$0] = $1 }, delete: { box.values[$0] = nil })
        return SecretCommand.run(args, store: store, input: { Data(input.utf8) }, output: { box.out += $0 })
    }

    func testReadsWritesAndDeletesNamedSecretsThroughStandardIO() {
        let box = Box()
        XCTAssertEqual(run(["get", "line-access-token"], box), SecretCommand.notFound)
        XCTAssertEqual(run(["set", "line-access-token"], box, input: "abc\n"), 0)
        XCTAssertEqual(box.values["genie.line.accessToken"], "abc")
        XCTAssertEqual(run(["get", "line-access-token"], box), 0)
        XCTAssertEqual(box.out, "abc")
        XCTAssertEqual(run(["delete", "line-access-token"], box), 0)
        XCTAssertNil(box.values["genie.line.accessToken"])
    }

    func testStatusNamesWhatIsSetWithoutValues() {
        let box = Box(); box.values["gemini.live.apiKey"] = "secret-value"
        XCTAssertEqual(run(["status"], box), 0)
        XCTAssertTrue(box.out.contains("gemini\tset\n"))
        XCTAssertTrue(box.out.contains("anthropic\tmissing\n"))
        XCTAssertFalse(box.out.contains("secret-value"))
    }

    func testRefusesUnknownNamesEmptyValuesAndReportsDenial() {
        let box = Box()
        XCTAssertEqual(run(["get", "com.astra.genie"], box), 2)
        XCTAssertEqual(run(["get", "genie.session"], box), 2)
        XCTAssertEqual(run(["set", "anthropic"], box, input: "  "), 2)
        XCTAssertEqual(run(["get", "gemini"], box, deny: true), 45)
        XCTAssertEqual(box.out, "")
    }

    /// Mac の設定で入れたキーと同じ項目を使う（二重に持たない）。
    @MainActor func testSharesTheItemsTheSettingsWindowUses() {
        let accounts = Dictionary(uniqueKeysWithValues: SecretCommand.items.map { ($0.name, $0.account) })
        XCTAssertEqual(accounts["gemini"], GeminiLiveSettings.keychainKey)
        XCTAssertEqual(accounts["google-maps"], PlacesSettings.keychainKey)
    }
}
