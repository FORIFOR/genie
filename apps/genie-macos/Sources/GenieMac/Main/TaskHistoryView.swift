import SwiftUI

extension AgentRunState {
    var displayTitle: String {
        switch self {
        case .pending: return "待機中"
        case .running: return "進行中"
        case .success: return "完了"
        case .failed: return "要確認"
        }
    }
    var displayIcon: String {
        switch self {
        case .pending: return "clock"
        case .running: return "circle.dotted"
        case .success: return "checkmark.circle"
        case .failed: return "exclamationmark.triangle"
        }
    }
    func displayColor(_ dark: Bool) -> Color {
        switch self {
        case .pending: return Palette.muted(dark)
        case .running: return Palette.accent(dark)
        case .success: return Palette.success(dark)
        case .failed: return Palette.warning(dark)
        }
    }
}

enum TaskHistoryFilter: String, CaseIterable {
    case all = "すべて", active = "進行中", finished = "完了", failed = "要確認"
    func includes(_ task: AgentTask, query: String) -> Bool {
        let stateMatches: Bool
        switch self {
        case .all: stateMatches = true
        case .active: stateMatches = task.status == .pending || task.status == .running
        case .finished: stateMatches = task.status == .success
        case .failed: stateMatches = task.status == .failed
        }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return stateMatches && (query.isEmpty || task.title.localizedStandardContains(query)
            || (task.requestRecord?.request.localizedStandardContains(query) ?? false)
            || (task.requestRecord?.documentText.localizedStandardContains(query) ?? false)
            || task.steps.contains { $0.title.localizedStandardContains(query) || $0.detail.localizedStandardContains(query) })
    }
}

