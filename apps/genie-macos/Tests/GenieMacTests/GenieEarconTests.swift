import XCTest
@testable import GenieMac

@MainActor
final class GenieEarconTests: XCTestCase {
    func testStartGlidesUpEndGlidesDownAndBothAreShortAndQuiet() {
        for kind in [GenieEarcon.Kind.start, .end] {
            let s = GenieEarcon.samples(kind)
            XCTAssertLessThan(Double(s.count) / GenieEarcon.sampleRate, 0.35, "合図は短い")
            let peak = s.map { abs(Int($0)) }.max() ?? 0
            XCTAssertGreaterThan(peak, 1000, "聞こえる")
            XCTAssertLessThan(Double(peak) / Double(Int16.max), 0.35, "通知音より控えめ")
            XCTAssertLessThan(abs(Int(s.first!)), 200, "立ち上がりでクリック音を出さない")
            XCTAssertLessThan(abs(Int(s.last!)), 200, "終わりでクリック音を出さない")
        }
        // 前の 1/4 と後ろの 1/4 の高さを、ゼロ交差の数で比べる（始まり = 上がる、終わり = 下がる）。
        func crossings(_ s: ArraySlice<Int16>) -> Int { zip(s, s.dropFirst()).filter { ($0 < 0) != ($1 < 0) }.count }
        for (kind, rises) in [(GenieEarcon.Kind.start, true), (.end, false)] {
            let s = GenieEarcon.samples(kind), q = s.count / 4
            let head = crossings(s[..<q]), tail = crossings(s[(s.count - q)...])
            XCTAssertEqual(head < tail, rises, "\(kind) の高さの向き")
        }
    }

    func testWavHeaderMatchesSamples() {
        let d = GenieEarcon.wav(.start)
        XCTAssertEqual(String(data: d.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertEqual(d.count, 44 + GenieEarcon.samples(.start).count * 2)
    }
}
