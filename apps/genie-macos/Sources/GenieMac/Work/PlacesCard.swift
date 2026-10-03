import Foundation

/// 近くの店の答え（`NearbyPlaces.search` が作る）。Google Places API (New) の値と、Maps Static API の地図画像。
///
/// Places の内容は Google の規約で保存に制限があるので、画面に出すだけで Work にも disk にも残さない。
/// 地図は Google の地図だけ（Places の結果を他社の地図に載せてはいけない）。
struct PlacesCard: Equatable {
    struct Place: Equatable, Identifiable {
        let id: String
        let name: String
        let address: String
        let latitude: Double
        let longitude: Double
        let rating: Double?
        let ratingCount: Int?
        let openNow: Bool?
        /// Google マップでその店を開く URL（取得元が返した https だけ）。
        let mapsURL: URL?
        /// 現在地からの直線距離（m）。端末で計算する。
        let distance: Double
    }

    /// 探したもの（「スターバックス」）。
    let query: String
    /// 近い順。カードに出す数だけ。
    let places: [Place]
    /// Maps Static API の地図（PNG）。取れなければ nil で、地図の枠に理由の文を出す。
    let map: Data?
    let fetchedAt: Date

    /// コピー・読み上げ用の文。
    var text: String {
        guard !places.isEmpty else { return "近くに\(query)が見つかりませんでした。" }
        let lines = places.enumerated().map { i, p in "\(i + 1). \(p.name)（\(Self.distanceLabel(p.distance))）\(p.address)" }
        return (["近くの\(query)"] + lines).joined(separator: "\n")
    }

    /// 会話（Gemini）へ返す文。**件数だけ**。店名・住所・位置は返さない（docs/privacy-egress.md）。
    var conversationText: String {
        places.isEmpty ? "近くに\(query)が見つかりませんでした。"
                       : "近くの\(query)を\(places.count)件、画面に出しました。"
    }

    var hasContent: Bool { !places.isEmpty }

    static func distanceLabel(_ meters: Double) -> String {
        meters < 1000 ? "\(Int((meters / 10).rounded()) * 10)m"
                      : String(format: "%.1fkm", meters / 1000)
    }
}
