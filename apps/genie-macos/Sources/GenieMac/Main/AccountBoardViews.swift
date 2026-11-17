import AppKit
import SwiftUI

/// 作業一覧の上の「予約」。予約があるときだけ出す（無ければ作業一覧はこれまでどおり）。
/// 作るのは会話（「毎朝 8 時に〜まとめて」）。ここでは止める・再開・取り消すだけ。
struct ScheduleSection: View {
    @ObservedObject var board: ScheduleBoard
    let dark: Bool

    var body: some View {
        if !board.items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("予約").font(.system(size: TypeScale.secondarySize, weight: .semibold))
                    .foregroundStyle(Palette.muted(dark))
                VStack(spacing: 0) {
                    ForEach(Array(board.items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { Divider() }
                        row(item)
                    }
                }
                .padding(.horizontal, Space.cardPadding)
                .background(Palette.surface(dark), in: RoundedRectangle(cornerRadius: Metrics.paletteRadius))
                .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius).stroke(Palette.border(dark)))
                if let problem = board.problem {
                    Text(problem).font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.danger(dark))
                }
            }
            .accessibilityElement(children: .contain).accessibilityIdentifier("scheduleSection")
        }
    }

    private func row(_ item: ScheduleBoard.Item) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: item.kind == "reminder" ? "bell" : "clock.arrow.circlepath")
                .foregroundStyle(Palette.muted(dark)).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.system(size: TypeScale.bodySize)).fixedSize(horizontal: false, vertical: true)
                Text(item.stateLine).font(.system(size: TypeScale.microSize))
                    .foregroundStyle(item.status == "disabled" ? Palette.danger(dark) : Palette.muted(dark))
            }
            Spacer(minLength: 12)
            Button(item.status == "active" ? "止める" : "再開") {
                Task { await board.set(item, status: item.status == "active" ? "paused" : "active") }
            }
            .accessibilityIdentifier("schedulePause-\(item.id)")
            Button("取り消す") {
                guard Confirm.ask(ActionConfirmation(title: "予約を取り消します", details: [item.name, "取り消した予約は戻せません。もう一度頼めば作り直せます。"], risk: .r1, confirmLabel: "取り消す")) else { return }
                Task { await board.set(item, status: "cancelled") }
            }
            .accessibilityIdentifier("scheduleCancel-\(item.id)")
        }
        .buttonStyle(.borderless).font(.system(size: TypeScale.secondarySize))
        .foregroundStyle(Palette.text(dark))
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }
}

/// 作業一覧の「ほかの AI に頼んだ仕事」。セッションがあるときだけ出す（無ければ作業一覧はこれまでどおり）。
/// 返事が要るものを上に。操作は見守りを止める・戻すだけ（Claude Code 自体は止めない）。
struct AgentSessionsSection: View {
    @ObservedObject var board: AgentSessionsBoard
    let dark: Bool

    var body: some View {
        if !board.items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("ほかの AI に頼んだ仕事").font(.system(size: TypeScale.secondarySize, weight: .semibold))
                    .foregroundStyle(Palette.muted(dark))
                VStack(spacing: 0) {
                    ForEach(Array(board.items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { Divider() }
                        row(item)
                    }
                }
                .padding(.horizontal, Space.cardPadding)
                .background(Palette.surface(dark), in: RoundedRectangle(cornerRadius: Metrics.paletteRadius))
                .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius).stroke(Palette.border(dark)))
                if let problem = board.problem {
                    Text(problem).font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.danger(dark))
                }
            }
            .accessibilityElement(children: .contain).accessibilityIdentifier("agentSessionsSection")
        }
    }

    private func row(_ item: AgentSessionsBoard.Item) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: item.needsUser ? "exclamationmark.circle" : item.attention == "held" ? "pause.circle" : "terminal")
                .foregroundStyle(item.needsUser ? Palette.warning(dark) : Palette.muted(dark)).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.system(size: TypeScale.bodySize)).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(item.origin) ・ \(item.stateLine)").font(.system(size: TypeScale.microSize))
                    .foregroundStyle(item.needsUser ? Palette.warning(dark) : Palette.muted(dark))
            }
            Spacer(minLength: 12)
            if item.attention != "ended" {
                // 保留中のものを戻すと、このセッションだけ保留から外れる（保留そのものは言葉で解除する）
                let paused = item.quiet
                Button(paused ? "見守りを戻す" : "見守りを止める") {
                    Task { await board.set(item, policy: paused ? "watch" : "paused_by_user") }
                }
                .accessibilityIdentifier("agentSessionPolicy-\(item.id)")
            }
        }
        .buttonStyle(.borderless).font(.system(size: TypeScale.secondarySize))
        .foregroundStyle(Palette.text(dark))
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }
}

