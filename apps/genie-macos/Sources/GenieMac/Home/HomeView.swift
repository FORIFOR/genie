import SwiftUI

/// §8 Home: KPI dashboard ではなく「今必要な仕事への入口」。greeting + intent、Attention 最大3、Active work、Recent。
/// 寸法/色/余白は tokens 由来（Palette/TypeScale/Space）。KPI は常設しない（§8.1）。
struct HomeAttention: Identifiable {
    let id = UUID()
    let kind: String
    let title: String
    let action: String
    /// 予定から録るときに引き継ぐもの（無ければ予定なし録音と同じ扱い）。
    var link: CalendarLink?
}
struct HomeWork: Identifiable { let id = UUID(); let title: String; let meta: String }

struct HomeView: View {
    /// §10 Interface Size を変えたら描き直す（購読していないと変わらない）。
    @ObservedObject private var uiScale = UIScale.shared
    @Environment(\.colorScheme) private var scheme
    /// 既定は時刻から作る。以前は "Good morning" 固定で、夜に開いても朝の挨拶を返し、
    /// 日本語の画面に 1 行だけ英語が混ざっていた（実機の 18 時台の撮影で判明）。
    var greeting: String = HomeView.greetingForNow()
    var attention: [HomeAttention] = []
    var active: [HomeWork] = []
    /// 予定を読む許可が下りた直後に呼ぶ（持ち主が予定を読み直す）。
    var onCalendarGranted: () -> Void = {}
    private var dark: Bool { scheme == .dark }
    private var hasScreenshot: Bool { nav.intentVisualContext?.isEmpty == false }
    private var intentPlaceholder: String { hasScreenshot ? "この画像について、何を知りたいですか？" : Facts.homeIntentPlaceholder }
    @ObservedObject private var nav = MainNav.shared
    @State private var submitIssue = ""
    @State private var connectionTask: Task<Void, Never>?
    @State private var showContext = false
    /// 実データ。無ければその節ごと出さない。
    @State private var recentTasks: [AgentTask] = []
    @State private var recordedCount = 0
    @State private var pluginCount = 0
    /// 復旧を押したあとの返事。押して何も起きないように見せない。
    @State private var recoverNote = ""
    /// ⌥Space の許可を求めたあとか。求めた直後は、次にどこを見ればよいか言う。
    @State private var inputMonitoringAsked = false
    /// 予定を読む許可の状態。開いた瞬間には求めない（下の calendarAskRow を押したときだけ）。
    @State private var calendar: Permissions.State = Permissions.calendar
    @ObservedObject private var voice = VoiceHUDState.shared
    @ObservedObject private var store = GenieStateStore.shared
    @ObservedObject private var sessions = MeetingSessionStore.shared
    @ObservedObject private var sheetOpener = NewRecordingSheetOpener.shared
    @ObservedObject private var initialProfile = InitialProfileStore.shared
    @ObservedObject private var work = WorkContextStore.shared
    @ObservedObject private var backend = MainData.shared
    @ObservedObject private var credentialRecovery = MainData.shared.credentialRecovery
    @FocusState private var intentFocused: Bool

