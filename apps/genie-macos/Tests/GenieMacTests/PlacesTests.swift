import CoreLocation
import XCTest
@testable import GenieMac

/// 近くの店: 依頼の見分け、Places の要求と応答、会話へ返す文、カードの寸法。
final class PlacesTests: XCTestCase {
    private let here = CLLocation(latitude: 35.6595, longitude: 139.7005)   // 渋谷駅の近く
    private let response = #"""
    {"places":[
      {"id":"far","displayName":{"text":"スターバックス コーヒー 表参道店"},"formattedAddress":"東京都渋谷区神宮前4","location":{"latitude":35.6665,"longitude":139.7100},"rating":4.2,"userRatingCount":1500,"currentOpeningHours":{"openNow":true},"googleMapsUri":"https://maps.google.com/?cid=1"},
      {"id":"near","displayName":{"text":"スターバックス コーヒー 渋谷駅前店"},"formattedAddress":"東京都渋谷区道玄坂1","location":{"latitude":35.6598,"longitude":139.7008},"rating":3.9,"userRatingCount":2345,"currentOpeningHours":{"openNow":false},"googleMapsUri":"https://maps.google.com/?cid=2"},
      {"id":"other","displayName":{"text":"タリーズコーヒー 渋谷店"},"formattedAddress":"東京都渋谷区","location":{"latitude":35.6596,"longitude":139.7006}},
      {"id":"plain","displayName":{"text":"Starbucks Reserve"},"location":{"latitude":35.6700,"longitude":139.7200},"googleMapsUri":"http://example.com/x"}
    ]}
    """#

    // MARK: 依頼の見分け

    func testDetectsNearbyStarbucksRequests() {
        for text in ["近くのスターバックスを探して", "近所のスタバどこ？", "最寄りのスタバからデリバリーしたい", "starbucks near me"] {
            XCTAssertEqual(NearbyPlaceIntent.detect(text)?.display, "スターバックス", text)
        }
    }

    func testLeavesOtherRequestsToTheNormalRoute() {
        for text in ["スタバの新作を教えて", "近くの天気は？", "近くのスタバを探す機能を実装して",
                     "近くのスタバに行く方法", "近くのスタバには行かない", "近くのマックでデリバリーを注文して"] {
            XCTAssertNil(NearbyPlaceIntent.detect(text), text)
        }
        // マックデリバリーの準備画面とは取り合わない。
    }

    // MARK: Places の要求と応答

    func testSearchRequestPutsTheKeyInAHeaderNotTheURLOrBody() throws {
        let request = PlacesClient.searchRequest(query: "スターバックス", near: here.coordinate, apiKey: "SECRET")
        XCTAssertEqual(request.url, PlacesClient.searchEndpoint)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Goog-Api-Key"), "SECRET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Goog-FieldMask"), PlacesClient.fieldMask)
        XCTAssertFalse(request.url!.absoluteString.contains("SECRET"))
        let body = try XCTUnwrap(request.httpBody.flatMap { String(data: $0, encoding: .utf8) })
        XCTAssertFalse(body.contains("SECRET"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
        XCTAssertEqual(json["textQuery"] as? String, "スターバックス")
        XCTAssertEqual(json["rankPreference"] as? String, "DISTANCE")
        // 送るのは検索語と緯度経度だけ。
        XCTAssertEqual(Set(json.keys), ["textQuery", "languageCode", "regionCode", "rankPreference", "maxResultCount", "locationBias"])
    }

    func testResultsKeepOnlyTheBrandNearestFirstAndOnlyHttpsLinks() throws {
        let places = try PlacesClient.places(from: Data(response.utf8), near: here,
                                             mustContain: ["スターバックス", "starbucks"], limit: 3)
        XCTAssertEqual(places.map(\.id), ["near", "far", "plain"])
        XCTAssertLessThan(places[0].distance, 100)
        XCTAssertEqual(places[0].openNow, false)
        XCTAssertEqual(places[0].ratingCount, 2345)
        XCTAssertNil(places[2].mapsURL, "http のリンクは開かない")
        XCTAssertEqual(try PlacesClient.places(from: Data(response.utf8), near: here,
                                               mustContain: ["スターバックス"], limit: 1).map(\.id), ["near"])
        XCTAssertTrue(try PlacesClient.places(from: Data(#"{}"#.utf8), near: here, mustContain: ["x"], limit: 3).isEmpty)
    }

    func testStaticMapCarriesNumberedPinsAndTheKeyOnlyThere() throws {
        let places = try PlacesClient.places(from: Data(response.utf8), near: here, mustContain: ["スターバックス"], limit: 2)
        let url = PlacesClient.staticMapURL(center: here.coordinate, places: places, width: 480, height: 150, apiKey: "SECRET")
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(url.host, "maps.googleapis.com")
        XCTAssertEqual(items.first { $0.name == "size" }?.value, "480x150")
        let markers = items.filter { $0.name == "markers" }.compactMap(\.value)
        XCTAssertEqual(markers.count, 3)
        XCTAssertTrue(markers[1].contains("label:1|35.6598,139.7008"))
        XCTAssertTrue(markers[2].contains("label:2|"))
        XCTAssertEqual(items.last?.name, "key")
    }

    // MARK: 会話・カード

    func testConversationGetsOnlyTheCount() throws {
        let places = try PlacesClient.places(from: Data(response.utf8), near: here, mustContain: ["スターバックス"], limit: 3)
        let card = PlacesCard(query: "スターバックス", places: places, map: nil, fetchedAt: Date())
        XCTAssertEqual(card.conversationText, "近くのスターバックスを2件、画面に出しました。")
        for place in places {
            XCTAssertFalse(card.conversationText.contains(place.name))
            XCTAssertFalse(card.conversationText.contains(place.address))
        }
        XCTAssertTrue(card.text.contains("渋谷駅前店"))
        XCTAssertEqual(DockCard.places(card).text, card.text)
        XCTAssertFalse(PlacesCard(query: "スターバックス", places: [], map: nil, fetchedAt: Date()).hasContent)
    }

    func testDistanceLabel() {
        XCTAssertEqual(PlacesCard.distanceLabel(34), "30m")
        XCTAssertEqual(PlacesCard.distanceLabel(996), "1000m")
        XCTAssertEqual(PlacesCard.distanceLabel(1234), "1.2km")
    }

    @MainActor
    func testSettingsCountSearchesPerMonthAndRequireALimit() {
        let suite = "PlacesTests-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = PlacesSettings(defaults: defaults, initialHasKey: true)
        let sept = Date(timeIntervalSince1970: 1_790_000_000)   // 2026-09
        let oct = sept.addingTimeInterval(40 * 86_400)
        XCTAssertFalse(settings.canSearch(at: sept), "キーがあっても、上限を決めるまでは探さない")
        settings.setMonthlyLimit(2)
        XCTAssertTrue(settings.canSearch(at: sept))
        settings.recordSearch(at: sept); settings.recordSearch(at: sept)
        XCTAssertEqual(settings.usedThisMonth(at: sept), 2)
        XCTAssertFalse(settings.canSearch(at: sept), "上限に達したら探さない")
        XCTAssertEqual(settings.usedThisMonth(at: oct), 0, "月が替われば数え直す")
        XCTAssertTrue(settings.canSearch(at: oct))
        settings.recordSearch(at: oct)
        XCTAssertEqual(settings.usedThisMonth(at: oct), 1)
        let withoutKey = PlacesSettings(defaults: defaults, initialHasKey: false)
        XCTAssertFalse(withoutKey.canSearch(at: oct), "上限が残っていても、キーがなければ探さない")
    }

    @MainActor
    func testPlacesCardStaysWithinTheCardCeiling() throws {
        let places = try PlacesClient.places(from: Data(response.utf8), near: here,
                                             mustContain: ["スターバックス", "starbucks"], limit: 3)
        let size = DockPresentation.card(.places(PlacesCard(query: "スターバックス", places: places, map: nil, fetchedAt: Date()))).size()
        XCTAssertEqual(size.width, Metrics.dockResultWidth)
        XCTAssertLessThanOrEqual(size.height, Metrics.dockCardMaxHeight)
        XCTAssertGreaterThan(size.height, Metrics.dockCardImageHeight + 90, "地図と 3 行が入っている")
    }

    func testNearbyFoodAndShopKindsAreFoundWithoutNameFiltering() {
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのご飯屋さんを教えて")?.query, "レストラン")
        XCTAssertEqual(NearbyPlaceIntent.detect("この辺でラーメン食べたい")?.query, "ラーメン")
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのカフェ")?.query, "カフェ")
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのご飯屋さん")?.nameMustContain, [])
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのスタバ")?.display, "スターバックス", "a brand still wins")
        XCTAssertNil(NearbyPlaceIntent.detect("ご飯屋さんのアプリを実装して"))
        XCTAssertNil(NearbyPlaceIntent.detect("近くのご飯屋さんには行かない"))
    }

    func testAnyShopNameNearbyIsSearchedByName() {
        XCTAssertEqual(NearbyPlaceIntent.detect("最寄りのユニクロはどこ")?.query, "ユニクロ")
        XCTAssertEqual(NearbyPlaceIntent.detect("最寄りのユニクロはどこ")?.nameMustContain, ["ユニクロ"])
        XCTAssertEqual(NearbyPlaceIntent.detect("最寄りのユニクロはどこ")?.expectedTypes, [], "何の店か分からないので種類では選ばない")
        XCTAssertNil(NearbyPlaceIntent.detect("近くのお店を教えて"), "too vague to search by name")
    }

    // MARK: 略して呼ぶチェーン（実機 2026-10-16: 「近くのマック」で「㈱マック 東京営業所」だけが出た）

    func testMcDonaldsAliasesSearchTheOfficialName() {
        for text in ["近くのマック", "近くのマックを探して", "近くのマクド教えて", "近くのマクドナルドを調べて",
                     "mcdonald's near me", "nearest mcdonalds"] {
            let intent = NearbyPlaceIntent.detect(text)
            XCTAssertEqual(intent?.display, "マクドナルド", text)
            XCTAssertEqual(intent?.query, "マクドナルド", text)
            XCTAssertEqual(intent?.nameMustContain, ["マクドナルド", "mcdonald"], text)
            XCTAssertTrue(intent?.expectedTypes.contains("fast_food_restaurant") == true, text)
        }
        // 「マック」を含む別物は拾わない。
        XCTAssertNotEqual(NearbyPlaceIntent.detect("近くのマックスバリュ")?.display, "マクドナルド")
        XCTAssertNil(NearbyPlaceIntent.detect("近くのマックでデリバリーを注文して"))
    }

    func testOtherChainAliases() {
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのファミマ")?.query, "ファミリーマート")
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのセブン")?.query, "セブン-イレブン")
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのローソン")?.expectedTypes.contains("convenience_store"), true)
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのケンタ")?.display, "ケンタッキー")
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのモス")?.display, "モスバーガー")
        XCTAssertNotEqual(NearbyPlaceIntent.detect("近くのモスク")?.display, "モスバーガー")
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのドトール")?.query, "ドトールコーヒー")
        XCTAssertEqual(NearbyPlaceIntent.detect("近くのスタバ")?.query, "スターバックス")
    }

    func testFieldMaskAsksForTypesAndStatusButSendsNothingNew() throws {
        let fields = Set(PlacesClient.fieldMask.split(separator: ",").map(String.init))
        XCTAssertTrue(fields.isSuperset(of: ["places.types", "places.businessStatus"]))
        let request = PlacesClient.searchRequest(query: "マクドナルド", near: here.coordinate, apiKey: "SECRET")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
        XCTAssertEqual(json["textQuery"] as? String, "マクドナルド")
        XCTAssertEqual(Set(json.keys), ["textQuery", "languageCode", "regionCode", "rankPreference", "maxResultCount", "locationBias"])
    }

    private let mcResponse = #"""
    {"places":[
      {"id":"office","displayName":{"text":"㈱マック 東京営業所"},"location":{"latitude":35.6596,"longitude":139.7006},"types":["corporate_office","point_of_interest","establishment"],"businessStatus":"OPERATIONAL"},
      {"id":"mc","displayName":{"text":"マクドナルド 渋谷道玄坂店"},"location":{"latitude":35.6600,"longitude":139.6990},"types":["fast_food_restaurant","hamburger_restaurant","restaurant","food","point_of_interest","establishment"],"businessStatus":"OPERATIONAL"},
      {"id":"closed","displayName":{"text":"マクドナルド 渋谷センター街店"},"location":{"latitude":35.6597,"longitude":139.7004},"types":["fast_food_restaurant","restaurant"],"businessStatus":"CLOSED_PERMANENTLY"}
    ]}
    """#

    func testOfficeAndClosedShopsAreDroppedForAChain() throws {
        let intent = try XCTUnwrap(NearbyPlaceIntent.detect("近くのマック"))
        let places = try PlacesClient.places(from: Data(mcResponse.utf8), near: here, mustContain: intent.nameMustContain,
                                             expectedTypes: intent.expectedTypes, limit: 3)
        XCTAssertEqual(places.map(\.id), ["mc"])
        // 名前で絞らなくても（「マック」と同じ語を含む会社でも）、店の種類で事務所を外す。
        XCTAssertEqual(try PlacesClient.places(from: Data(mcResponse.utf8), near: here, mustContain: ["マック", "マクドナルド"],
                                               expectedTypes: intent.expectedTypes, limit: 3).map(\.id), ["mc"])
        // 種類を見ない検索でも、閉店した店は出さない。
        XCTAssertEqual(try PlacesClient.places(from: Data(mcResponse.utf8), near: here, mustContain: [], limit: 3).map(\.id),
                       ["office", "mc"])
    }

    func testSparseTypesDoNotEmptyTheList() throws {
        let sparse = #"""
        {"places":[
          {"id":"a","displayName":{"text":"マクドナルド 渋谷店"},"location":{"latitude":35.6598,"longitude":139.7008},"types":["point_of_interest","establishment"]},
          {"id":"b","displayName":{"text":"マクドナルド 原宿店"},"location":{"latitude":35.6700,"longitude":139.7020}}
        ]}
        """#
        XCTAssertEqual(try PlacesClient.places(from: Data(sparse.utf8), near: here, mustContain: ["マクドナルド"],
                                               expectedTypes: NearbyPlaceIntent.foodTypes, limit: 3).map(\.id), ["a", "b"])
        let onlyOffice = #"{"places":[{"id":"o","displayName":{"text":"マクドナルド 本社"},"location":{"latitude":35.66,"longitude":139.70},"types":["corporate_office"]}]}"#
        XCTAssertEqual(try PlacesClient.places(from: Data(onlyOffice.utf8), near: here, mustContain: ["マクドナルド"],
                                               expectedTypes: NearbyPlaceIntent.foodTypes, limit: 3).map(\.id), ["o"],
                       "事務所しか無いときは、名前で絞った一覧へ戻す")
    }
}
