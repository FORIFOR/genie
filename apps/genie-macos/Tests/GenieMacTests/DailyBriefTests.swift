import XCTest
@testable import GenieMac

final class DailyBriefTests: XCTestCase {
    func testDeviceWeatherDoesNotSendCoordinatesToRemoteGateways() {
        for base in ["http://localhost:43123", "http://127.0.0.1:43123", "http://[::1]:43123"] {
            XCTAssertTrue(BriefStore.permitsDeviceWeather(base: base))
        }
        for base in ["https://example.com", "https://127.0.0.1.example.com", "file:///tmp/service", "http://user:pass@localhost"] {
            XCTAssertFalse(BriefStore.permitsDeviceWeather(base: base))
        }
    }

    func testCustomDailyTimeDisabledAndResumeCatchUp() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        func at(_ day: Int, _ hour: Int, _ minute: Int) -> Date {
            calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
        }
        var preferences = BriefPreferences()
        preferences.hour = 8; preferences.minute = 30
        XCTAssertFalse(BriefStore.isDue(latest: nil, now: at(10, 8, 29), calendar: calendar, preferences: preferences))
        XCTAssertTrue(BriefStore.isDue(latest: nil, now: at(10, 8, 30), calendar: calendar, preferences: preferences))
        XCTAssertTrue(BriefStore.isDue(latest: nil, now: at(13, 16, 0), calendar: calendar, preferences: preferences))
        preferences.enabled = false
        XCTAssertFalse(BriefStore.isDue(latest: nil, now: at(13, 16, 0), calendar: calendar, preferences: preferences))
    }

    func testPreferencesValidateProviderInputsAndDoNotInventHoldings() {
        var value = BriefPreferences()
        XCTAssertEqual(value.watchlist, ["^N225", "^GSPC", "^IXIC"])
        value.watchlist = ["AAPL", "7203.T", "USDJPY=X"]
        XCTAssertNil(value.validationMessage)
        value.watchlist = ["AAPL?redirect=https://example.com"]
        XCTAssertNotNil(value.validationMessage)
        for symbol in ["^", "A^B", "^1"] {
            value.watchlist = [symbol]
            XCTAssertNotNil(value.validationMessage, "providerが受け付けない銘柄を保存しない")
        }
        value.watchlist = []
        XCTAssertNil(value.validationMessage, "株価を表示しない設定を保存できる")
        value.interests = ["a", "b", "c", "d"]
        XCTAssertNotNil(value.validationMessage)
        value.interests = []; value.hour = 25
        XCTAssertNotNil(value.validationMessage)
    }

    @MainActor func testPreferencesPersistAndInvalidInputDoesNotReplaceSavedSettings() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("brief.json")
        let prefs = directory.appendingPathComponent("preferences.json")
        let store = BriefStore(fileURL: file, preferencesURL: prefs)
        var value = BriefPreferences()
        value.region = " 大阪府 "; value.watchlist = ["aapl", "AAPL"]; value.interests = ["科学", "科学"]
        value.hour = 9; value.minute = 15; value.enabled = false
        XCTAssertNil(store.updatePreferences(value))
        let restored = BriefStore(fileURL: file, preferencesURL: prefs)
        XCTAssertEqual(restored.preferences.region, "大阪府")
        XCTAssertEqual(restored.preferences.watchlist, ["AAPL"])
        XCTAssertEqual(restored.preferences.interests, ["科学"])
        XCTAssertEqual(restored.preferences.minute, 15)
        XCTAssertFalse(restored.preferences.enabled)
        value.region = " "
        XCTAssertNotNil(store.updatePreferences(value))
        XCTAssertEqual(store.preferences, restored.preferences)
        let attributes = try FileManager.default.attributesOfItem(atPath: prefs.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testMailAndPartialMarketResultsRoundTripWithoutLosingSuccessfulLines() throws {
        let body = #"""
        {"schema":"genie.brief/v1","date":"2026-10-10","generated_at":"2026-10-10T00:00:00Z",
         "text":"今日のまとめ","talk":"メールは1件です。","highlights":[],"sections":[
         {"id":"mail","title":"メール","status":"ok","fetched_at":"2026-10-10T00:00:00Z","sources":[{"name":"Gmail","url":"https://mail.google.com/"}],"lines":[{"text":"確認のお願い","subtitle":"送信者","received_at":"2026-10-10T00:00:00Z","url":"https://mail.google.com/mail/u/0/#all/123"}]},
         {"id":"markets","title":"株価","status":"stale","reason":"1件は未取得","fetched_at":"2026-10-10T00:00:00Z","sources":[],"lines":[{"text":"検証用価格 100 USD"}]}]}
        """#
        let card = try XCTUnwrap(BriefCard.decode(body))
        XCTAssertNotNil(card.generated, "小数秒のない時刻も表示できる")
        XCTAssertEqual(card.sections[0].lines[0].subtitle, "送信者")
        XCTAssertEqual(card.sections[1].lines.count, 1)
        XCTAssertEqual(BriefCard.decode(String(data: try XCTUnwrap(card.encoded()), encoding: .utf8)!), card)
    }
}
