import AppKit
import SwiftUI

// MARK: - 近くの店（地図と店の行）

/// 近くの店の答え。外側は `DockCardScaffold`、中身は Google の地図（番号のピン）と、同じ番号の店の行。
/// Google マップの検索結果と同じく「地図 → 近い順の一覧」で、行を押すと Google マップでその店を開く。
///
/// 数字（距離・評価・営業中）は取得元の値だけ（距離は現在地からの直線で、端末が計算する）。
/// docs/ux-benchmark/compare/places-card/ROUND.md
struct PlacesDock: View {
    let card: PlacesCard

    var body: some View {
        DockCardScaffold(symbol: "mappin.and.ellipse", title: "近くの\(card.query)", copyText: card.text,
                         sources: ["Google マップ"], fetchedAt: card.fetchedAt, identifier: "places") {
            PlacesMap(card: card)
            PlacesRows(places: card.places)
        }
    }
}

/// Maps Static API の地図。取れなかったときは同じ寸法の枠に理由を出す（面の高さを変えない）。
private struct PlacesMap: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let card: PlacesCard

    var body: some View {
        Group {
            if let data = card.map, let image = NSImage(data: data) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Text("地図を取得できませんでした")
                    .font(.system(size: S.type(Metrics.dockLabelSize)))
                    .foregroundStyle(Palette.muted(dark))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.hairline(dark))
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: S.metric(Metrics.dockCardImageHeight))
        .clipShape(RoundedRectangle(cornerRadius: Space.radiusSmall))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("地図。近くの\(card.query) \(card.places.count)件に番号のピン")
        .accessibilityIdentifier("placesMap")
    }
}

/// 店の行。番号（地図のピンと同じ）・店名・距離・評価・営業中を 1 行に。
private struct PlacesRows: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let places: [PlacesCard.Place]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(places.enumerated()), id: \.element.id) { index, place in
                if index > 0 { Rectangle().fill(Color.hairline(dark)).frame(height: 0.5) }
                row(index + 1, place)
            }
        }
        .accessibilityIdentifier("placesRows")
    }

    private func row(_ number: Int, _ place: PlacesCard.Place) -> some View {
        Button { open(place) } label: {
            HStack(spacing: 10) {
                Text("\(number)")
                    .font(.system(size: S.type(Metrics.dockMetaSize), weight: .semibold))
                    .foregroundStyle(Palette.muted(dark))
                    .frame(width: 14, alignment: .center)
                Text(place.name)
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.text(dark))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                Text(meta(place))
                    .font(.system(size: S.type(Metrics.dockLabelSize)))
                    .foregroundStyle(Palette.muted(dark))
                    .lineLimit(1)
                    .fixedSize()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(place.address)
        .accessibilityElement(children: .combine)
    }

    private func meta(_ place: PlacesCard.Place) -> String {
        var parts = [PlacesCard.distanceLabel(place.distance)]
        if let rating = place.rating {
            let count = place.ratingCount.map { "（\($0.formatted())）" } ?? ""
            parts.append(String(format: "★%.1f", rating) + count)
        }
        switch place.openNow {
        case true?: parts.append("営業中")
        case false?: parts.append("営業時間外")
        case nil: break
        }
        return parts.joined(separator: " · ")
    }

    /// 取得元が返した Google マップの https のリンクだけを開く。
    private func open(_ place: PlacesCard.Place) {
        guard let url = place.mapsURL, url.scheme == "https" else { return }
        NSWorkspace.shared.open(url)
    }
}
