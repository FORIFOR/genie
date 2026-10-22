import SwiftUI
import GenieCore

/// Workspace の中身。**実際にあるデータから描く**（架空の行を並べない）。
///
/// 以前は Tasks / Meetings / Agents / Plugins が同じ 2 ペインの使い回しで、
/// ナビだけ 6 本ある状態だった。ここでそれぞれの出所を分ける
/// （2026-09-04 からは Work / Library / Apps の中の面。`MainSection` 参照）:
///   Tasks    → SQLite の tasks（§23/§24）
///   Meetings → ディスクの会議 journal
///   Plugins  → 同梱 manifest（§27）
struct WorkspaceHeader: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: TypeScale.pageTitleSize, weight: TypeScale.pageTitleWeight))
                .foregroundStyle(Palette.text(dark))
            Text(subtitle)
                .font(.system(size: TypeScale.secondarySize))
                .foregroundStyle(Palette.muted(dark))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 空のときに「壊れている」ではなく「まだ何もない」と読ませる。
///
/// **中央寄せの 2 行 + 巨大な空白はやめた**（盲検で「AI 生成感」の典型と指摘）。
/// 見出し → 説明 → 押せる主操作 → 「できること」の実機能 2〜3 行 を、上部に左寄せで置く。
/// **偽の skeleton は置かない**。見本を出すときは「例」と明示する（ここでは実機能名だけを出す）。
struct WorkspaceEmpty: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let title: String
    let hint: String
    var primaryLabel: String? = nil
    var primaryAction: (() -> Void)? = nil
    /// 「できること」= いま実際にある機能の名前だけ（偽データ・偽 skeleton は禁止）。
    var canDo: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: TypeScale.sectionTitleSize, weight: .semibold))
                    .foregroundStyle(Palette.text(dark))
                Text(hint)
                    .font(.system(size: TypeScale.secondarySize))
                    .foregroundStyle(Palette.muted(dark))
            }
            if let primaryLabel, let primaryAction {
                Button(primaryLabel, action: primaryAction)
                    .font(.system(size: TypeScale.bodySize, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(height: 36).padding(.horizontal, 18)
                    .background(Capsule().fill(Palette.accent(dark)))
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("emptyPrimary")
            }
            if !canDo.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("できること")
                        .font(.system(size: TypeScale.microSize, weight: .semibold))
                        .foregroundStyle(Palette.muted(dark))
                    ForEach(canDo, id: \.self) { row in
                        HStack(spacing: 8) {
                            Image(systemName: "arrow.turn.down.right")
                                .font(.system(size: 11)).foregroundStyle(Palette.muted(dark))
                            Text(row)
                                .font(.system(size: TypeScale.secondarySize))
                                .foregroundStyle(Palette.text(dark))
                        }
                    }
                }
            }
        }
        // 垂直中央にしない。上から 1/3 に左寄せで固定する。
        .frame(maxWidth: 460, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, 8)
    }
}

/// 一覧の 1 行。Linear のように、行そのものが情報になるようにする。
struct WorkspaceRow<Trailing: View>: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let icon: String
    let tint: Color
    let title: String
    let detail: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundStyle(tint)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: TypeScale.bodySize, weight: .medium))
                    .foregroundStyle(Palette.text(dark))
                    .lineLimit(1)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: TypeScale.secondarySize))
                        .foregroundStyle(Palette.muted(dark))
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 12)
            trailing()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.cardSurface(dark))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.hairline(dark)))
        )
    }
}

// MARK: - Tasks（§23/§24 SQLite の tasks から）

