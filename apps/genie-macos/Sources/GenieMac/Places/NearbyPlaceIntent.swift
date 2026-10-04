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

    /// 製品の作業・引用・否定・サービスについての質問。いま本人のために頼んでいる依頼ではない。
    static let notAPersonalRequest = "実装|機能|アプリ|api|ui|ux|コード|システム|紹介文|記事|台本|翻訳|英訳|とは|仕組み|方法|キャンセル|取り消|予約済|注文済|購入済|予約した(?!い)|注文した(?!い)|しない|しなく|しません|するな|してはいけ|してはだめ|してはダメ|予約サイト|注文サイト|予約画面|注文画面|macbook|mac mini|mac studio|パソコン|新しいマック|マックブック|do not|don't|cancel|implement|feature|code|explain|translate"

    static func detect(_ request: String) -> NearbyPlaceIntent? {
        let text = request.lowercased()
        func matches(_ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
        guard !matches(Self.notAPersonalRequest),
              !matches("探さない|調べない|行かない|いらない|要らない|不要"),
              matches("近く|近所|周辺|最寄り|この辺|付近|近場|nearby|near me|closest|nearest") else { return nil }
        let found = brands.filter { matches($0.words) }
        return found.count == 1 ? found[0].intent : nil
    }
}
