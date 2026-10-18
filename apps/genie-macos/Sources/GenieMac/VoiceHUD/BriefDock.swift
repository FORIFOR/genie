import AppKit
import SwiftUI

// MARK: - 今日のまとめ（先回り 段階1）

/// 今日のまとめ。外側は `DockCardScaffold`（DESIGN.md §8）。中身は「要点」と、情報源ごとの短い段。
/// 取れなかった情報源は「未更新」と理由を出す（「変化なし」に見せない）。数字・見出しは取得元の値だけ。
struct BriefDock: View {
    let card: BriefCard

    var body: some View {
        DockCardScaffold(symbol: "sun.horizon", title: "今日のまとめ", copyText: card.text,
                         sources: sources, fetchedAt: card.generated, identifier: "brief") {
            BriefBody(card: card)
        }
    }

    private var sources: [String] {
        var names: [String] = []
        for section in card.sections where section.status == "ok" {
            for source in section.sources where !names.contains(source.name) { names.append(source.name) }
        }
        return names
    }
}

private struct BriefBody: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let card: BriefCard
    /// 段ごとに出す行の上限（カードの高さの上限 `dockCardMaxHeight` に収める）。
    private static let maxLines = ["calendar": 2, "weather": 1, "attention": 2, "mail": 2, "news": 2, "markets": 2]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !card.highlights.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(card.highlights.prefix(2).enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(size: S.type(Metrics.dockRowSize), weight: .medium))
                            .foregroundStyle(Palette.text(dark))
                            .lineLimit(1)
                    }
                }
                .accessibilityIdentifier("briefHighlights")
            }
            ForEach(Array(card.sections.enumerated()), id: \.offset) { index, section in
                if index > 0 || !card.highlights.isEmpty { Rectangle().fill(Color.hairline(dark)).frame(height: 0.5) }
                sectionView(section)
            }
        }
    }

    private func sectionView(_ section: BriefCard.Section) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(section.title)
                .font(.system(size: S.type(Metrics.dockLabelSize), weight: .medium))
                .foregroundStyle(Palette.muted(dark))
                .frame(width: 64, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                if section.status != "ok" {
                    Text((section.status == "stale" ? "未更新" : "なし") + (section.reason.map { "・" + $0 } ?? ""))
                        .font(.system(size: S.type(Metrics.dockLabelSize)))
                        .foregroundStyle(Palette.muted(dark))
                        .lineLimit(1)
                }
                if section.lines.isEmpty && section.status == "ok" {
                    Text(section.id == "calendar" ? "今日の予定はありません" : "ありません")
                        .font(.system(size: S.type(Metrics.dockLabelSize)))
                        .foregroundStyle(Palette.muted(dark))
                } else if !section.lines.isEmpty {
                    let limit = Self.maxLines[section.id] ?? 2
                    ForEach(Array(section.lines.prefix(limit).enumerated()), id: \.offset) { _, line in
                        lineView(line)
                    }
                    // 天気の 2 行目以降（予定に重なる雨）は要点に出しているので「ほか」と数えない。
                    if section.lines.count > limit, section.id != "weather" {
                        Text("ほか \(section.lines.count - limit) 件")
                            .font(.system(size: S.type(Metrics.dockLabelSize)))
                            .foregroundStyle(Palette.muted(dark))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("briefSection-" + section.id)
    }

    @ViewBuilder
    private func lineView(_ line: BriefCard.Line) -> some View {
        let text = Text(line.text)
            .font(.system(size: S.type(Metrics.dockLabelSize + 2)))
            .foregroundStyle(Palette.text(dark))
            .lineLimit(1)
        if let raw = line.url, let url = URL(string: raw), url.scheme == "https" {
            Button { NSWorkspace.shared.open(url) } label: { text.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .help(raw)
        } else {
            text
        }
    }
}
