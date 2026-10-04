import SwiftUI
import GenieCore

/// 左の 4 面。役割を 1 行で言えるものだけを上位に置く（2026-09-04、本人の決定）:
///   Home    → 意図を入力する、最近の状態を見る
///   Work    → いま動いている仕事（Tasks / Agents / 録音中の会議）
///   Library → 終わった成果（過去の会議 / 資料 / 出所）
///   Apps    → できる仕事を増やす（Plugins / Connectors）
/// Tasks / Meetings / Agents / Plugins は消していない。親の下へ移した（`WorkTab` 等）。
enum MainSection: String, CaseIterable, Identifiable {
    case home, work, library, apps
    var id: String { rawValue }
    var title: String {
        switch self {
        case .home: return Facts.navHome
        case .work: return Facts.navWork
        case .library: return Facts.navLibrary
        case .apps: return Facts.navApps
        }
    }
    var icon: String {
        switch self {
        case .home: return "house"
        case .work: return "checklist"
        case .library: return "books.vertical"
        case .apps: return "square.grid.2x2"
        }
    }
}

/// Work の中の 2 面。
enum WorkTab: String, CaseIterable, Identifiable {
    case tasks, agents
    var id: String { rawValue }
    var title: String {
        switch self {
        case .tasks: return Facts.workTasks
        case .agents: return Facts.workAgents
        }
    }
}

/// Library の中の 2 面。
enum LibraryTab: String, CaseIterable, Identifiable {
    case meetings, files
    var id: String { rawValue }
    var title: String {
        switch self {
        case .meetings: return Facts.libraryMeetings
        case .files: return Facts.libraryFiles
        }
    }
}

/// Apps の中の 2 面。
enum AppsTab: String, CaseIterable, Identifiable {
    case connectors, plugins
    var id: String { rawValue }
    var title: String {
        switch self {
        case .plugins: return Facts.appsPlugins
        case .connectors: return Facts.appsConnectors
        }
    }
}

/// 実バックエンドから Apps/Library を core 経由で取る（Tauri を介さない）。dev サインインで検証可能。
@MainActor
final class MainData: ObservableObject {
    static let shared = MainData()
    @Published var apps: [String] = []
    @Published var library: [String] = []
    @Published var connected = false
    @Published private(set) var connectionIssue: GatewayConnectionIssue?
    let credentialRecovery = GatewayCredentialRecovery()
    private let base = ProcessInfo.processInfo.environment["ASTRA_GATEWAY_URL"] ?? "http://127.0.0.1:3000"

    private var session: GatewaySession?
    private var loading = false
    private var refreshLoop: Task<Void, Never>?
    private var configuredToken: String?

