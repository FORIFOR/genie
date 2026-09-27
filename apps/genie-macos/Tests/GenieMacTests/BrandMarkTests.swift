import XCTest
@testable import GenieMac

/// Genie の印。16pt 以下（メニューバー 13pt・Dock 12pt）は G を外した簡略版を使う（潰れるため）。
final class BrandMarkTests: XCTestCase {
    func testBothMarksDecodeAsTemplates() {
        for image in [GenieBrandMark.image, GenieBrandMark.small] {
            XCTAssertTrue(image.isTemplate)
            XCTAssertGreaterThan(image.representations.first?.pixelsHigh ?? 0, 40, "埋めた PNG が読めない")
        }
    }

    func testSmallSizesUseTheSimplifiedMark() {
        XCTAssertTrue(GenieBrandMark.mark(forHeight: 13).image === GenieBrandMark.small)
        XCTAssertTrue(GenieBrandMark.mark(forHeight: 16).image === GenieBrandMark.small)
        XCTAssertTrue(GenieBrandMark.mark(forHeight: 24).image === GenieBrandMark.image)
        let menu = GenieBrandMark.image(height: 13)
        XCTAssertEqual(menu.size.height, 13)
        XCTAssertEqual(menu.size.width, (13 * GenieBrandMark.smallAspect).rounded())
    }
}
