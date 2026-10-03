import AppKit
import SwiftUI

// MARK: - 例外のカード（DESIGN.md §8）

/// 例外のカードを種類ごとの中身に振り分ける。外側はどの種類も `DockCardScaffold`。
struct DockCardView: View {
    let card: DockCard

    var body: some View {
        switch card {
        case .info(let info): InfoDock(card: info)
        case .places(let places): PlacesDock(card: places)
        }
    }
}

/// 例外のカードの外側。回答面（`AnswerDock`）と同じ幅・同じ縁・同じ見出しの操作を持ち、
/// 中身だけを種類ごとに差し込む（docs/ux-benchmark/compare/info-card/ROUND.md で決めた形を全カードで共有する）。
///
/// 出所と取得時刻を必ず出す。値の由来を読めない答えにしない。
/// 高さは中身で決まり（`DockContentMeasure`）、`dockCardMaxHeight` を上限にする。
struct DockCardScaffold<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    /// 見出しの図形（SF Symbol）。
    let symbol: String
    let title: String
    /// 「コピー」で写す文。
    let copyText: String
    /// 出所の名前（取得元）。
    let sources: [String]
    let fetchedAt: Date?
    /// accessibility id の接頭辞。`dock<Prefix>` / `<prefix>Copy` / `<prefix>Dismiss` / `<prefix>Provenance`。
    let identifier: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            content
            provenance
            ConversationBar()
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .escapeKey { GenieStateStore.shared.dismissResult() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dock" + identifier.prefix(1).uppercased() + identifier.dropFirst())
    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(Palette.accent(dark))
            Text(title)
                .font(.system(size: S.type(Metrics.dockTitleSize), weight: .semibold))
                .foregroundStyle(Palette.text(dark))
                .lineLimit(1)
            Spacer(minLength: 0)
            Button { copy() } label: {
                Text(Facts.resultCopy)
                    .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                    .foregroundStyle(Palette.text(dark))
                    .frame(height: 28)
                    .padding(.horizontal, 9)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0.06))
            .accessibilityIdentifier("\(identifier)Copy")
            // 会話中は ✕ を出さない（カードを閉じるのか会話を終えるのかが分からない。終えるのは下の行）。
            if !VoiceHUDState.shared.conversation.isActive {
            Button { GenieStateStore.shared.dismissResult() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.muted(dark))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
            .accessibilityIdentifier("\(identifier)Dismiss")
            .accessibilityLabel("回答を閉じる")
            }
        }
    }

    /// 出所と取得時刻。
    private var provenance: some View {
        let names = sources.joined(separator: "・")
        let time = fetchedAt.map { " · \($0.formatted(date: .omitted, time: .shortened)) 取得" } ?? ""
        return Text("出所 \(names)\(time)")
            .font(.system(size: S.type(Metrics.dockLabelSize)))
            .foregroundStyle(Palette.muted(dark))
            .accessibilityIdentifier("\(identifier)Provenance")
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(copyText, forType: .string)
    }
}