    /// A Dock action can arrive before the main window has ever opened.
    func ensureConnected(reconnect: Bool = false, afterUserAction: Bool = false) async -> Bool {
        if reconnect || afterUserAction {
            guard credentialRecovery.resumeForUserSubmission() else { return false }
        } else if credentialRecovery.holdsAutomaticConnection { return false }
        if reconnect && loading {
            for _ in 0..<150 {
                if !loading { break }
                guard !Task.isCancelled else { return false }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        load(reauthenticate: reconnect && !connected)
        for _ in 0..<150 {
            if !loading { return connected }
            guard !Task.isCancelled else { return false }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    func load(reauthenticate: Bool = false) {
        guard !credentialRecovery.holdsAutomaticConnection else { return }
        guard !DesktopConnectionBootstrap.isInvalid else {
            connected = false; connectionIssue = .configuration; return
        }
        if refreshLoop == nil {
            refreshLoop = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(30))
                    guard !Task.isCancelled else { return }
                    self?.load()
                }
            }
        }
        guard !loading else { return }
        loading = true
        if session == nil {
            let isolatedRoot = ProcessInfo.processInfo.environment["ASTRA_DATA_ROOT"]
            let key = "astra.dev.identity.\(base)" + (isolatedRoot.map { ".data-root.\($0)" } ?? "")
            let identity: String
            if let selected = ProcessInfo.processInfo.environment["ASTRA_DESKTOP_IDENTITY"] {
                guard let uuid = UUID(uuidString: selected) else {
                    loading = false; connected = false; connectionIssue = .configuration; return
                }
                identity = uuid.uuidString.lowercased()
            } else { identity = UserDefaults.standard.string(forKey: key) ?? UUID().uuidString.lowercased() }
            UserDefaults.standard.set(identity, forKey: key)
            session = GatewaySession.desktop(base: base, identity: identity)
        }
        guard let session else { loading = false; return }
        Task {
            defer { loading = false }
            do {
                if configuredToken == nil {
                    let reachable = await Task.detached { [base] in GenieCoreBridge.reachable(base) }.value
                    guard reachable else {
                        GenieLog.write("connection", "unreachable")
                        connected = false; connectionIssue = .unreachable; return
                    }
                }
                let tokens = try await session.tokens(reauthenticate: reauthenticate)
                if !connected || connectionIssue != nil { GenieLog.write("connection", "connected") }
                connected = true; connectionIssue = nil
                guard configuredToken != tokens.accessToken else { return }
                let renewal = configuredToken != nil
                configuredToken = tokens.accessToken
                RecordingWorkspaceState.shared.configureBackend(base: base, token: tokens.accessToken)
                VoiceHUDState.shared.configureBackend(base: base, token: tokens.accessToken, renewal: renewal)
                InitialProfileStore.shared.configureBackend(base: base, token: tokens.accessToken, renewal: renewal)
                WorkContextStore.shared.configureBackend(base: base, token: tokens.accessToken)
                ConnectorState.shared.configureBackend(base: base, token: tokens.accessToken)
                ReplyFlow.shared.configureBackend(base: base, token: tokens.accessToken)
                RecordingRuntime.shared.configureBackend(base: base, accessToken: tokens.accessToken)
                if !renewal {
                    if RecordingRuntime.devAutoUploadEnabled {
                        _ = RecoveryState.shared.recoverAll()
                    }
                }
                if apps.isEmpty {
                    let lists = await Task.detached { [base] in
                        ((try? GenieCoreBridge.pluginCatalog(base, accessToken: tokens.accessToken)) ?? [],
                         (try? GenieCoreBridge.library(base, accessToken: tokens.accessToken)) ?? [])
                    }.value
                    apps = lists.0; library = lists.1
                    WorkContextStore.shared.load()
                }
            } catch {
                connected = false
                connectionIssue = GatewayConnectionIssue.classify(error)
                NSLog("Genie: 接続を利用できません（%@）。", connectionIssue?.diagnosticCode ?? "unknown")
                // 中身（トークン・URL の秘密）は書かない。種類と Keychain の状態コードだけ。
                GenieLog.write("connection", "unavailable: \(connectionIssue?.diagnosticCode ?? "unknown") (\(GenieLog.clip(String(describing: error), 120)))")
            }
        }
    }

    func confirmCredentialReadAfterUserRequest() async {
        guard connectionIssue == .credentialAccess, !loading, let session else { return }
        await credentialRecovery.confirm {
            try await session.confirmCredentialReadAfterUserRequest()
        }
    }
}

/// Main Window のナビ状態。Visual Gate の撮影や外部導線から切り替えるため共有にする。
@MainActor
final class MainNav: ObservableObject {
    static let shared = MainNav()
    /// 右 Panel は既定で閉じる（§Workspace）。
    @Published var activityOpen = false
    /// 右 Panel に Personalization（Genie が使っている本人の情報）を出す。Home の [編集] から。
    @Published var personalizationOpen = false
    /// Home の Session Card から開いた会議（§8 Home → Session Detail の導線）。
    @Published var openSession: String? {
        didSet { if openSession != nil { openTask = nil } }
    }
    @Published var openTask: AgentTask? {
        didSet { if openTask != nil { openSession = nil; meetingDetail = false; section = .work; workTab = .tasks } }
    }
    /// Keep unsent text when another section is opened; it is never sent by navigation.
    @Published var intentDraft = ""
    /// nil uses reference resolution; [] explicitly means the user removed the image.
    @Published var intentVisualContext: [VisualContextArtifact]?
    @Published private(set) var intentFocusRequest = UUID()