/// 作業一覧の先頭の札。返事が要るものを 3 行まで（文は gateway。声の答えと同じ）。何も無ければ出さない。
struct WorkOverviewCard: View {
    @ObservedObject var board: WorkOverviewBoard
    let dark: Bool

    var body: some View {
        if let overview = board.overview, let summary = overview.summary {
            VStack(alignment: .leading, spacing: 8) {
                Text(summary).font(.system(size: TypeScale.secondarySize, weight: .semibold))
                    .foregroundStyle(Palette.muted(dark))
                    .accessibilityIdentifier("workOverviewSummary")
                ForEach(Array(overview.attention.prefix(3).enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(Palette.warning(dark)).frame(width: 18)
                        Text(line).font(.system(size: TypeScale.bodySize)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if overview.attention.count > 3 {
                    Text("ほか \(overview.attention.count - 3) 件").font(.system(size: TypeScale.microSize))
                        .foregroundStyle(Palette.muted(dark))
                }
            }
            .padding(Space.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface(dark), in: RoundedRectangle(cornerRadius: Metrics.paletteRadius))
            .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius).stroke(Palette.border(dark)))
            .accessibilityElement(children: .contain).accessibilityIdentifier("workOverviewCard")
        }
    }
}

/// アプリ連携の「Slack・LINE」。gateway が答えたときだけ出す（オフラインや検査では出さない）。
struct ChatChannelsCard: View {
    @ObservedObject var board: ChatChannelsBoard
    let dark: Bool

