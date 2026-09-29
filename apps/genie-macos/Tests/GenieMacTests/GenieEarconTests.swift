import XCTest
@testable import GenieMac

@MainActor
final class GenieEarconTests: XCTestCase {
    func testStartRisesEndFallsAndBothAreShortAndQuiet() {
        for kind in [GenieEarcon.Kind.start, .end] {
            let s = GenieEarcon.samples(kind)
            XCTAssertLessThan(Double(s.count) / GenieEarcon.sampleRate, 0.35, "合図は短い")
            let peak = s.map { abs(Int($0)) }.max() ?? 0
            XCTAssertGreaterThan(peak, 1000, "聞こえる")
            XCTAssertLessThan(Double(peak) / Double(Int16.max), 0.35, "通知音より控えめ")
            XCTAssertLessThan(abs(Int(s.first!)), 200, "立ち上がりでクリック音を出さない")
            XCTAssertLessThan(abs(Int(s.last!)), 200, "終わりでクリック音を出さない")
        }
        // 最初の 2 音目が入る前の区間の高さを、ゼロ交差の数で比べる（始まり = 低→高、終わり = 高→低）。
        func crossings(_ s: [Int16]) -> Int { zip(s, s.dropFirst()).filter { ($0 < 0) != ($1 < 0) }.count }
        let head = Int(GenieEarcon.stagger * GenieEarcon.sampleRate) - 1
        XCTAssertLessThan(crossings(Array(GenieEarcon.samples(.start)[..<head])), crossings(Array(GenieEarcon.samples(.end)[..<head])))
    }

    func testWavHeaderMatchesSamples() {
        let d = GenieEarcon.wav(.start)
        XCTAssertEqual(String(data: d.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertEqual(d.count, 44 + GenieEarcon.samples(.start).count * 2)
    }
}