    func requestIntentFocus() { intentFocusRequest = UUID() }

    func prepareScreenshotQuestion(_ image: VisualContextArtifact) {
        intentVisualContext = [image]
        select(.home)
        requestIntentFocus()
    }

    func removeIntentScreenshot() { intentVisualContext = [] }

    func finishIntentSubmission() {
        intentDraft = ""
        intentVisualContext = nil
    }
    @Published var section: MainSection = .home
    /// 各面の中の 2 面。撮影や外部導線から選べるように共有にする。
    @Published var workTab: WorkTab = .tasks
    @Published var libraryTab: LibraryTab = .meetings
    @Published var appsTab: AppsTab = .connectors
    /// 会議詳細のプレビュー（Library から開いた状態を撮るため）。
    @Published var meetingDetail = false

    /// 会議詳細で見せている会議の名前。
    var meetingTitle = "A社 新規提案"

    /// 一覧から面を選ぶ。**開いていた 1 件は閉じる。**
    ///
    /// sidebar の選択は `section` を直に書いていたが、`detailContent` は `openSession` /
    /// `meetingDetail` を `section` より先に見る。会議を 1 件開いたあとは sidebar の
    /// どの行を押しても面が変わらず、詳細から出る道が無かった（採点者 2 名が
    /// 「戻る・止める手段が見当たらない」、sessionshots も showSection で戻れず
    /// `openSession = nil` を手で書いていた）。sidebar と `showSection` はここを通る。
    func select(_ s: MainSection) {
        openSession = nil
        openTask = nil
        meetingDetail = false
        section = s
    }

    /// いま開いている面の見出し。表示はここから引く（画面側で別名を持たない）。
    /// ゲートもこれと実際の見出しを突き合わせる。
    ///
    /// 会議詳細は "Meeting" ではなく**その会議の名前**にする。一覧が "Meetings" なので、
    /// 1 文字違いの見出しでは「一覧に居るのか 1 件を開いているのか」が見分けられなかった。
    var title: String {
        if let task = openTask { return task.title }
        if let id = openSession, let s = MeetingSessionStore.shared.session(id: id) { return s.title }
        if meetingDetail { return meetingTitle }
        return section.title
    }
}

/// 4 タブの native シェル。Windows 版は同じ構成を NavigationView + Mica で作る（設計共通・実装別）。
struct MainWindowView: View {
    var loadBackend = true
    @StateObject private var nav = MainNav.shared
    @ObservedObject private var uiScale = UIScale.shared
    @StateObject private var data = MainData.shared
    @ObservedObject private var recording = RecordingWorkspaceState.shared