struct TasksPane: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @State private var tasks: [AgentTask] = []
    @State private var query = ""
    @State private var filter: TaskHistoryFilter = .all
    private var visible: [AgentTask] { tasks.filter { filter.includes($0, query: query) } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    WorkspaceHeader(title: Facts.workTasks, subtitle: "進めている仕事と、できあがった成果物。")
                    Button("新しく依頼する") { MainNav.shared.select(.home) }
                        .accessibilityIdentifier("tasksNewRequest")
                }
                ScheduleSection(board: ScheduleBoard.shared, dark: dark)
                if tasks.isEmpty {
                    WorkspaceEmpty(title: "まだ仕事はありません", hint: "最初の依頼をすると、ここから進み具合を確認できます。",
                                   primaryLabel: "依頼を書く", primaryAction: { MainNav.shared.select(.home) })
                } else {
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted(dark))
                        TextField("仕事を検索", text: $query).textFieldStyle(.plain)
                            .accessibilityIdentifier("taskSearch")
                        if !query.isEmpty {
                            Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).accessibilityLabel("検索をクリア")
                        }
                    }
                    .padding(12).background(Palette.surface(dark), in: RoundedRectangle(cornerRadius: Metrics.paletteRadius))
                    Picker("状態", selection: $filter) {
                        ForEach(TaskHistoryFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented).accessibilityIdentifier("taskFilter")
                    if visible.isEmpty {
                        Text("条件に合う仕事はありません").foregroundStyle(Palette.muted(dark)).padding(.vertical, 20)
                    }
                    LazyVStack(spacing: 12) {
                        ForEach(visible) { task in
                            TaskHistoryRow(task: task) { MainNav.shared.openTask = task }
                        }
                    }
                }
            }
            .padding(28).frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Palette.canvas(dark))
        .onAppear { tasks = LocalStore.shared.loadTasks() }
        .task { await ScheduleBoard.shared.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: LocalStore.tasksChanged).receive(on: RunLoop.main)) { _ in tasks = LocalStore.shared.loadTasks() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasksPane")
    }
}

// MARK: - Meetings（ディスクの journal から）

struct MeetingsPane: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var sessions = MeetingSessionStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WorkspaceHeader(title: Facts.libraryMeetings,
                                subtitle: "会議の文字起こしと記録を確認できます。")
                if sessions.recent.isEmpty {
                    WorkspaceEmpty(title: "まだ会議はありません",
                                   hint: "録音した会議と、その出所がここに残ります。",
                                   primaryLabel: "録音を始める",
                                   primaryAction: { NewRecordingSheetOpener.shared.open() },
                                   canDo: ["録音すると 要約・決まったこと・やること にまとまる",
                                           "どの一文も 発言と音声の位置まで戻れる",
                                           "予定の会議はワンクリックで録れる"])
                } else {
                    ForEach(sessions.recent) { s in
                        SessionCard(session: s) {
                            MainNav.shared.openSession = s.id
                        }
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Palette.canvas(dark))
        .accessibilityIdentifier("meetingsPane")
    }
}

// MARK: - Plugins（§27 同梱 manifest から）

struct PluginsPane: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var runtime = PluginRuntimeStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WorkspaceHeader(title: Facts.appsPlugins,
                                subtitle: "できる仕事を増やす。宣言しているだけでは動かず、許可した権限の中でだけ動きます。")
                if runtime.manifests.isEmpty {
                    WorkspaceEmpty(title: "プラグインが見つかりません。",
                                   hint: "plugins/builtin に manifest を置くとここに出ます。")
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 12)], spacing: 12) {
                        ForEach(runtime.manifests, id: \.id) { m in
                            pluginCard(m)
                        }
                    }
                }
            }
            .padding(28)
        }
        .background(Palette.canvas(dark))
        .onAppear { runtime.load() }
        .accessibilityIdentifier("pluginsPane")
    }

    private func pluginCard(_ m: PluginManifest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 9) {
                // 全カードが同じ青灰のタイルに見えないよう、名前から安定した色相を振る
                // （頭文字は同じでも、格子として区別が付く）。
                let hue = Double(abs(m.id.hashValue) % 360) / 360.0
                let avatar = Color(hue: hue, saturation: 0.5, brightness: dark ? 0.85 : 0.62)
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(avatar.opacity(0.18))
                    .frame(width: 28, height: 28)
                    .overlay(Text(String(m.name.prefix(1)))
                        .font(.system(size: TypeScale.secondarySize, weight: .semibold))
                        .foregroundStyle(avatar))
                VStack(alignment: .leading, spacing: 1) {
                    Text(m.name)
                        .font(.system(size: TypeScale.cardTitleSize, weight: TypeScale.cardTitleWeight))
                        .foregroundStyle(Palette.text(dark))
                    Text("\(m.publisher) · \(m.version)")
                        .font(.system(size: TypeScale.secondarySize))
                        .foregroundStyle(Palette.muted(dark))
                }
                Spacer(minLength: 0)
                if m.verified {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.success(dark))
                        .help("検証済み")
                }
            }
            if m.runsLocallyOnly {
                // 資格情報が端末にしか無いものは、そのことを見せる。
                Text("この Mac の中だけで動きます")
                    .font(.system(size: TypeScale.secondarySize))
                    .foregroundStyle(Palette.muted(dark))
            }
            if !m.permissions.isEmpty {
                // 行の高さまで伸ばしたぶんの余白は、札の途中ではなく上に置く。
                // 権限が下端で揃うので、余白が「空き」ではなく並びに見える。
                Spacer(minLength: 0)
                // 切れた文字を並べない。3 つまで出して、残りは数で言う。
                FlowChips(items: Array(m.permissions.prefix(3)),
                          overflow: max(0, m.permissions.count - 3))
            }
        }
        .padding(14)
        // 高さを揃える。行ごとに凸凹すると一覧が読みにくい。
        //
        // `minHeight` は最小値でしかないので、これだけでは揃わなかった。
        // 「この Mac の中だけで動きます」が付く札だけ背が高くなり、同じ行の
        // 2 枚が別の高さ・別の開始位置になって、左右の列がずれて見えていた。
        // 行の高さまで伸ばす（LazyVGrid の行の高さは、その行のいちばん高い札で決まる）。
        .frame(maxWidth: .infinity, minHeight: 104, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.cardSurface(dark))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.hairline(dark)))
        )
        .accessibilityIdentifier("plugin-\(m.id)")
    }
}

