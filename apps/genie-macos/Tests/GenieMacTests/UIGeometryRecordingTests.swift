import Foundation
import XCTest
@testable import GenieMac

final class UIGeometryRecordingTests: XCTestCase {
    private let states = ["01-idle", "02-listening", "03-task-dock", "04-meeting",
                          "05-meeting-notes", "06-workspace"]

    private var complete: [String: UIGeometry.Snapshot] {
        Dictionary(uniqueKeysWithValues: states.map {
            ($0, ["fixture-control": UIGeometry.Box(x: 3, y: 5, w: 140, h: 32)])
        })
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        return directory
    }

    func testMissingStatesDoNotReplaceAnExistingReference() throws {
        let directory = try temporaryDirectory()
        let path = directory.appendingPathComponent(states[0] + ".json")
        let original = Data("approved reference".utf8)
        try original.write(to: path)
        for count in [0, 5] {
            let captures = Dictionary(uniqueKeysWithValues: states.prefix(count).map { ($0, complete[$0]!) })
            XCTAssertThrowsError(try UIGeometry.record(captures, expectedStates: states,
                hasProblems: false, to: directory.path))
            XCTAssertEqual(try Data(contentsOf: path), original)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
        }
    }

    func testEmptyStateAndCaptureProblemsCannotPass() throws {
        let directory = try temporaryDirectory()
        var captures = complete
        captures[states[4]] = [:]
        XCTAssertThrowsError(try UIGeometry.record(captures, expectedStates: states,
            hasProblems: false, to: directory.path))
        XCTAssertThrowsError(try UIGeometry.record(complete, expectedStates: states,
            hasProblems: true, to: directory.path))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    func testWrongOrDuplicateStateNamesCannotSubstituteForSixStates() throws {
        let directory = try temporaryDirectory()
        var captures = complete
        captures["unexpected"] = captures.removeValue(forKey: states[5])
        XCTAssertThrowsError(try UIGeometry.record(captures, expectedStates: states,
            hasProblems: false, to: directory.path))
        XCTAssertThrowsError(try UIGeometry.record(complete, expectedStates: Array(repeating: states[0], count: 6),
            hasProblems: false, to: directory.path))
    }

    func testWriteFailureIsReported() throws {
        let directory = try temporaryDirectory()
        let file = directory.appendingPathComponent("not-a-directory")
        try Data("fixture".utf8).write(to: file)
        XCTAssertThrowsError(try UIGeometry.record(complete, expectedStates: states,
            hasProblems: false, to: file.path))
    }

    func testAllSixStatesRoundTripBeforeSuccessIsReturned() throws {
        let directory = try temporaryDirectory()
        XCTAssertEqual(try UIGeometry.record(complete, expectedStates: states,
            hasProblems: false, to: directory.path), 6)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 6)
        for state in states {
            XCTAssertEqual(UIGeometry.read(directory.appendingPathComponent(state + ".json").path), complete[state])
        }
    }
}
