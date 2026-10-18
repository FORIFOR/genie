import XCTest
@testable import GenieMac

/// 作業面の「いま操作している画面」（DESIGN.md §8.1）。`live.json` の読み方。
final class LiveScreenTests: XCTestCase {
    private let dir = URL(fileURLWithPath: "/tmp/genie-live-test", isDirectory: true)
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func json(image: String = "cv-0a1b2c3d-1111-2222-3333-444455556666.png", age: TimeInterval = 2,
                      origin: String? = "https://www.mcdonalds.co.jp", schema: Int = 1) -> Data {
        var raw: [String: Any] = ["schema": schema, "image": image, "at": (now.timeIntervalSince1970 - age) * 1000,
                                  "width": 1280, "height": 800, "bundleId": "com.apple.Safari"]
        if let origin { raw["origin"] = origin }
        return try! JSONSerialization.data(withJSONObject: raw)
    }

    func testReadsTheLatestImageAndWhichSite() {
        let frame = LiveScreenFrame.parse(json(), directory: dir, now: now)
        XCTAssertEqual(frame?.imageURL.lastPathComponent, "cv-0a1b2c3d-1111-2222-3333-444455556666.png")
        XCTAssertEqual(frame?.host, "www.mcdonalds.co.jp")
        XCTAssertEqual(Facts.liveScreenCaption(host: frame?.host, seconds: 2), "www.mcdonalds.co.jp を操作中・2秒前")
    }

    /// 止まった画面を「いま」と見せない。
    func testHidesAStaleImage() {
        XCTAssertNil(LiveScreenFrame.parse(json(age: LiveScreenFrame.staleAfter + 1), directory: dir, now: now))
    }

    /// 任意の文字列をパスにしない（置き場所の外・別の名前を読まない）。
    func testRefusesNamesOutsideTheFolder() {
        for name in ["../secret.png", "cv-../../x.png", "/etc/passwd", "photo.png", "cv-ABC.png"] {
            XCTAssertNil(LiveScreenFrame.parse(json(image: name), directory: dir, now: now), name)
        }
        XCTAssertNil(LiveScreenFrame.parse(json(schema: 2), directory: dir, now: now))
    }

    func testWithoutAnHttpsOriginSaysOnlyThatItIsOperating() {
        XCTAssertNil(LiveScreenFrame.parse(json(origin: nil), directory: dir, now: now)?.host)
        XCTAssertNil(LiveScreenFrame.parse(json(origin: "http://example.com"), directory: dir, now: now)?.host)
        XCTAssertEqual(Facts.liveScreenCaption(host: nil, seconds: 0), "操作中の画面・0秒前")
    }
}