/// 権限などの小さな札。折り返す。
struct FlowChips: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let items: [String]
    var overflow: Int = 0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(items, id: \.self) { item in
                Text(item)
                    .font(.system(size: TypeScale.microSize))
                    .foregroundStyle(Palette.muted(dark))
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 8)
                    .frame(height: 21)
                    .background(Capsule().fill(Color.subtleFill(dark, 0.05)))
            }
            if overflow > 0 {
                Text("+\(overflow)")
                    .font(.system(size: TypeScale.microSize))
                    .foregroundStyle(Palette.muted(dark))
            }
            Spacer(minLength: 0)
        }
    }
}

/// Plugin manifest を View から使えるようにする薄い箱（`PluginRuntime` は非 ObservableObject）。
@MainActor
final class PluginRuntimeStore: ObservableObject {
    static let shared = PluginRuntimeStore()
    @Published private(set) var manifests: [PluginManifest] = []

    func load() {
        guard manifests.isEmpty else { return }
        // 開発時はリポジトリの plugins/、配布時はバンドル内を見る。
        //
        // 以前ここに開発機の絶対パスが 1 本入っていた。バンドルへ plugins を
        // 同梱していなかったので最初の候補は常に外れ、この絶対パスだけで拾えていた。
        // つまり**私の Mac でしか同梱プラグインが読めない**状態で、それに気づけなかった。
        // 個人のパスは置かない。無ければ「無い」と分かるようにする。
        // cwd には頼らない。ゲートは `apps/genie-macos` へ cd して動かすので、
        // cwd 相対では外れる（実際、絶対パスを消したら Plugins 面が空になり、
        // 密度の歯止めが 45.5% → 98.0% で捕まえた）。実行体から上へ辿って探す。
        var candidates: [String] = []
        if let res = Bundle.main.resourcePath { candidates.append(res + "/plugins/builtin") }
        if let env = ProcessInfo.processInfo.environment["ASTRA_PLUGINS_DIR"], !env.isEmpty {
            candidates.append(env)
        }
        candidates.append(FileManager.default.currentDirectoryPath + "/plugins/builtin")
        var dir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
            .deletingLastPathComponent()
        for _ in 0..<8 {
            candidates.append(dir.appendingPathComponent("plugins/builtin").path)
            dir = dir.deletingLastPathComponent()
        }
        for path in candidates where FileManager.default.fileExists(atPath: path) {
            let runtime = PluginRuntime.shared
            if runtime.load(from: path).loaded > 0 {
                manifests = runtime.installed
                return
            }
        }
    }
}