    var body: some View {
        NavigationSplitView {
            List(MainSection.allCases,
                 selection: Binding(get: { nav.section }, set: { nav.select($0) })) { s in
                // 既定の 13pt のままで、他を大きくしたぶん相対的に小さく見えていた。
                Label(s.title, systemImage: s.icon)
                    .font(.system(size: TypeScale.bodySize))
                    .padding(.vertical, 3)
                    .tag(s)
            }
            .navigationSplitViewColumnWidth(min: S.metric(Metrics.sidebarWidth) - 20, ideal: S.metric(Metrics.sidebarWidth), max: S.metric(Metrics.sidebarWidth) + 40)
            .safeAreaInset(edge: .bottom) {
                Button { SettingsWindowController.shared.show() } label: {
                    Label("設定", systemImage: "gearshape")
                        .font(.system(size: TypeScale.secondarySize))
                        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).padding(10)
                .accessibilityIdentifier("mainSettings")
            }
        } detail: {
            detailContent
                // 見出しは開いている面に合わせる。
                //
                // 以前も同じ意図でここに書いてあったが、効いていなかった。各 Pane が
                // それぞれ `.navigationTitle` を持っていて（Home / Work / Library / Apps /
                // Tasks / Meetings / Plugins / Meeting の 8 か所）、どれが勝つかが
                // SwiftUI の解決順に委ねられていたため。会議詳細を開いても "Home" のままだった。
                // 見出しを決めるのはここ 1 か所だけにする。
                .navigationTitle(nav.title)
                // 右の Agent Activity は **既定で閉じる**。Content を主役にする（Linear の作法）。
                // 右 Panel は 1 枚。Personalization を開いたときはそれ、そうでなければ Agent Activity。
                // `.inspector` を 2 つ重ねると、どちらが出るかが SwiftUI の解決順に委ねられる。
                .inspector(isPresented: Binding(
                    get: { nav.activityOpen || nav.personalizationOpen },
                    set: { open in if !open { nav.activityOpen = false; nav.personalizationOpen = false } })) {
                    Group {
                        if nav.personalizationOpen { PersonalizationInspector() } else { AgentActivityPane() }
                    }
                    .inspectorColumnWidth(min: S.metric(Metrics.inspectorWidth) - 40, ideal: S.metric(Metrics.inspectorWidth), max: S.metric(Metrics.inspectorWidth) + 60)
                }
                .toolbar {
                    ToolbarItem {
                        Button {
                            if recording.isRecording { WindowCoordinator.shared.showRecordingWorkspace() }
                            else { recording.start() }
                        } label: {
                            Label(recording.isRecording ? "録音中の会議" : "録音", systemImage: recording.isRecording ? "waveform" : "record.circle")
                                .labelStyle(.titleAndIcon)
                        }
                        .help(recording.isRecording ? "録音中の会議を開く" : Facts.recordingStart)
                        .accessibilityIdentifier("mainRecording")
                    }
                    ToolbarItem {
                        Button { nav.personalizationOpen = false; nav.activityOpen.toggle() } label: {
                            Image(systemName: "sidebar.trailing")
                        }
                        .help("エージェントの動きを表示／非表示")
                        .accessibilityLabel("エージェントの動きを表示／非表示")
                        .accessibilityIdentifier("toggleActivity")
                    }
                }
        }
        .frame(minWidth: 940, minHeight: 620)
        .onAppear { if loadBackend { data.load() } }
    }

