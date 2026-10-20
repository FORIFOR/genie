import XCTest
@testable import GenieMac

final class WakeVoicePrintTests: XCTestCase {
    private let d = WakeVoicePrint.dimension

    private func vector(_ seed: Int, noise: Float = 0) -> [Float] {
        var g = SystemRandomNumberGenerator()
        return (0..<d).map { i in (i % (seed + 2) == 0 ? 1 : 0) + Float.random(in: -noise...noise, using: &g) }
    }

    func testTooFewCallsAreNotLearned() {
        XCTAssertNil(WakeVoicePrint.make(embeddings: Array(repeating: vector(1), count: WakeVoicePrint.minimumCalls - 1)))
        // 形の違う embedding は数えない。
        XCTAssertNil(WakeVoicePrint.make(embeddings: Array(repeating: [Float](repeating: 1, count: 10), count: 20)))
    }

    func testThresholdStaysBetweenFloorAndCeiling() throws {
        // 録った呼びかけがよく似ていれば上限、ばらばらなら下限。
        let alike = try XCTUnwrap(WakeVoicePrint.make(embeddings: (0..<10).map { _ in vector(1, noise: 0.01) }))
        XCTAssertEqual(alike.threshold, WakeVoicePrint.ceiling)
        let apart = try XCTUnwrap(WakeVoicePrint.make(embeddings: (0..<10).map { vector($0 * 7 + 1) }))
        XCTAssertEqual(apart.threshold, WakeVoicePrint.floor)
    }

    func testSimilarityIsTheClosestCall() throws {
        let print = try XCTUnwrap(WakeVoicePrint.make(embeddings: (0..<6).map { vector($0 + 1) }))
        XCTAssertEqual(print.similarity(vector(3).map { $0 * 5 }), 1, accuracy: 1e-4)   // 大きさは見ない
        var unlike = [Float](repeating: 0, count: d); unlike[d - 1] = 1; unlike[d - 3] = -1
        XCTAssertLessThan(print.similarity(unlike), 0.2)
        XCTAssertEqual(print.similarity([1, 2, 3]), 0)
    }

    func testSavedPrintRoundTripsAndIsPrivate() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("vp-\(UUID().uuidString)/voiceprint.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let print = try XCTUnwrap(WakeVoicePrint.make(embeddings: (0..<6).map { vector($0 + 1) }))
        try print.save(to: url)
        XCTAssertEqual(WakeVoicePrint.load(from: url), print)
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
    }

    func testMalformedPrintIsIgnored() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("vp-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let good = try XCTUnwrap(WakeVoicePrint.make(embeddings: (0..<6).map { vector($0 + 1) }))
        for bad in [
            WakeVoicePrint(schema: 2, templates: good.templates, threshold: good.threshold, createdAt: good.createdAt),
            WakeVoicePrint(templates: good.templates, threshold: 0.2, createdAt: good.createdAt),   // 何でも通るしきい値
            WakeVoicePrint(templates: Array(good.templates.prefix(2)), threshold: good.threshold, createdAt: good.createdAt),
            WakeVoicePrint(templates: good.templates.map { Array($0.prefix(96)) }, threshold: good.threshold, createdAt: good.createdAt),
        ] {
            try JSONEncoder().encode(bad).write(to: url)
            XCTAssertNil(WakeVoicePrint.load(from: url))
        }
        try Data("{".utf8).write(to: url)
        XCTAssertNil(WakeVoicePrint.load(from: url))
    }

    func testCallsAreCutAtTheCues() {
        // 合図の 1 秒後から 3 秒ごと。2 回目は黙っていた。
        var audio = [Float](repeating: 0, count: 16_000 * 10)
        for k in [0, 2] {
            let start = Int((1.0 + 3.0 * Double(k) + 0.5) * 16_000)
            for i in 0..<8_000 { audio[start + i] = 0.3 * sin(Float(i) * 0.05) }
        }
        let calls = WakeVoicePrint.calls(in: audio, count: 3, interval: 3)
        XCTAssertEqual(calls.count, 2)
        for call in calls { XCTAssertEqual(Double(call.count) / 16_000, 0.5, accuracy: 0.03) }
    }
}
