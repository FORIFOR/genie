import Foundation

/// 本人が変更できる、毎日の取得条件。保有銘柄や居場所の推定には使わない。
struct BriefPreferences: Codable, Equatable {
    var region = "東京都"
    var interests: [String] = []
    var watchlist = ["^N225", "^GSPC", "^IXIC"]
    var useCurrentLocation = true
    var hour = 8
    var minute = 0
    var enabled = true

    init() {}

    private enum CodingKeys: String, CodingKey { case region, interests, watchlist, useCurrentLocation, hour, minute, enabled }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        region = try values.decodeIfPresent(String.self, forKey: .region) ?? "東京都"
        interests = try values.decodeIfPresent([String].self, forKey: .interests) ?? []
        watchlist = try values.decodeIfPresent([String].self, forKey: .watchlist) ?? ["^N225", "^GSPC", "^IXIC"]
        // A saved manual location stays manual when upgrading from older preferences.
        useCurrentLocation = try values.decodeIfPresent(Bool.self, forKey: .useCurrentLocation) ?? false
        hour = try values.decodeIfPresent(Int.self, forKey: .hour) ?? 8
        minute = try values.decodeIfPresent(Int.self, forKey: .minute) ?? 0
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }

    var validationMessage: String? {
        if region.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || region.count > 80 {
            return "天気の地域を80文字以内で入力してください。"
        }
        if !(0...23).contains(hour) || !(0...59).contains(minute) { return "更新する時刻を確認してください。" }
        if interests.count > 3 || interests.contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.count > 40 }) {
            return "ニュースの話題は3つまで、各40文字以内で入力してください。"
        }
        if watchlist.count > 8 || watchlist.contains(where: { $0.range(of: #"^(?:\^[A-Za-z][A-Za-z0-9]{0,18}|[A-Za-z0-9][A-Za-z0-9.=\-]{0,19})$"#, options: .regularExpression) == nil }) {
            return "銘柄コードを8つまで入力してください（例: 7203.T、AAPL、^N225）。"
        }
        return nil
    }

    var normalized: BriefPreferences {
        var value = self
        value.region = region.trimmingCharacters(in: .whitespacesAndNewlines)
        value.interests = Self.unique(interests.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) })
        value.watchlist = Self.unique(watchlist.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() })
        return value
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
}