/// One explicit, keyboard-operable action per row; inspecting a task never reruns it.
struct TaskHistoryRow: View {
    let task: AgentTask
    var open: () -> Void
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }

    var body: some View {
        Button(action: open) {
            WorkspaceRow(icon: task.status.displayIcon, tint: task.status.displayColor(dark), title: task.title,
                         detail: task.summary) {
                Text(task.stateTitle)
                    .font(.system(size: TypeScale.secondarySize))
                    .foregroundStyle(task.status.displayColor(dark))
                Image(systemName: "chevron.right").font(.system(size: 11))
                    .foregroundStyle(Palette.muted(dark))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(task.title)、\(task.stateTitle)、詳細を開く")
        .accessibilityIdentifier("task-\(task.id)")
    }
}

struct TaskDetailView: View {
    let task: AgentTask
    @State private var current: AgentTask?
    @State private var copied = false
    @State private var exportMessage = ""
    @State private var showRequest = false
    @State private var editingDraft: TaskDocumentDraft?
    @ObservedObject private var voice = VoiceHUDState.shared
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    private var shown: AgentTask { voice.unsavedRequests[task.id] ?? current ?? task }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.largePadding) {
                HStack {
                    Button { MainNav.shared.select(.work); MainNav.shared.workTab = .tasks } label: {
                        Label("仕事に戻る", systemImage: "chevron.left")
                    }
                    .buttonStyle(.plain).foregroundStyle(Palette.muted(dark))
                    .accessibilityIdentifier("taskDetailBack")
                    Spacer()
                    Text(shown.startedAt.formatted(date: .abbreviated, time: .shortened))
                        .foregroundStyle(Palette.muted(dark))
                }
                VStack(alignment: .leading, spacing: 12) {
                    Label(shown.stateTitle, systemImage: shown.status.displayIcon)
                        .foregroundStyle(shown.status.displayColor(dark))
                    Text(shown.title)
                        .font(.system(size: TypeScale.pageTitleSize, weight: TypeScale.pageTitleWeight))
                        .fixedSize(horizontal: false, vertical: true)
                }
                if voice.unsavedRequests[task.id] != nil {
                    Text("未保存です。終了前にコピー・書き出すか、空き容量を確認して再試行してください。")
                        .foregroundStyle(Palette.warning(dark))
                    Button("保存を再試行") { voice.savePendingRequest(task.id); reload() }
                        .accessibilityIdentifier("taskRetryLocalSave")
                }
                if let record = shown.requestRecord {
                    if record.hasResult { resultDocument(record) }
                    else {
                        VStack(alignment: .leading, spacing: 16) {
                            if record.phase == .submitting || record.phase == .working {
                                HStack(spacing: 12) {
                                    GenieOrb(mode: record.phase == .working ? .thinking : .preparing)
                                    Text(record.phase == .submitting ? "依頼を保存しました。実行先に届けています。" : "結果を待っています。別の画面で作業を続けられます。")
                                }
                            }
                            if !record.message.isEmpty { Text(record.message).textSelection(.enabled) }
                            if record.canRefresh {
                                // 押したときだけ、承認待ちの確認カードを出せる（答えるのはカードだけ）。
                                Button { voice.refreshRequest(shown.id, interactive: true) } label: {
                                    Label(voice.refreshingRequests.contains(shown.id) ? "確認中…" : "状況を確認", systemImage: "arrow.clockwise")
                                }
                                .disabled(voice.refreshingRequests.contains(shown.id) || (voice.requestInFlight && voice.latestRequestID == shown.id))
                                .accessibilityIdentifier("taskRefresh")
                            }
                        }
                        .padding(Space.largePadding).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Palette.surface(dark), in: RoundedRectangle(cornerRadius: Metrics.paletteRadius))
                    }
                    DisclosureGroup("依頼の内容", isExpanded: $showRequest) {
                        Text(record.request).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 12)
                    }
                    Button("この依頼を使う") {
                        MainNav.shared.intentDraft = record.request
                        MainNav.shared.select(.home)
                    }.accessibilityIdentifier("taskReuseRequest")
                } else { legacyRecord }
            }
            .font(.system(size: TypeScale.secondarySize))
            .foregroundStyle(Palette.text(dark))
            .padding(Space.largePadding).frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(Palette.canvas(dark))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("taskDetail")
        .onChange(of: shown.requestRecord?.hasResult) { _, ready in if ready == true { showRequest = false } }
        // 開いただけでは読むだけ。承認待ちでもカードは出さない（出すのは「状況を確認」を押したときだけ）。
        .onAppear { reload(); showRequest = shown.requestRecord?.hasResult != true; voice.refreshRequest(task.id, interactive: false) }
        .onReceive(NotificationCenter.default.publisher(for: LocalStore.tasksChanged).receive(on: RunLoop.main)) { _ in reload() }
    }

    private func reload() { current = LocalStore.shared.loadTasks().first { $0.id == task.id } }

    private func resultDocument(_ record: TaskRequestRecord) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Label("作成した文章", systemImage: "doc.text")
                    .font(.system(size: TypeScale.secondarySize, weight: .medium))
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(record.documentText, forType: .string)
                    copied = true
                } label: { Label(copied ? "コピー済み" : "コピー", systemImage: copied ? "checkmark" : "doc.on.doc") }
                .accessibilityIdentifier("taskResultCopy")
                GenieReadAloudButton(text: record.documentText, owner: shown.id)
                Button("編集") { editingDraft = TaskDocumentDraft(text: record.documentText) }
                    .disabled(voice.unsavedRequests[task.id] != nil)
                    .accessibilityIdentifier("taskResultEdit")
                Button { exportDocument() } label: { Label("保存…", systemImage: "square.and.arrow.down") }
                    .accessibilityIdentifier("taskResultSave")
            }.padding(Space.cardPadding)
            Divider()
            TaskDocumentView(text: record.documentText).padding(Space.largePadding)
            Text("保存するMarkdownには、文章・題名・元の依頼を含みます。")
                .font(.system(size: TypeScale.microSize)).foregroundStyle(Palette.muted(dark))
                .padding(Space.cardPadding)
            if !exportMessage.isEmpty { Text(exportMessage).foregroundStyle(Palette.muted(dark)).padding(Space.cardPadding) }
        }
        .background(Palette.surface(dark), in: RoundedRectangle(cornerRadius: Metrics.paletteRadius))
        .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius).stroke(Palette.border(dark)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("taskResultDocument")
        .sheet(item: $editingDraft) { draft in
            TaskDocumentEditor(draft: draft, dark: dark) { text in
                guard let edited = shown.editingDocument(text) else {
                    return "空の文章は保存できません。内容を入力してください。"
                }
                guard LocalStore.shared.save(edited) else {
                    return "保存できませんでした。入力は残しています。空き容量を確認してください。"
                }
                current = edited; copied = false; exportMessage = "編集をこのMacに保存しました。"
                return nil
            }
        }
    }

    private func exportDocument() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Genie-\(shown.id.uuidString.prefix(8)).md"
        panel.title = "作成した文章を保存"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try shown.document.write(to: url, atomically: true, encoding: .utf8)
            exportMessage = "保存しました: " + url.lastPathComponent
        } catch { exportMessage = "保存できませんでした。保存先と空き容量を確認してください。" }
    }

    private var legacyRecord: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let reason = shown.failureReason {
                Label(reason, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(Palette.warning(dark)).textSelection(.enabled)
            }
            HStack {
                Text("実行の記録").font(.system(size: TypeScale.cardTitleSize, weight: .medium))
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(([shown.title, shown.stateTitle] + shown.steps.map {
                        "\($0.state.displayTitle) · \($0.title)\($0.detail.isEmpty ? "" : "\n" + $0.detail)"
                    }).joined(separator: "\n\n"), forType: .string)
                    copied = true
                } label: { Label(copied ? "コピーしました" : "記録をコピー", systemImage: copied ? "checkmark" : "doc.on.doc") }
                .accessibilityIdentifier("taskDetailCopy")
            }
            if shown.steps.isEmpty { Text("保存された実行の記録はありません。").foregroundStyle(Palette.muted(dark)) }
            ForEach(shown.steps) { step in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: step.state.displayIcon).frame(width: 20).foregroundStyle(step.state.displayColor(dark))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(step.title).font(.system(size: TypeScale.bodySize, weight: .medium))
                        Text(step.state.displayTitle).foregroundStyle(Palette.muted(dark))
                        if !step.detail.isEmpty { Text(step.detail).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                    }
                    Spacer(minLength: 0)
                }.padding(Space.cardPadding)
                Divider()
            }
        }
    }
}

