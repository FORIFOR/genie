import XCTest
@testable import GenieMac

/// 天気・ニュースの成果物（genie.info/v1）はカードに、それ以外は従来どおり文に。
final class InfoCardTests: XCTestCase {
    private let weather = #"{"schema":"genie.info/v1","kind":"weather","text":"明日の東京都は雨。最高22℃、最低20℃、降水確率78%です。","data":{"place":"東京都","current":null,"days":[{"date":"2026-09-28","label":"明日","code":63,"summary":"雨","high":22.0,"low":19.5,"precipitation":78}]},"sources":[{"name":"Open-Meteo.com","url":"https://open-meteo.com/"}],"fetched_at":"2026-09-26T15:50:00.123Z"}"#
    private let news = #"{"schema":"genie.info/v1","kind":"news","text":"主なニュース（NHK）: 1. 見出し","data":{"topic":null,"items":[{"title":"見出し","url":"https://news.web.nhk/a","source":"NHK","published_at":"2026-09-26T05:00:00.000Z"},{"title":"二","url":"https://news.web.nhk/b","source":null,"published_at":null}]},"sources":[{"name":"NHK","url":"https://news.web.nhk/"}],"fetched_at":"2026-09-26T15:50:00Z"}"#

    func testWeatherEnvelopeBecomesACardAndReadableText() throws {
        let reply = VoiceHUDState.taskReply(status: "COMPLETED", artifactID: "a1") { weather }
        XCTAssertEqual(reply.phase, .complete)
        XCTAssertEqual(reply.text, "明日の東京都は雨。最高22℃、最低20℃、降水確率78%です。")
        guard case .info(let card) = try XCTUnwrap(reply.card) else { return XCTFail("expected an info card") }
        XCTAssertEqual(card.kind, .weather)
        XCTAssertEqual(card.weather?.days.first?.high, 22.0)
        XCTAssertEqual(card.weather?.days.first?.precipitation, 78)
        XCTAssertEqual(card.sources.map(\.name), ["Open-Meteo.com"])
        XCTAssertNotNil(card.fetchedAt)
        XCTAssertEqual(InfoCard.Weather.symbol(for: 63), "cloud.rain.fill")
        guard case .card(.info(let shown)) = VoiceHUDState.presentation(for: reply) else { return XCTFail("expected a card") }
        XCTAssertEqual(shown, card)
    }

    func testNewsEnvelopeKeepsOnlyHeadlinesAndSources() throws {
        let card = try XCTUnwrap(InfoCard.decode(news))
        XCTAssertEqual(card.kind, .news)
        XCTAssertEqual(card.news?.items.map(\.title), ["見出し", "二"])
        XCTAssertNotNil(card.news?.items.first?.publishedAt)
        XCTAssertNil(card.news?.items.last?.publishedAt)
    }

    func testNoDataFallsBackToTheSentence() {
        let body = #"{"schema":"genie.info/v1","kind":"weather","text":"「ほげ」の場所が見つかりませんでした。","data":null,"sources":[],"fetched_at":"2026-09-26T15:50:00Z"}"#
        let reply = VoiceHUDState.taskReply(status: "COMPLETED", artifactID: "a1") { body }
        XCTAssertEqual(reply.text, "「ほげ」の場所が見つかりませんでした。")
        XCTAssertEqual(VoiceHUDState.presentation(for: reply), .answer("「ほげ」の場所が見つかりませんでした。"))
    }

    func testOrdinaryAnswersAndUnknownSchemasStayText() {
        for body in ["# 答え\n本文", #"{"schema":"other/v1","kind":"weather","text":"x"}"#, #"{"schema":"genie.info/v1","kind":"quote","text":"x"}"#] {
            let reply = VoiceHUDState.taskReply(status: "COMPLETED", artifactID: "a1") { body }
            XCTAssertNil(reply.card, body)
            XCTAssertEqual(reply.text, body)
        }
    }

    @MainActor
    func testInfoDockStaysWithinItsDeclaredCeiling() throws {
        let card = try XCTUnwrap(InfoCard.decode(news))
        let size = DockPresentation.card(.info(card)).size()
        XCTAssertEqual(size.width, Metrics.dockResultWidth)
        XCTAssertLessThanOrEqual(size.height, Metrics.dockCardMaxHeight)
        XCTAssertGreaterThan(size.height, 60)
    }
}