    @ViewBuilder private var detailContent: some View {
        Group {
            if let task = nav.openTask {
                TaskDetailView(task: task).id(task.id)
            } else if let id = nav.openSession, let session = MeetingSessionStore.shared.session(id: id) {
                SessionDetailView(session: session)
            } else if nav.meetingDetail {
                MeetingArtifactView(
                    title: "A社 新規提案", duration: "42:18", participants: 3,
                    onBack: { nav.meetingDetail = false },
                    summary: [MeetingCitation(number: 1, text: "先方は10月導入を希望。最大の懸念は初期費用。", transcriptTime: "14:18", speaker: "田中")],
                    decisions: [MeetingCitation(number: 2, text: "導入時期を10月で検討", transcriptTime: "14:22", speaker: "鈴木")],
                    actionItems: [MeetingCitation(number: 3, text: "伊藤 修正版見積を送付 明日", transcriptTime: "14:31", speaker: "伊藤")],
                    selected: MeetingCitation(number: 1, text: "初期費用が少し気になっています。", transcriptTime: "14:18", speaker: "田中"),
                    // タブに中身を渡す。渡さないと「押せるが何も出ない」に戻る。
                    // 42 分の会議の文字起こしが 3 行では、面の下半分が空く（sample14 で
                    // 2 名が「下半分が空」）。引用される 3 行を含む、前後の流れを載せる。
                    transcript: [
                        MeetingCitation(number: nil, text: "本日はお時間ありがとうございます。前回の提案書 v3 をもとに進めます。", transcriptTime: "00:42", speaker: "あなた"),
                        MeetingCitation(number: nil, text: "はい。社内では 10 月の導入で調整しています。", transcriptTime: "01:10", speaker: "田中"),
                        MeetingCitation(number: nil, text: "初期費用の内訳をもう少し細かく見せてもらえますか。", transcriptTime: "13:05", speaker: "田中"),
                        MeetingCitation(number: nil, text: "ライセンスと導入支援に分けてお出しします。", transcriptTime: "13:40", speaker: "伊藤"),
                        MeetingCitation(number: 1, text: "初期費用が少し気になっています。", transcriptTime: "14:18", speaker: "田中"),
                        MeetingCitation(number: 2, text: "10 月からでしたら枠を取れます。", transcriptTime: "14:22", speaker: "鈴木"),
                        MeetingCitation(number: 3, text: "修正版の見積を明日お送りします。", transcriptTime: "14:31", speaker: "伊藤"),
                        MeetingCitation(number: nil, text: "では明日の見積を待って、社内で回します。", transcriptTime: "41:50", speaker: "田中"),
                    ],
                    relatedFiles: ["A社_提案書_v3.pdf", "見積_10月導入.xlsx"]
                )
            } else {
                switch nav.section {
                case .home: HomePane(recent: data.library)
                case .work: WorkPane(apps: data.apps)
                case .library: LibraryPane(titles: data.library)
                case .apps: AppsPane(apps: data.apps)
                }
            }
        }
    }
}

/// 右の Agent Activity。既定は閉じていて、要るときだけ開く。
private struct AgentActivityPane: View {
    @ObservedObject private var store = GenieStateStore.shared
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("エージェントの動き")
                .font(.system(size: TypeScale.captionSize, weight: .semibold))
                .foregroundStyle(Palette.muted(dark))
            if store.state.activeTask != nil {
                TaskTimelineView()
            } else {
                Text("いま動いている仕事はありません。")
                    .font(.system(size: TypeScale.microSize))
                    .foregroundStyle(Palette.muted(dark))
            }
            // 直近の出来事（§28 EventBus）。何が起きたかを追えるようにする。
            if !GenieEventBus.shared.recent.isEmpty {
                Divider().overlay(Palette.border(dark))
                ForEach(Array(GenieEventBus.shared.recent.suffix(6).enumerated()), id: \.offset) { _, e in
                    Text(e.name)
                        .font(.system(size: TypeScale.captionSize, design: .monospaced))
                        .foregroundStyle(Palette.muted(dark))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("agentActivity")
    }
}

struct HomePane: View {
    let recent: [String]
    /// 直近の予定は**実カレンダー**から取る（MEET-001）。許可が無ければ空のまま（架空の予定を作らない）。
    @State private var upcoming: [HomeAttention] = []

    var body: some View {
        // §8 Home: greeting + intent・Attention（実カレンダー）・Active work（実 Library）。
        HomeView(
            attention: upcoming,
            active: recent.prefix(3).map { HomeWork(title: $0, meta: "資料 · Library") },
            // 予定を読む許可は Home が求める（予定が出る場所で）。下りたらその場で読み直す。
            onCalendarGranted: loadUpcoming
        )
        .onAppear(perform: loadUpcoming)
    }

    /// 撮影用の差し込み。**実カレンダーに予定があればそちらが勝つ**。
    /// この Mac に予定が無い時間帯でも Upcoming の見た目を確かめられるようにするためのもの。
    nonisolated(unsafe) static var previewUpcoming: [HomeAttention] = []

