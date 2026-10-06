import Foundation

/// 今日のまとめ（`genie.brief/v1`、@genie/contracts brief.ts の写し。正本は TypeScript 側の zod）。
/// 予定・天気・対応が要るもの・ニュース・監視銘柄を、出所と取得時刻つきで 1 枚にしたもの。
struct BriefCard: Equatable, Codable {
    static let schema = "genie.brief/v1"

    struct Line: Equatable, Codable {
        let text: String
        var time: String?
        var url: String?
        var ref: String?
    }
    struct Source: Equatable, Codable {
        let name: String
        let url: String
    }
    struct Section: Equatable, Codable {
        /// calendar / weather / attention / news / markets
        let id: String
        let title: String
        /// ok: 取れた / stale: 取れなかった（未更新）/ none: 情報源が無い・未設定
        let status: String
        var reason: String?
        let fetchedAt: String?
        let sources: [Source]
        let lines: [Line]
    }

    let schema: String
    /// その人の今日（YYYY-MM-DD）
    let date: String
    let generatedAt: String
    /// 画面の短い文（予定の題名を含む）
    let text: String
    /// 会話（Gemini Live）へ渡してよい文。件数・時刻・状態・公開の天気だけ（DESIGN.md §8）。
    let talk: String
    let highlights: [String]
    let sections: [Section]

    var hasContent: Bool { !sections.isEmpty }
    var generated: Date? { ISO8601DateFormatter.brief.date(from: generatedAt) }

    static func decode(_ body: String) -> BriefCard? {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let data = body.data(using: .utf8), let card = try? decoder.decode(BriefCard.self, from: data),
              card.schema == schema else { return nil }
        return card
    }

    func encoded() -> Data? {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return try? encoder.encode(self)
    }
}

extension ISO8601DateFormatter {
    /// 「2026-10-06T00:30:00.000Z」と小数秒なしの両方を読む。
    static let brief: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
