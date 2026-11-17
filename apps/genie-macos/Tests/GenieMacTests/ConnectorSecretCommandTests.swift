import XCTest
@testable import GenieMac

final class ConnectorSecretCommandTests: XCTestCase {
    final class Box { var values: [String: String] = [:]; var out = "" }
    func store(_ box: Box, deny: Bool = false) -> ConnectorSecretCommand.Store {
        .init(get: { if deny { throw KeychainStore.KeychainError.accessDenied }; return box.values[$0] },
              set: { box.values[$0] = $1 }, delete: { box.values[$0] = nil })
    }
    func run(_ args: [String], _ box: Box, input: String = "", deny: Bool = false) -> Int32 {
        ConnectorSecretCommand.run(args, store: store(box, deny: deny), input: { Data(input.utf8) }, output: { box.out += $0 })
    }

    func testReadsWritesAndDeletesOnlyConnectorItemsThroughStandardIO() {
        let box = Box(); let service = "com.astra.connector.com.astra.gmail/gmail"
        XCTAssertEqual(run(["get", service], box), ConnectorSecretCommand.notFound)
        XCTAssertEqual(run(["set", service], box, input: "{\"accessToken\":\"x\"}"), 0)
        XCTAssertEqual(run(["get", service], box), 0)
        XCTAssertEqual(box.out, "{\"accessToken\":\"x\"}")
        XCTAssertEqual(run(["delete", service], box), 0)
        XCTAssertNil(box.values[service])
    }

    func testRefusesOtherItemsEmptyValuesAndReportsDenial() {
        let box = Box()
        // Genie のサインインなど、接続以外の項目は扱わない
        XCTAssertEqual(run(["get", "com.astra.genie"], box), 2)
        XCTAssertEqual(run(["set", "com.astra.connector.x/y"], box, input: ""), 2)
        XCTAssertEqual(run(["get"], box), 2)
        XCTAssertEqual(run(["get", "com.astra.connector.x/y"], box, deny: true), 45)
        XCTAssertEqual(box.out, "")
    }
}
