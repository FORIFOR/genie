import XCTest
@testable import GenieMac

@MainActor
final class InitialProfileTests: XCTestCase {
    func testEmojiUsesTheSameUTF16LimitAsTheAPI() {
        var s = InitialProfileSections(focus: [String(repeating: "🙂", count: 100)], people: [], priorities: [], workPattern: [], openItems: 0)
        XCTAssertTrue(InitialProfileStore.valid(s))
        s.focus = [String(repeating: "🙂", count: 101)]
        XCTAssertFalse(InitialProfileStore.valid(s))
    }
    func testAbsentProfileDoesNotShowSetupAgain() throws {
        XCTAssertNil(try InitialProfileStore.decode("{\"profile\":null}"))
    }
    func testRejectsReadyWithoutRealResult() {
        let json = """
        {"profile":{"id":"x","provider":"google","status":"ready","started_at":"2026-09-09T00:00:00Z","updated_at":"2026-09-09T00:00:00Z","outcomes":[],"sections":null}}
        """
        XCTAssertThrowsError(try InitialProfileStore.decode(json))
    }
    func testEditsRespectFieldLimitsAndAllowNoInferredData() {
        var s = InitialProfileSections(focus: [], people: [], priorities: [], workPattern: [], openItems: 0)
        XCTAssertTrue(InitialProfileStore.valid(s))
        s.focus = Array(repeating: "project", count: 6)
        XCTAssertFalse(InitialProfileStore.valid(s))
        s.focus = [" "]; XCTAssertFalse(InitialProfileStore.valid(s))
        s.focus = []; s.openItems = -1; XCTAssertFalse(InitialProfileStore.valid(s))
    }
    func testOlderProfileIsDistinguishedFromBodyAnalysis() throws {
        let json = """
        {"profile":{"id":"old","provider":"google","status":"ready","started_at":"2026-09-09T00:00:00Z","updated_at":"2026-09-09T00:00:00Z","outcomes":[],"sections":{"focus":[],"people":[],"priorities":[],"work_pattern":[],"open_items":0}}}
        """
        XCTAssertNil(try InitialProfileStore.decode(json)?.analysis)
    }
    func testCoverageDoesNotCallFailedAnalysisComplete() {
        let unavailable = InitialProfileAnalysis(version: 2, status: "unavailable", selectedCount: 12, analyzedCount: 0)
        XCTAssertTrue(unavailable.coverage.contains("分析できませんでした"))
        let partial = InitialProfileAnalysis(version: 2, status: "partial", selectedCount: 12, analyzedCount: 8)
        XCTAssertTrue(partial.coverage.contains("12件のうち8件"))
        XCTAssertTrue(partial.coverage.contains("一部は分析できていません"))
    }
    func testHundredMailCoverageAndLegacyResultDecode() throws {
        for count in [24, 100] {
            let json = """
            {"profile":{"id":"sample","provider":"google","status":"ready","started_at":"2026-10-10T00:00:00Z","updated_at":"2026-10-10T00:00:00Z","outcomes":[],"sections":{"focus":[],"people":[],"priorities":[],"work_pattern":[],"open_items":0},"analysis":{"version":2,"status":"complete","selected_count":\(count),"analyzed_count":\(count)}}}
            """
            let result = try InitialProfileStore.decode(json)
            XCTAssertEqual(result?.analysis?.selectedCount, count)
            XCTAssertTrue(result?.analysis?.coverage.contains("\(count)件のうち\(count)件") == true)
            if count == 100 {
                XCTAssertThrowsError(try InitialProfileStore.decode(json.replacingOccurrences(of: ":100", with: ":101")))
            }
        }
    }
}
