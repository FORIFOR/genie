import Foundation

/// 「近くのスタバ」のような、**いま近くの店を探してほしい**依頼。
///
/// 店は表で持ち、後から足せる。近さの語と店の語の両方があり、製品の話・否定・引用ではないときだけ
/// （`notAPersonalRequest`）。ほかは従来どおりの経路へ流す。
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

    /// 店の種類（名前で絞らない）。ブランドに当たらなかったときに見る。上から順に、最初に当たったもの。
    static let categories: [(words: String, intent: NearbyPlaceIntent)] = [
        ("ラーメン", NearbyPlaceIntent(display: "ラーメン屋さん", query: "ラーメン", nameMustContain: [])),
        ("寿司|すし|鮨", NearbyPlaceIntent(display: "お寿司屋さん", query: "寿司", nameMustContain: [])),
        ("焼肉|焼き肉", NearbyPlaceIntent(display: "焼肉屋さん", query: "焼肉", nameMustContain: [])),
        ("居酒屋", NearbyPlaceIntent(display: "居酒屋", query: "居酒屋", nameMustContain: [])),
        ("カフェ|喫茶", NearbyPlaceIntent(display: "カフェ", query: "カフェ", nameMustContain: [])),
        ("コンビニ", NearbyPlaceIntent(display: "コンビニ", query: "コンビニ", nameMustContain: [])),
        ("ご飯|ごはん|飯屋|めし|レストラン|食事|ランチ|ディナー|飲食店|食べる(ところ|所|店)|食べられる|restaurant|food",
         NearbyPlaceIntent(display: "ご飯屋さん", query: "レストラン", nameMustContain: [])),
    ]

    /// 製品の作業・引用・否定・サービスについての質問。いま本人のために頼んでいる依頼ではない。
    static let notAPersonalRequest = "実装|機能|アプリ|api|ui|ux|コード|システム|紹介文|記事|台本|翻訳|英訳|とは|仕組み|方法|キャンセル|取り消|予約済|注文済|購入済|予約した(?!い)|注文した(?!い)|しない|しなく|しません|するな|してはいけ|してはだめ|してはダメ|予約サイト|注文サイト|予約画面|注文画面|macbook|mac mini|mac studio|パソコン|新しいマック|マックブック|do not|don't|cancel|implement|feature|code|explain|translate"

    static func detect(_ request: String) -> NearbyPlaceIntent? {
        let text = request.lowercased()
        func matches(_ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
        guard !matches(Self.notAPersonalRequest),
              !matches("探さない|調べない|行かない|いらない|要らない|不要"),
              matches("近く|近所|周辺|最寄り|この辺|付近|近場|nearby|near me|closest|nearest") else { return nil }
        let found = brands.filter { matches($0.words) }
        if found.count == 1 { return found[0].intent }
        guard found.isEmpty else { return nil }
        if let kind = categories.first(where: { matches($0.words) })?.intent { return kind }
        // 表に無い店名（「近くのマクドナルド」「最寄りのユニクロ」）: その名前で探し、名前で絞る。
        return named(in: request)
    }

    /// 「近くの〇〇」「〇〇の近く」から店名を取り出す。曖昧な語（店・ところ・場所）だけなら拾わない。
    static func named(in request: String) -> NearbyPlaceIntent? {
        // 注文・配達・予約は別の仕事（注文画面への引き継ぎ）。店探しにしない。
        guard request.range(of: "注文|デリバリー|配達|出前|予約", options: .regularExpression) == nil else { return nil }
        let patterns = ["(?:近く|近所|周辺|最寄り|この辺|付近|近場)の([^、。を？?！!\\s]{2,20}?)(?:を|は|って|に|で|が|の|まで|教えて|調べて|探して|$)",
                        "([^、。を？?！!\\s]{2,20}?)の(?:近く|最寄り)"]
        for p in patterns {
            guard let r = request.range(of: p, options: .regularExpression) else { continue }
            let found = String(request[r])
            guard let re = try? NSRegularExpression(pattern: p),
                  let m = re.firstMatch(in: found, range: NSRange(found.startIndex..., in: found)),
                  let nameRange = Range(m.range(at: 1), in: found) else { continue }
            let name = String(found[nameRange]).trimmingCharacters(in: .whitespaces)
            guard !["店", "お店", "ところ", "所", "場所", "建物", "駅", "人", "天気", "気温", "雨", "ニュース", "地震", "時間"].contains(name),
                  name.range(of: "^(?:おすすめ|いい|良い)", options: .regularExpression) == nil else { continue }
            return NearbyPlaceIntent(display: name, query: name, nameMustContain: [name])
        }
        return nil
    }
}