/// Local rendering only: no remote images, web views, model requests, or executable HTML.
struct TaskDocumentView: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                if line.hasPrefix("# ") || line.hasPrefix("## ") || line.hasPrefix("### ") {
                    Text(line.drop(while: { $0 == "#" || $0 == " " }))
                        .font(.system(size: TypeScale.cardTitleSize, weight: .medium)).padding(.top, 8)
                } else if !line.isEmpty {
                    Text((try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(line))
                        .font(.system(size: TypeScale.bodySize)).lineSpacing(5)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}


/// The sheet's identity carries its initial content, including its first presentation.
private struct TaskDocumentDraft: Identifiable {
    let id = UUID()
    let text: String
}

private struct TaskDocumentEditor: View {
    @State private var text: String
    @State private var issue = ""
    @Environment(\.dismiss) private var dismiss
    let dark: Bool
    let save: (String) -> String?

    init(draft: TaskDocumentDraft, dark: Bool, save: @escaping (String) -> String?) {
        _text = State(initialValue: draft.text)
        self.dark = dark
        self.save = save
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.cardPadding) {
            Text("文章を編集").font(.system(size: TypeScale.sectionTitleSize))
            Text("このMacに保存します。モデルへの再送はありません。元の生成文は保持されます。")
            TextEditor(text: $text).accessibilityLabel("成果物の文章")
                .accessibilityIdentifier("taskResultEditor")
            if !issue.isEmpty { Text(issue).foregroundStyle(Palette.warning(dark)) }
            HStack {
                Button("やめる") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("編集を保存") {
                    if let error = save(text) { issue = error }
                    else { dismiss() }
                }.accessibilityIdentifier("taskResultEditSave")
            }
        }.padding(Space.largePadding)
            .frame(minWidth: Metrics.homeContentWidth, minHeight: Metrics.workspaceHeight)
    }
}
