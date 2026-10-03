import Foundation

/// 「近くのスタバ」のような、**いま近くの店を探してほしい**依頼。
///
/// 店は表で持ち、後から足せる。近さの語と店の語の両方があり、製品の話・否定・引用ではないときだけ
/// （`ConsumerJourneyKind.notAPersonalRequest`）。ほかは従来どおりの経路へ流す。
struct NearbyPlaceIntent: Equatable {
    /// 画面と文に出す名前（「スターバックス」）。
    let display: String
    /// Places に送る検索語。
    let query: String
    /// 結果の店名にどれかを含むものだけを残す（同じ語で出てくる別の店を混ぜない）。
    let nameMustContain: [String]

    static let brands: [(words: String, intent: NearbyPlaceIntent)] = [
        ("スターバックス|スタバ|starbucks",
         NearbyPlaceIntent(display: "スターバックス", query: "スターバックス", nameMustContain: ["スターバックス", "starbucks"])),
    ]

    static func detect(_ request: String) -> NearbyPlaceIntent? {
        let text = request.lowercased()
        func matches(_ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
        guard !matches(ConsumerJourneyKind.notAPersonalRequest),
              !matches("探さない|調べない|行かない|いらない|要らない|不要"),
              matches("近く|近所|周辺|最寄り|この辺|付近|近場|nearby|near me|closest|nearest") else { return nil }
        let found = brands.filter { matches($0.words) }
        return found.count == 1 ? found[0].intent : nil
    }
}
