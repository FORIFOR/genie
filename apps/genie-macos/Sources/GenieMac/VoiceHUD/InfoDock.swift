import AppKit
import SwiftUI

// MARK: - いまの情報（天気・ニュース）

/// 天気・ニュースの答え。外側は `DockCardScaffold`（回答面と同じ幅・縁・見出しの操作）、
/// 中身だけを種類ごとの段にする（docs/ux-benchmark/compare/info-card/ROUND.md）。
///
/// 数字は取得元の値だけ。出所（Open-Meteo.com / NHK / Google ニュース）と取得時刻を必ず出す。
struct InfoDock: View {
    let card: InfoCard

    var body: some View {
        DockCardScaffold(symbol: card.kind == .weather ? "cloud.sun" : "newspaper",
                         title: title, copyText: card.text,
                         sources: card.sources.map(\.name), fetchedAt: card.fetchedAt,
                         identifier: "info") {
            switch card.kind {
            case .weather: if let weather = card.weather { WeatherBody(weather: weather) }
            case .news: if let news = card.news { NewsBody(news: news) }
            }
        }
    }

    private var title: String {
        switch card.kind {
        case .weather:
            guard let weather = card.weather else { return "天気" }
            if weather.days.count == 1, let day = weather.days.first { return "\(day.label)の\(weather.place)" }
            return "\(weather.place)の天気"
        case .news:
            if let topic = card.news?.topic { return "「\(topic)」のニュース" }
            return "主なニュース"
        }
    }
}

private func degrees(_ value: Double?) -> String {
    guard let value else { return "—" }
    return "\(Int(value.rounded()))°"
}

/// 1 日なら「絵・温度・天気」を 1 つの塊で、複数日なら日ごとの列を横に並べる。
private struct WeatherBody: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let weather: InfoCard.Weather

    var body: some View {
        if weather.days.count == 1, let day = weather.days.first {
            single(day)
        } else {
            HStack(alignment: .top, spacing: 0) {
                ForEach(weather.days, id: \.date) { day in
                    column(day).frame(maxWidth: .infinity)
                }
            }
            .accessibilityIdentifier("infoWeatherDays")
        }
    }

    private func single(_ day: InfoCard.Weather.Day) -> some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: InfoCard.Weather.symbol(for: day.code))
                .symbolRenderingMode(.multicolor)
                .font(.system(size: 34))
                .frame(width: 44)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(day.summary)
                        .font(.system(size: S.type(Metrics.dockSpeechSize), weight: .semibold))
                        .foregroundStyle(Palette.text(dark))
                    if let now = weather.current {
                        Text("いま \(degrees(now.temperature))")
                            .font(.system(size: S.type(Metrics.dockMetaSize)))
                            .foregroundStyle(Palette.muted(dark))
                    }
                }
                HStack(spacing: 12) {
                    Text("最高 \(degrees(day.high))")
                    Text("最低 \(degrees(day.low))")
                    if let p = day.precipitation { Text("降水 \(p)%") }
                }
                .font(.system(size: S.type(Metrics.dockRowSize)))
                .foregroundStyle(Palette.text(dark))
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("infoWeatherDay")
    }

    private func column(_ day: InfoCard.Weather.Day) -> some View {
        VStack(spacing: 5) {
            Text(day.label)
                .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                .foregroundStyle(Palette.muted(dark))
                .lineLimit(1)
            Image(systemName: InfoCard.Weather.symbol(for: day.code))
                .symbolRenderingMode(.multicolor)
                .font(.system(size: 22))
                .frame(height: 26)
                .accessibilityLabel(day.summary)
            Text("\(degrees(day.high)) / \(degrees(day.low))")
                .font(.system(size: S.type(Metrics.dockRowSize)))
                .foregroundStyle(Palette.text(dark))
                .lineLimit(1)
            Text(day.precipitation.map { "降水 \($0)%" } ?? "—")
                .font(.system(size: S.type(Metrics.dockLabelSize)))
                .foregroundStyle(Palette.muted(dark))
        }
        .accessibilityElement(children: .combine)
    }
}

/// 見出しと、媒体・時刻の 2 段。本文は出さない。押すとブラウザで記事を開く。
private struct NewsBody: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let news: InfoCard.News

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(news.items.enumerated()), id: \.offset) { index, item in
                if index > 0 { Rectangle().fill(Color.hairline(dark)).frame(height: 0.5) }
                row(item)
            }
        }
        .accessibilityIdentifier("infoNewsItems")
    }

    private func row(_ item: InfoCard.News.Item) -> some View {
        Button { open(item) } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.text(dark))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let meta = meta(item) {
                    Text(meta)
                        .font(.system(size: S.type(Metrics.dockLabelSize)))
                        .foregroundStyle(Palette.muted(dark))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(item.url)
    }

    private func meta(_ item: InfoCard.News.Item) -> String? {
        let when = item.publishedAt.map {
            let f = RelativeDateTimeFormatter()
            f.locale = Locale(identifier: "ja_JP")
            f.unitsStyle = .short
            return f.localizedString(for: $0, relativeTo: Date())
        }
        let parts = [item.source, when].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// 取得元の RSS が返した https のリンクだけを開く。
    private func open(_ item: InfoCard.News.Item) {
        guard let url = URL(string: item.url), url.scheme == "https" else { return }
        NSWorkspace.shared.open(url)
    }
}