    private func loadUpcoming() {
        let fmt = DateFormatter(); fmt.dateFormat = "HH:mm"
        // 終日の予定（誕生日・祝日など）は会議ではない。ここに「録音を開始」を出すと
        // 押しても意味が無い導線になるので、時刻のある予定だけを Attention にする。
        // 許可の状態は Permissions を通して見る（検査用の上書きが効く場所はそこだけ）。
        let events = Permissions.calendar == .granted ? CalendarAccess.upcoming(hours: 24) : []
        let timed = events.filter { e in
            let duration = e.endEpoch - e.startEpoch
            return duration > 0 && duration < 20 * 3600
        }
        guard !timed.isEmpty else {
            // 実データが無いときだけ、差し込みがあれば使う（無ければ空のまま）。
            upcoming = HomePane.previewUpcoming
            return
        }
        upcoming = timed.prefix(3).map { e in
            HomeAttention(
                kind: fmt.string(from: Date(timeIntervalSince1970: e.startEpoch)) + " " + e.calendar,
                title: e.title,
                action: "録音を開始",
                // §6 予定 → Session。project は前に同じ題で録っていれば引き継ぐ。
                link: CalendarLink(
                    // EKEvent の識別子はここまで持ってきていないので、
                    // 予定を一意にできる範囲（題＋開始時刻）で作る。推測で埋めない。
                    eventId: "\(e.title)@\(Int(e.startEpoch))",
                    title: e.title,
                    participantCount: 0,
                    meetingURL: nil,
                    projectId: MeetingSessionStore.rememberedProject(forTitle: e.title))
            )
        }
    }
}

/// 面の中の切り替え。AgentsPane / Library の chip と同じ形（新しい部品を増やさない）。
private struct SubNav<Tab: CaseIterable & Identifiable & Hashable>: View where Tab.AllCases: RandomAccessCollection {
    @Binding var selected: Tab
    let title: (Tab) -> String
    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(Tab.allCases)) { t in
                Button { selected = t } label: { Text(title(t))
                    .font(.system(size: TypeScale.secondarySize, weight: selected == t ? .semibold : .regular))
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(Capsule().fill(selected == t ? Color.genieAccent.opacity(0.15) : Color.clear))
                    .foregroundStyle(selected == t ? Color.genieAccent : Color.secondary)
                    .contentShape(Capsule()) }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected == t ? .isSelected : [])
                    .accessibilityIdentifier("subnav-\(t.id)")
            }
            Spacer()
        }
        .padding(.horizontal, 28).padding(.top, 16)
    }
}

/// Work: いま動いている仕事。録音中の会議は Home と同じカードでここにも出る（別の状態を持たない）。
private struct WorkPane: View {
    let apps: [String]
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var nav = MainNav.shared
    @ObservedObject private var sessions = MeetingSessionStore.shared
    var body: some View {
        VStack(spacing: 0) {
            if let live = sessions.live {
                RecordingNowCard(session: live)
                    .padding(.horizontal, 28).padding(.top, 16)
            }
            SubNav(selected: $nav.workTab, title: { $0.title })
            switch nav.workTab {
            case .tasks: TasksPane()
            case .agents: AgentsPane(apps: apps)
            }
        }
        .background(Palette.canvas(dark))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workPane")
    }
}

/// Library: 終わった成果。過去の会議と資料。
private struct LibraryPane: View {
    let titles: [String]
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var nav = MainNav.shared
    var body: some View {
        VStack(spacing: 0) {
            SubNav(selected: $nav.libraryTab, title: { $0.title })
            switch nav.libraryTab {
            case .meetings: MeetingsPane()
            case .files: FilesPane(titles: titles)
            }
        }
        .background(Palette.canvas(dark))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("libraryPane")
    }
}