    var body: some View {
        if let status = board.status {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 20)).foregroundStyle(Palette.muted(dark)).frame(width: 32, height: 32)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Slack・LINE").font(.system(size: TypeScale.cardTitleSize, weight: .medium))
                        Text("チャットから Genie に頼み、結果を同じスレッドで受け取る。")
                            .font(.system(size: TypeScale.bodySize)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                providerRow("slack", configured: status.slack.configured,
                            detail: status.slack.transport == "socket" ? "公開 URL なしで受けています" : nil)
                providerRow("line", configured: status.line.configured, detail: nil)
                if !status.slack.configured && !status.line.configured {
                    Text("使うには、Slack アプリか LINE 公式アカウントの設定が要ります。")
                        .font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.muted(dark))
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let code = board.code, code.expires > Date() {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(ChatChannelsBoard.title(code.provider)) で Genie にこう送ってください（\(ScheduleBoard.format(code.expires)) まで・1 回）")
                            .font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.muted(dark))
                        HStack {
                            Text(code.message).font(.system(size: TypeScale.cardTitleSize, design: .monospaced))
                                .textSelection(.enabled).accessibilityIdentifier("chatLinkCode")
                            Button("コピー") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(code.message, forType: .string)
                            }
                        }
                    }
                }
                ForEach(board.links) { link in
                    HStack(spacing: 12) {
                        Image(systemName: "link").foregroundStyle(Palette.success(dark))
                        Text(ChatChannelsBoard.title(link.provider) + "（\(linkedLine(link))）")
                            .font(.system(size: TypeScale.secondarySize))
                        Spacer(minLength: 12)
                        Button("解除") {
                            guard Confirm.ask(ActionConfirmation(title: "\(ChatChannelsBoard.title(link.provider)) の連携を解除します", details: ["このチャットから Genie に頼めなくなります。", "もう一度つなぐには、連携コードを出し直します。"], risk: .r2, confirmLabel: "解除する")) else { return }
                            Task { await board.unlink(link) }
                        }
                        .accessibilityIdentifier("chatUnlink-\(link.id)")
                    }
                }
                if let problem = board.problem {
                    Text(problem).font(.system(size: TypeScale.secondarySize)).foregroundStyle(Palette.danger(dark))
                }
            }
            .buttonStyle(.bordered).controlSize(.regular)
            .foregroundStyle(Palette.text(dark))
            .padding(Space.cardPadding)
            .background(Palette.surface(dark), in: RoundedRectangle(cornerRadius: Metrics.paletteRadius))
            .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius).stroke(Palette.border(dark)))
            .accessibilityElement(children: .contain).accessibilityIdentifier("connectionGroup-chat")
        }
    }

    private func providerRow(_ provider: String, configured: Bool, detail: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: configured ? "checkmark.circle" : "circle")
                .foregroundStyle(configured ? Palette.success(dark) : Palette.muted(dark))
            Text(ChatChannelsBoard.title(provider)).font(.system(size: TypeScale.secondarySize))
            if let detail, configured {
                Text(detail).font(.system(size: TypeScale.microSize)).foregroundStyle(Palette.muted(dark))
            }
            Spacer(minLength: 12)
            if configured {
                Button("連携コードを出す") { Task { await board.issueCode(provider) } }
                    .font(.system(size: TypeScale.secondarySize))
                    .accessibilityIdentifier("chatLinkCode-\(provider)")
            } else {
                Text("未設定").font(.system(size: TypeScale.microSize)).foregroundStyle(Palette.muted(dark))
            }
        }
    }

    private func linkedLine(_ link: ChatChannelsBoard.Link) -> String {
        if let seen = link.last_seen_at.flatMap(ScheduleBoard.parse) { return "最後に受けたのは " + ScheduleBoard.format(seen) }
        if let made = ScheduleBoard.parse(link.created_at) { return ScheduleBoard.format(made) + " に連携" }
        return "連携済み"
    }
}

/// 設定の「音声入力」: 個人の辞書と、この Mac の履歴。
struct DictationSettingsSection: View {
    @State private var entries: [DictationVocabulary.Entry]
    @State private var spoken = ""
    @State private var written = ""
    @State private var message: String?
    @State private var busy = false
    @State private var historyOn = DictationHistory.shared.enabled
    @State private var history: [DictationHistory.Item]
    @State private var showHistory: Bool
    private let live: Bool
    var onResize: () -> Void = {}

    init(onResize: @escaping () -> Void = {}) {
        _entries = State(initialValue: DictationVocabularyStore.shared.vocabulary.entries)
        _history = State(initialValue: DictationHistory.shared.recent)
        _showHistory = State(initialValue: false)
        live = true
        self.onResize = onResize
    }