    static func greetingForNow(_ date: Date = Date()) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case 5..<11: return "おはようございます"
        case 11..<18: return "こんにちは"
        default: return "こんばんは"
        }
    }

    var body: some View {
        ZStack {
            if initialProfile.visible && nav.intentVisualContext == nil { InitialProfileView() } else { homeBody }
            // §4 New Recording は Home に**重ねて**出す。window を増やさない。
            if sheetOpener.isOpen {
                Color.black.opacity(0.24)
                    .ignoresSafeArea()
                    .onTapGesture { sheetOpener.close() }
                NewRecordingSheet(isPresented: Binding(
                    get: { sheetOpener.isOpen },
                    set: { sheetOpener.isOpen = $0 }))
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
                    .shadow(color: .black.opacity(dark ? 0.5 : 0.22), radius: 40, y: 16)
            }
        }
        .animation(.easeOut(duration: 0.14), value: sheetOpener.isOpen)
        .onChange(of: nav.intentFocusRequest) { _, request in focusIntent(request) }
        .onAppear { if nav.intentVisualContext != nil { intentFocused = true } }
        .onDisappear { connectionTask?.cancel() }
    }

    private func focusIntent(_ request: UUID) {
        guard NSApp.isActive, let window = NSApp.keyWindow, !(window is NSPanel) else { return }
        // Keep a live IME composition and selection intact when already editing.
        if intentFocused, window.firstResponder is NSTextView { return }
        // SwiftUI may still report true after the nonactivating Dock took keyboard
        // ownership. A new transition is needed once Home really is the key window.
        intentFocused = false
        DispatchQueue.main.async {
            guard nav.intentFocusRequest == request, nav.section == .home,
                  !sheetOpener.isOpen, window.isKeyWindow, NSApp.isActive else { return }
            intentFocused = true
        }
    }

    private var homeBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: S.metric(Space.largePadding)) {
                if let live = sessions.live { RecordingNowCard(session: live) }
                VStack(alignment: .leading, spacing: 8) {
                    if !hasScreenshot {
                        Text(greeting)
                            .font(.system(size: S.type(TypeScale.secondarySize)))
                            .foregroundStyle(Palette.muted(dark))
                    }
                    Text(hasScreenshot ? "この画像について質問" : "今日は、何を形にしますか。")
                        .font(.system(size: S.type(TypeScale.pageTitleSize), weight: TypeScale.pageTitleWeight))
                        .foregroundStyle(Palette.text(dark))
                    Text(hasScreenshot ? "知りたいことや、してほしいことを書いてください。" : "メモから文章をつくり、Workで編集・Markdown保存できます。")
                        .font(.system(size: S.type(TypeScale.secondarySize)))
                        .foregroundStyle(Palette.muted(dark))
                }
                .padding(.top, S.metric(Space.cardPadding))
                intentField
                HStack(spacing: Space.base) {
                    ForEach(GuidePermission.capabilityOrder, id: \.rawValue) { permission in
                        Button { PermissionPractice.use(permission) } label: {
                            Label(permission.capabilityTitle, systemImage: permission.symbol)
                        }
                        .buttonStyle(.bordered)
                        .font(.system(size: S.type(TypeScale.secondarySize)))
                        .accessibilityIdentifier("homeCapability-" + permission.rawValue)
                    }
                }
                // Accepted requests have their own persistent workspace. Only preflight
                // failures belong beside the draft; never repeat a full result here.
                if !submitIssue.isEmpty {
                    if backend.connectionIssue == .credentialAccess {
                        GatewayCredentialRecoveryView(state: credentialRecovery.state) {
                            Task { await backend.confirmCredentialReadAfterUserRequest() }
                        }
                    } else {
                        Text(submitIssue).font(.system(size: S.type(TypeScale.secondarySize)))
                            .foregroundStyle(Palette.warning(dark)).textSelection(.enabled)
                    }
                }
                starterRequests
                if !recentTasks.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            section("仕事を続ける")
                            Spacer()
                            Button("すべての仕事") { nav.select(.work); nav.workTab = .tasks }
                                .buttonStyle(.plain).foregroundStyle(Palette.muted(dark))
                                .font(.system(size: S.type(TypeScale.secondarySize)))
                                .accessibilityIdentifier("homeAllTasks")
                        }
                        ForEach(recentTasks.prefix(3)) { task in
                            TaskHistoryRow(task: task) { nav.openTask = task }
                        }
                    }.padding(.top, S.metric(Space.cardPadding))
                }
                if let interrupted = sessions.recent.first(where: { $0.status == .interrupted }) {
                    VStack(alignment: .leading, spacing: 12) {
                        section("続きから確認する会議")
                        SessionCard(session: interrupted) { openDetail(interrupted) }
                    }
                }
                Divider()
                if recordedCount > 0 {
                    Button { showContext = true } label: {
                        Label("復旧できる録音が \(recordedCount) 件あります", systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(.plain).foregroundStyle(Palette.muted(dark))
                    .font(.system(size: S.type(TypeScale.secondarySize)))
                    .accessibilityIdentifier("homeRecoveryNotice")
                }
                DisclosureGroup("会議と今日の状況", isExpanded: $showContext) {
                    VStack(alignment: .leading, spacing: S.metric(Space.largePadding)) {
                        if sessions.live == nil { StartRecordingCard() }
                        if recordedCount > 0 { recoverableRow }
                        if work.brief != nil { MeetingBriefRow() }
                        if work.context != nil { WorkContextCard() }
                        if !attention.isEmpty {
                            section("これからの予定")
                            ForEach(attention.prefix(3)) { upcomingRow($0) }
                        } else if calendar == .notDetermined { calendarAskRow }
                        if !sessions.recent.isEmpty {
                            section("最近の会議")
                            ForEach(sessions.recent.filter { $0.status != .interrupted }.prefix(3)) { session in
                                SessionCard(session: session) { openDetail(session) }
                            }
                        }
                    }.padding(.top, S.metric(Space.cardPadding))
                }
                .font(.system(size: S.type(TypeScale.secondarySize)))
                .foregroundStyle(Palette.muted(dark))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("homeContextDisclosure")
            }
            .padding(S.metric(Space.largePadding))
            .frame(maxWidth: S.metric(Metrics.homeContentWidth), alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(Palette.canvas(dark))
        .accessibilityIdentifier("homeView")
        .onAppear {
            loadReal()
            work.load()
            // 許可の状態は開くたびに読み直す。設定で許可して戻ってきても、
            // 予定を求める行が古い状態（初回に読んだ値）のままだった。
            calendar = Permissions.calendar
        }
        .onReceive(NotificationCenter.default.publisher(for: LocalStore.tasksChanged).receive(on: RunLoop.main)) { _ in
            recentTasks = LocalStore.shared.loadTasks()
        }
    }

    private func openDetail(_ session: MeetingSession) {
        MainNav.shared.openSession = session.id
        MainNav.shared.section = .library
        MainNav.shared.libraryTab = .meetings   // sidebar で出たときに会議一覧へ戻れるように
    }

    /// 入力欄の見た目をして**入力できない**ラベルだった（実機で判明）。
    /// 本物の TextField にし、Enter で Voice HUD と同じ依頼経路へ送る。
    private var intentField: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let image = nav.intentVisualContext?.first {
                screenshotAttachment(image)
            }
            ZStack(alignment: .topLeading) {
                if nav.intentDraft.isEmpty {
                    Text(intentPlaceholder)
                        .foregroundStyle(Palette.muted(dark))
                        .padding(.leading, 5).padding(.top, 1)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $nav.intentDraft)
                    .scrollContentBackground(.hidden)
                    .focused($intentFocused)
                    .accessibilityLabel(intentPlaceholder)
                    .accessibilityIdentifier("homeIntentField")
            }
                .font(.system(size: S.type(TypeScale.bodySize)))
                .foregroundStyle(Palette.text(dark))
                .frame(height: S.metric(Metrics.homeComposerEditorHeight))
            Text(ProcessInfo.processInfo.environment["ASTRA_MODEL_DISCLOSURE"]
                 ?? "送信先: 接続先で設定されたモデル。外部モデルは内容を受信し、利用料金が発生する場合があります。接続設定を確認してから送信してください。")
                .font(.system(size: S.type(TypeScale.microSize)))
                .foregroundStyle(Palette.muted(dark))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("homeModelDisclosure")
            HStack(spacing: 10) {
                // 声で依頼する = Genie と会話（音声入力は文章を入れるだけなので、ここでは使わない）。
                Button { voice.beginConversation() } label: {
                    Image(systemName: "mic").frame(width: 28, height: 28)
                }
                .buttonStyle(GenieControlStyle(radius: 8, filled: false))
                .disabled(voice.requestInFlight || credentialRecovery.isChecking)
                .accessibilityLabel("声で依頼する")
                .help("声で依頼する")
                .accessibilityIdentifier("homeIntentMic")
                Text(connectionTask != nil ? "接続を確認しています…" : (voice.requestInFlight ? "依頼を処理しています…" : Facts.homeSubmitHint))
                    .font(.system(size: S.type(TypeScale.microSize)))
                    .foregroundStyle(Palette.muted(dark))
                Spacer(minLength: 0)
                Button(action: submitIntent) {
                    Label("送信", systemImage: "arrow.up")
                        .font(.system(size: S.type(TypeScale.secondarySize), weight: .medium))
                        .padding(.horizontal, 12).frame(height: 28)
                }
                .buttonStyle(.borderedProminent).tint(Palette.accent(dark))
                .keyboardShortcut(UserShortcut.submitRequest.key, modifiers: UserShortcut.submitRequest.modifiers)
                .disabled(nav.intentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || voice.requestInFlight || connectionTask != nil || credentialRecovery.isChecking)
                .accessibilityIdentifier("homeIntentSend")
            }
        }
        .padding(S.metric(Space.cardPadding))
        .background(RoundedRectangle(cornerRadius: Metrics.intentRadius, style: .continuous)
            .fill(Palette.surface(dark)).overlay(RoundedRectangle(cornerRadius: Metrics.intentRadius, style: .continuous)
                .stroke(intentFocused ? Palette.accent(dark) : Palette.border(dark),
                        lineWidth: intentFocused ? Metrics.focusRing : 1)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("homeComposer")
    }

    private func screenshotAttachment(_ image: VisualContextArtifact) -> some View {
        HStack(spacing: S.metric(Space.base)) {
            Group {
                if let preview = NSImage(contentsOf: image.imageURL) {
                    Image(nsImage: preview).resizable().scaledToFit()
                } else { Image(systemName: "photo.badge.exclamationmark") }
            }
            .frame(width: 56, height: 42)
            .accessibilityLabel("質問に添える画像のプレビュー")
            VStack(alignment: .leading, spacing: S.metric(Space.compact)) {
                Text(image.kind == .clipboardImage ? "コピーした画像" : Facts.screenshotChip)
                    .font(.system(size: S.type(TypeScale.secondarySize), weight: .medium))
                Text(VisualEgressPolicy.current.disclosure)
                    .font(.system(size: S.type(TypeScale.microSize)))
                    .foregroundStyle(Palette.muted(dark))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button { nav.removeIntentScreenshot() } label: {
                Image(systemName: "xmark").frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("質問から画像を外す")
            .accessibilityIdentifier("homeRemoveScreenshot")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("homeScreenshotAttachment")
    }

    /// 依頼の途中と結果をその場に返す（押した先が見えないと不安になる）。
    /// 次の会議が 2 時間以内か（決定的）。
    private var briefIsSoon: Bool {
        guard let b = work.brief, let start = WorkFormat.parse(b.startsAt) else { return false }
        return start.timeIntervalSinceNow < 2 * 3600
    }

    private func loadReal() {
        recentTasks = LocalStore.shared.loadTasks()
        recordedCount = RecordingRuntime.shared.recoverableMeetings().count
        PluginRuntimeStore.shared.load()
        pluginCount = PluginRuntimeStore.shared.manifests.count
    }

    private func submitIntent() {
        guard connectionTask == nil, !voice.requestInFlight, !credentialRecovery.isChecking else { return }
        let text = nav.intentDraft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let images = nav.intentVisualContext
        submitIssue = ""
        connectionTask = Task { @MainActor in
            defer { connectionTask = nil }
            let result = await HomeIntentSubmission.run(
                needsConnection: VoiceHUDState.homeIntentNeedsGateway(text, visualContext: images),
                connect: { await MainData.shared.ensureConnected(afterUserAction: true) },
                isCurrent: { nav.intentDraft == text && nav.intentVisualContext?.map(\.id) == images?.map(\.id) },
                submit: { voice.ask(text, newConversation: true, visualContext: images) })
            switch result {
            case .submitted:
                nav.finishIntentSubmission()
                if let id = voice.latestRequestID {
                    nav.openTask = LocalStore.shared.loadTasks().first { $0.id == id }
                }
            case .unavailable:
                submitIssue = MainData.shared.connectionIssue?.message
                    ?? "接続を確認してください。入力は残しています。"
            case .rejected: submitIssue = voice.answer
            case .cancelled, .draftChanged: break
            }
        }
    }

    private var starterRequests: some View {
        HStack(alignment: .top, spacing: 12) {
            starter("メモをチェックリストに", detail: "例文を編集して、最初の成果物へ", icon: "checklist",
                prompt: TaskRequestRecord.firstExample)
            starter("Webの改善提案", detail: "課題を、伝わる提案に", icon: "rectangle.and.text.magnifyingglass",
                prompt: "Webサイトの改善提案をまとめてください。\n会社・サービス: \n現在の内容と課題: \n目的: \n優先順位と、変更前後の文言案を含めてください。")
            starter("アイデアを具体化", detail: "検証できる計画をつくる", icon: "pencil.and.outline",
                prompt: "アイデアを小さく検証する計画にしてください。\nアイデア: \n誰のどんな課題を解決するか: \n予算と期限: \n最初の成果物と、成功を判断する基準を決めてください。")
        }
    }

    private func starter(_ title: String, detail: String, icon: String, prompt: String) -> some View {
        Button {
            nav.intentDraft = nav.intentDraft.isEmpty ? prompt : nav.intentDraft + "\n\n" + prompt
            intentFocused = true
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon).font(.system(size: 18)).foregroundStyle(Palette.muted(dark))
                Text(title).font(.system(size: S.type(TypeScale.secondarySize), weight: .medium))
                    .foregroundStyle(Palette.text(dark))
                Text(detail).font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(dark))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(S.metric(Space.cardPadding))
            .contentShape(Rectangle())
        }
        .buttonStyle(GenieControlStyle(radius: Metrics.paletteRadius, base: 0.0))
        .accessibilityLabel(title + "：依頼文を入力")
    }

    /// 節の見出し。**中身より小さく静かに**する。以前は 22pt で、行より目立っていた。
    /// 録りかけを捨てる。**音が消えて戻せない**ので、必ず一度聞く（§16 R3）。
    private func discardPending() {
        let all = RecordingRuntime.shared.recoverableMeetings()
        guard !all.isEmpty else { recordedCount = 0; return }
        let go = Confirm.ask(ActionConfirmation(
            title: "録りかけ \(all.count) 件を捨てます",
            details: ["録音した音が消えます。戻せません",
                      "読み取りたいものがあるなら、先に「続きから」を試してください"],
            risk: .r3,
            confirmLabel: "\(all.count) 件を捨てる"))
        guard go else { return }
        RecoveryState.shared.pending = all
        let n = RecoveryState.shared.discardAll()
        recordedCount = RecordingRuntime.shared.recoverableMeetings().count
        recoverNote = recordedCount == 0 ? "\(n) 件を捨てました。" : "\(n) 件を捨てました（\(recordedCount) 件残っています）。"
    }

    /// 溜まっていた録りかけを片付ける。送れなかったときは黙らずに理由を返す。
    private func recoverPending() {
        RecoveryState.shared.pending = RecordingRuntime.shared.recoverableMeetings()
        let sent = RecoveryState.shared.recoverAll()
        let after = RecordingRuntime.shared.recoverableMeetings().count
        recordedCount = after
        // サインインしていないと送り先が無い。押しても何も起きないように見せない。
        recoverNote = sent > 0
            ? "\(recordedCount == 0 ? "すべて" : "一部を")読み取りました。"
            : "送り先がまだありません。サインインすると続きから読み取れます。"
    }

    /// 直近の録りかけがあるか（7 日以内）。
    ///
    /// 古いものまで警告色で出し続けると、ただの雑音になる。落ちた直後に気づける
    /// ことが大事なのであって、3 週間前の断片を毎朝知らせても誰も助からない。
    private var hasRecentRecoverable: Bool {
        let week: TimeInterval = 7 * 24 * 60 * 60
        let now = Date().timeIntervalSince1970
        return RecordingRuntime.shared.recoverableMeetings().contains { m in
            guard let started = TimeInterval(m.startedAt) else { return true }  // 読めないものは新しい扱い
            return now - started <= week
        }
    }

    /// 保存し切れていない録音がある、という報せ。件数だけ出して押せば続きへ。
    ///
    /// **主役の一段下に置く。** 以前は暖色の地と縁を敷いた札で、「録音を始める」と
    /// 同じ大きさ・より強い色で並んでいた。復旧は例外の道であって入口ではない。
    /// 色は印（アイコン）だけに残し、地は敷かず、字は 1 段小さく、縁は hairline。
    private var recoverableRow: some View {
        let recent = hasRecentRecoverable
        return HStack(spacing: 10) {
            Image(systemName: "arrow.counterclockwise.circle")
                .font(.system(size: 13))
                .foregroundStyle(recent ? Palette.warning(dark) : Palette.muted(dark))
            VStack(alignment: .leading, spacing: 2) {
                Text(recent
                     ? "録りかけが \(recordedCount) 件あります"
                     : "古い録りかけが \(recordedCount) 件残っています")
                    .font(.system(size: S.type(TypeScale.secondarySize),
                                  weight: recent ? .medium : .regular))
                    .foregroundStyle(recent ? Palette.text(dark) : Palette.muted(dark))
                Text(recoverNote.isEmpty
                     ? (recent
                        ? "前回、保存し切る前に終わった録音です。続きから読み取れます。"
                        : "1 週間より前のものです。要らなければ破棄できます。")
                     : recoverNote)
                    .font(.system(size: S.type(TypeScale.captionSize)))
                    .foregroundStyle(Palette.muted(dark))
            }
            Spacer(minLength: 0)
            // 件数を出すだけで手が無いと、毎回同じ数を見せられるだけになる。
            Button(Facts.recoveryResume) { recoverPending() }
                .font(.system(size: S.type(TypeScale.secondarySize), weight: .medium))
                .foregroundStyle(Palette.accent(dark))
                .frame(height: 30).padding(.horizontal, 12)
                .buttonStyle(GenieControlStyle(radius: 8, base: 0.05))
                .accessibilityIdentifier("recoverPending")
            // **捨てる道**。送り先が無ければ「続きから」は何もできないので、
            // これが無いと消せないお知らせを永久に見続けることになる。
            Button(Facts.recoveryDiscard) { discardPending() }
                .font(.system(size: S.type(TypeScale.secondarySize)))
                .foregroundStyle(Palette.muted(dark))
                .frame(height: 30).padding(.horizontal, 10)
                .buttonStyle(GenieControlStyle(radius: 8, base: 0.0))
                .accessibilityIdentifier("discardPending")
        }
        .padding(.horizontal, S.metric(Space.cardPadding))
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.hairline(dark)))
        .accessibilityIdentifier("recoverableRecordings")
    }

    private func section(_ t: String) -> some View {
        Text(t)
            .font(.system(size: S.type(TypeScale.microSize), weight: .semibold))
            .foregroundStyle(Palette.muted(dark))
            .tracking(0.4)
            .padding(.top, 6)
    }
    /// 予定の行。[Record] を押したらその場で録音が始まる（毎回設定を出さない）。
    private func upcomingRow(_ a: HomeAttention) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "calendar").font(.system(size: 12)).foregroundStyle(Palette.muted(dark))
            VStack(alignment: .leading, spacing: 2) {
                Text(a.title)
                    .font(.system(size: S.type(TypeScale.cardTitleSize), weight: TypeScale.cardTitleWeight))
                    .foregroundStyle(Palette.text(dark))
                Text(a.kind).font(.system(size: S.type(TypeScale.secondarySize))).foregroundStyle(Palette.muted(dark))
            }
            Spacer(minLength: 12)
            Button {
                // §6 予定から録ると、題・人数・URL・project を引き継ぐ。
                RecordingWorkspaceState.shared.pendingCalendarLink = a.link
                RecordingWorkspaceState.shared.start()
            } label: {
                HStack(spacing: 5) {
                    Circle().fill(Color.recordingRed).frame(width: 7, height: 7)
                    Text("録音").font(.system(size: S.type(TypeScale.secondarySize), weight: .medium))
                }
                .foregroundStyle(Palette.text(dark))
                .frame(height: 30).padding(.horizontal, 12)
            }
            .buttonStyle(GenieControlStyle(radius: 8, base: 0.05))
            .accessibilityIdentifier("record-\(a.title)")
        }
        .padding(S.metric(Space.cardPadding))
        .background(RoundedRectangle(cornerRadius: Metrics.paletteRadius, style: .continuous).fill(Palette.surface(dark))
            .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius, style: .continuous).stroke(Palette.border(dark), lineWidth: 1)))
    }

    /// 予定を読む許可を求める行。upcomingRow と同じ形（予定が入る場所に、予定の代わりに置く）。
    private var calendarAskRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "calendar").font(.system(size: 12)).foregroundStyle(Palette.muted(dark))
            VStack(alignment: .leading, spacing: 2) {
                Text("予定から録音を始める")
                    .font(.system(size: S.type(TypeScale.cardTitleSize), weight: TypeScale.cardTitleWeight))
                    .foregroundStyle(Palette.text(dark))
                Text(PermissionCenter.Capability.schedule.reason)
                    .font(.system(size: S.type(TypeScale.secondarySize))).foregroundStyle(Palette.muted(dark))
            }
            Spacer(minLength: 12)
            Button {
                // 予定を読む分だけ求める。マイクなど他の許可は巻き込まない。
                PermissionCenter.request(.schedule) {
                    calendar = Permissions.calendar
                    if calendar == .granted { onCalendarGranted() }
                }
            } label: {
                HStack(spacing: 5) {
                    Text("\(Facts.permissionCalendar)を許可")
                    Image(systemName: "arrow.right")
                        .font(.system(size: 10, weight: .semibold))
                }
                .font(.system(size: S.type(TypeScale.secondarySize), weight: .medium))
                .foregroundStyle(Palette.accent(dark))
                .frame(height: 30).padding(.horizontal, 12)
            }
            .buttonStyle(GenieControlStyle(radius: 8, base: 0.05))
            .accessibilityIdentifier("askCalendar")
        }
        .padding(S.metric(Space.cardPadding))
        .background(RoundedRectangle(cornerRadius: Metrics.paletteRadius, style: .continuous).fill(Palette.surface(dark))
            .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius, style: .continuous).stroke(Palette.border(dark), lineWidth: 1)))
    }

    private func row(icon: String, accent: Color, title: String, sub: String, action: String?) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: S.type(TypeScale.cardTitleSize), weight: TypeScale.cardTitleWeight)).foregroundStyle(Palette.text(dark))
                Text(sub).font(.system(size: S.type(TypeScale.secondarySize))).foregroundStyle(Palette.muted(dark))
            }
            Spacer()
            if let action { Text(action).font(.system(size: S.type(TypeScale.secondarySize), weight: .medium)).foregroundStyle(Palette.accent(dark)) }
        }
        .padding(S.metric(Space.cardPadding))
        .background(RoundedRectangle(cornerRadius: Metrics.paletteRadius, style: .continuous).fill(Palette.surface(dark))
            .overlay(RoundedRectangle(cornerRadius: Metrics.paletteRadius, style: .continuous).stroke(Palette.border(dark), lineWidth: 1)))
    }
}
