import Foundation

/// いまの情報（天気・ニュース）の答え。端末の `info.lookup` が作る成果物
/// （`workers/agent-host/src/current-info/envelope.ts`、`genie.info/v1`）をそのまま読む。
///
/// 読めない・知らない種類なら nil にして、本文を文としてそのまま出す（従来どおり）。
/// `text` は必ずある。カードを描けないとき・読み上げ・Work の記録はこれを使う。
struct InfoCard: Equatable, Decodable {
    static let schema = "genie.info/v1"

    enum Kind: String, Decodable { case weather, news }

    struct Source: Equatable, Decodable {
        let name: String
        let url: String
    }

    struct Weather: Equatable, Decodable {
        struct Current: Equatable, Decodable {
            let temperature: Double
            let code: Int
            let summary: String
        }
        struct Day: Equatable, Decodable {
            let date: String
            let label: String
            let code: Int
            let summary: String
            let high: Double?
            let low: Double?
            let precipitation: Int?
        }
        let place: String
        let current: Current?
        let days: [Day]
    }

    struct News: Equatable, Decodable {
        struct Item: Equatable, Decodable {
            let title: String
            let url: String
            let source: String?
            let publishedAt: Date?

            enum CodingKeys: String, CodingKey { case title, url, source, publishedAt = "published_at" }
        }
        let topic: String?
        let items: [Item]
    }

    let kind: Kind
    let text: String
    let weather: Weather?
    let news: News?
    let sources: [Source]
    let fetchedAt: Date?

    private enum CodingKeys: String, CodingKey { case schema, kind, text, data, sources, fetchedAt = "fetched_at" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(String.self, forKey: .schema) == Self.schema else {
            throw DecodingError.dataCorruptedError(forKey: .schema, in: c, debugDescription: "unknown schema")
        }
        kind = try c.decode(Kind.self, forKey: .kind)
        text = try c.decode(String.self, forKey: .text)
        sources = (try? c.decode([Source].self, forKey: .sources)) ?? []
        fetchedAt = try? c.decode(Date.self, forKey: .fetchedAt)
        weather = kind == .weather ? try c.decodeIfPresent(Weather.self, forKey: .data) : nil
        news = kind == .news ? try c.decodeIfPresent(News.self, forKey: .data) : nil
    }

    /// 成果物の本文から読む。JSON でない・種類を知らないなら nil。
    static func decode(_ body: String) -> InfoCard? {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"), trimmed.contains(schema), let data = trimmed.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { d in
            let raw = try d.singleValueContainer().decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = f.date(from: raw) { return date }
            f.formatOptions = [.withInternetDateTime]
            if let date = f.date(from: raw) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: d.codingPath, debugDescription: "date"))
        }
        guard let card = try? decoder.decode(InfoCard.self, from: data),
              !card.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return card
    }

    /// カードに描くものがあるか。無ければ（場所が見つからない等）文だけの回答面にする。
    var hasContent: Bool {
        switch kind {
        case .weather: return !(weather?.days.isEmpty ?? true)
        case .news: return !(news?.items.isEmpty ?? true)
        }
    }
}

extension InfoCard.Weather {
    /// WMO weather code → SF Symbol。
    static func symbol(for code: Int) -> String {
        switch code {
        case 0: return "sun.max.fill"
        case 1, 2: return "cloud.sun.fill"
        case 3: return "cloud.fill"
        case 45, 48: return "cloud.fog.fill"
        case 51...57: return "cloud.drizzle.fill"
        case 61...67: return code >= 65 ? "cloud.heavyrain.fill" : "cloud.rain.fill"
        case 71...77, 85, 86: return "cloud.snow.fill"
        case 80...82: return "cloud.sun.rain.fill"
        case 95...: return "cloud.bolt.rain.fill"
        default: return "questionmark.circle"
        }
    }
}