    /// 検査の撮影用（手元の辞書・履歴を読まない）。
    init(fixtureEntries: [DictationVocabulary.Entry], fixtureHistory: [DictationHistory.Item]) {
        _entries = State(initialValue: fixtureEntries)
        _history = State(initialValue: fixtureHistory)
        _showHistory = State(initialValue: !fixtureHistory.isEmpty)
        live = false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("辞書（こう聞こえたら、こう書く）").font(.system(size: TypeScale.captionSize)).foregroundStyle(.secondary)
            if entries.isEmpty {
                Text("まだありません。「辞書に登録: ジーニーは Genie」と話しても足せます。")
                    .font(.system(size: TypeScale.captionSize)).foregroundStyle(.primary).opacity(0.78)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(entries, id: \.spoken) { entry in
                            HStack {
                                Text(entry.spoken == entry.written ? "\(entry.spoken)（聞き取りの手がかり）" : "\(entry.spoken) → \(entry.written)")
                                    .font(.system(size: TypeScale.microSize)).lineLimit(1).truncationMode(.tail)
                                Spacer(minLength: 8)
                                Button {
                                    Task { await run { await DictationVocabularyStore.shared.remove(entry) } }
                                } label: { Image(systemName: "minus.circle") }
                                    .buttonStyle(.borderless).disabled(busy || entry.id == nil)
                                    .accessibilityLabel("\(entry.spoken) を辞書から消す")
                            }
                        }
                    }
                }
                .frame(maxHeight: min(CGFloat(entries.count) * 22, 132))
                .accessibilityIdentifier("dictationVocabularyList")
            }
            HStack {
                TextField("聞こえ方", text: $spoken).textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("dictationVocabularySpoken")
                Image(systemName: "arrow.right").foregroundStyle(.secondary)
                TextField("書き方（空なら手がかりだけ）", text: $written).textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("dictationVocabularyWritten")
                Button("追加") {
                    Task {
                        await run { await DictationVocabularyStore.shared.add(spoken: spoken, written: written) }
                        if message == nil { spoken = ""; written = "" }
                    }
                }
                .controlSize(.small).disabled(busy || spoken.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("dictationVocabularyAdd")
            }
            if let message { Text(message).font(.system(size: TypeScale.captionSize)).foregroundStyle(.secondary) }

            Toggle("入れた文をこの Mac に残す（7 日・100 件まで）", isOn: Binding(
                get: { historyOn },
                set: { on in DictationHistory.shared.setEnabled(on); historyOn = on; history = DictationHistory.shared.recent }))
                .toggleStyle(.switch).font(.system(size: TypeScale.microSize))
                .accessibilityIdentifier("dictationHistoryToggle")
            Text("音声とパスワード欄の文は残しません。止めると履歴も消えます。")
                .font(.system(size: TypeScale.captionSize)).foregroundStyle(.primary).opacity(0.78)
                .fixedSize(horizontal: false, vertical: true)
            if historyOn {
                DisclosureGroup("最近の音声入力（\(history.count) 件）", isExpanded: $showHistory) {
                    VStack(alignment: .leading, spacing: 6) {
                        if history.isEmpty {
                            Text("まだありません。").font(.system(size: TypeScale.captionSize)).foregroundStyle(.secondary)
                        }
                        ScrollView {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(history.prefix(30)) { item in historyRow(item) }
                            }
                        }
                        .frame(maxHeight: history.isEmpty ? 0 : 180)
                        if !history.isEmpty {
                            Button("履歴を消す") { DictationHistory.shared.clear(); history = [] }
                                .controlSize(.small).accessibilityIdentifier("dictationHistoryClear")
                        }
                    }.padding(.top, 4)
                }
                .font(.system(size: TypeScale.microSize))
                .accessibilityIdentifier("dictationHistory")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: DictationVocabularyStore.changed)) { _ in
            guard live else { return }
            entries = DictationVocabularyStore.shared.vocabulary.entries; onResize()
        }
        .onReceive(NotificationCenter.default.publisher(for: DictationHistory.changed)) { _ in
            guard live else { return }
            history = DictationHistory.shared.recent; onResize()
        }
        .onChange(of: showHistory) { _, _ in onResize() }
        .onChange(of: historyOn) { _, _ in onResize() }
        .onChange(of: message) { _, _ in onResize() }
        .task { if live { await DictationVocabularyStore.shared.refresh() } }
    }

    private func historyRow(_ item: DictationHistory.Item) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(ScheduleBoard.format(item.at)) ・ \(item.app)")
                    .font(.system(size: TypeScale.captionSize)).foregroundStyle(.secondary)
                Text(item.text).font(.system(size: TypeScale.microSize)).lineLimit(3)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(item.text, forType: .string)
            } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.borderless).accessibilityLabel("この文をコピー")
        }
    }

    private func run(_ action: () async -> String?) async {
        busy = true
        message = await action()
        entries = DictationVocabularyStore.shared.vocabulary.entries
        busy = false
        onResize()
    }
}