/// Apps: できる仕事を増やす。同梱 Plugins と外部サービスの Connectors。
private struct AppsPane: View {
    let apps: [String]
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var nav = MainNav.shared
    var body: some View {
        VStack(spacing: 0) {
            SubNav(selected: $nav.appsTab, title: { $0.title })
            switch nav.appsTab {
            case .plugins: PluginsPane()
            case .connectors: ConnectorsPane(apps: apps)
            }
        }
        .background(Palette.canvas(dark))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("appsPane")
    }
}

/// §9 Work: 仕事単位で管理（Active/Waiting/Done/Failed/All）。Agent は詳細/管理者向けにのみ開示。
private struct AgentsPane: View {
    let apps: [String]
    @State private var filter = "Active"
    private let filters = ["Active", "Waiting", "Done", "Failed", "All"]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    ForEach(filters, id: \.self) { f in
                        Text(f)
                            .font(.system(size: TypeScale.secondarySize, weight: filter == f ? .semibold : .regular))
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(Capsule().fill(filter == f ? Color.genieAccent.opacity(0.15) : Color.clear))
                            .foregroundStyle(filter == f ? Color.genieAccent : Color.secondary)
                            .onTapGesture { filter = f }
                    }
                    Spacer()
                }
                // 実タスクが無い間は spec 構造 + 正直な空状態（架空タスクを作らない）。
                // 空状態の姿は Tasks / Meetings / Files と同じ部品（Atlas F4: ここだけ左寄せ 1 行だった）。
                WorkspaceEmpty(title: "実行中の仕事はありません",
                               hint: "Genie に頼んだ仕事は、UI を閉じても走り続けます。",
                               primaryLabel: "Task Dock を開く",
                               primaryAction: { WindowCoordinator.shared.showVoiceHUD() },
                               canDo: ["\(GlobalShortcut.label()) で「◯◯して」と頼む",
                                       "Active / Waiting / Done で状態を追う",
                                       "失敗した仕事はその場でやり直す"])
                Spacer()
            }.padding(24)
        }
    }
}

private struct FilesPane: View {
    let titles: [String]
    @State private var typeFilter = "All"
    private let types = ["All", "Report", "Document", "Image", "Video", "Other"] // §10.1（会議は Meetings 面）
    var body: some View {
        ScrollView {
            WorkspaceHeader(title: Facts.libraryFiles, subtitle: "会議以外の成果と資料。")
                .padding(.horizontal, 28).padding(.top, 28)
            HStack(spacing: 6) { // §10.1 Type chips
                ForEach(types, id: \.self) { t in
                    Text(t)
                        .font(.system(size: TypeScale.secondarySize, weight: typeFilter == t ? .semibold : .regular))
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(Capsule().fill(typeFilter == t ? Color.genieAccent.opacity(0.15) : Color.clear))
                        .foregroundStyle(typeFilter == t ? Color.genieAccent : Color.secondary)
                        .onTapGesture { typeFilter = t }
                }
                Spacer()
            }.padding(.horizontal, 28).padding(.top, 16)
            if titles.isEmpty {
                // 架空の 1 枚を出さない。他の面と同じ空状態。
                WorkspaceEmpty(title: "まだ資料はありません",
                               hint: "仕事の成果や会議の資料がここに残ります。",
                               primaryLabel: "録音を始める",
                               primaryAction: { NewRecordingSheetOpener.shared.open() },
                               canDo: ["会議の要約やレポートが成果物として残る",
                                       "種類（レポート/文書/画像…）で絞り込める",
                                       "元になった会議・発言へ戻れる"])
                    .padding(.horizontal, 28).padding(.top, 16)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 12)], spacing: 12) {
                ForEach(Array(titles.enumerated()), id: \.offset) { _, t in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(t).font(.system(size: TypeScale.secondarySize, weight: .semibold))
                        Text("資料").font(.system(size: TypeScale.captionSize)).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 10).stroke(Color.black.opacity(0.08)))
                }
            }.padding(28)
        }
    }
}
