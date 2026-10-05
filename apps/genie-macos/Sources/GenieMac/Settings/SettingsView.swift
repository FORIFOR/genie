import SwiftUI

/// 設定 / 許可。ショートカット、声、そして OS 許可（マイク/画面/アクセシビリティ）の状態。
struct SettingsView: View {
    @State private var mic = Permissions.microphone
    @State private var screen = Permissions.screenRecording
    @State private var ax = Permissions.accessibility
    @State private var cal = Permissions.calendar
    @State private var input = Permissions.inputMonitoring
    @State private var speech = Permissions.speechRecognition
    @State private var showAdditionalPermissions: Bool
    @State private var showTransactionAuthorizations = false
    @State private var keyPresenceRevision = 0

    init(showAdditionalPermissions: Bool = false,
         gemini: GeminiLiveSettings? = nil, places: PlacesSettings? = nil) {
        _showAdditionalPermissions = State(initialValue: showAdditionalPermissions)
        _gemini = ObservedObject(wrappedValue: gemini ?? .shared)
        _places = ObservedObject(wrappedValue: places ?? .shared)
    }
    @ObservedObject private var practice = PermissionPractice.shared
    @State private var cloudTranscription = RecordingRuntime.cloudTranscriptionAllowed
    @ObservedObject private var gemini: GeminiLiveSettings
    @State private var geminiKeyDraft = ""
    @State private var geminiKeyMessage: String?
    @ObservedObject private var places: PlacesSettings
    @State private var placesKeyDraft = ""
    @State private var placesKeyMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("設定").font(.system(size: 20, weight: .semibold))

            section("ショートカット") {
                // 実際に登録しているグローバルショートカットを正として出す（GlobalShortcut）。
                row(Facts.settingsShortcutRow, GlobalShortcut.label())
            }
            section("任せている注文") {
                Button("条件・残りを確認、許可を取り消す…") { showTransactionAuthorizations = true }
                    .accessibilityIdentifier("settingsTransactionAuthorizations")
            }

            // §10 Interface Size。文字だけでなく面・余白も一緒に動く。
            section("表示の大きさ") {
                Picker("", selection: Binding(
                    get: { UIScale.shared.size },
                    set: { UIScale.shared.set($0) })) {
                    ForEach(UIScale.Size.allCases) { Text($0.title).tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .accessibilityIdentifier("uiScale")
            }
            section(Facts.settingsPermissionsSection) {
                capabilityRow(.microphone, state: mic)
                capabilityRow(.screenCapture, state: screen)
                capabilityRow(.accessibility, state: ax)
            }
            DisclosureGroup("その他の許可", isExpanded: $showAdditionalPermissions) {
                permissionRow(Facts.permissionSpeechRecognition, speech, reason: "会議を手元で文字にするには\(Facts.permissionSpeechRecognition)の許可が要ります。",
                              request: { Permissions.requestSpeechRecognition { _ in speech = Permissions.speechRecognition } })
                permissionRow(Facts.permissionCalendar, cal, reason: PermissionCenter.Capability.schedule.reason,
                              request: { Permissions.requestCalendar { _ in cal = Permissions.calendar } })
                // ⌥Space はこの許可が無いと黙って効かない。Home が空のときしか直す道が無かった。
                permissionRow("\(Facts.permissionInputMonitoring)（\(GlobalShortcut.label())）", input,
                              reason: Facts.permissionInputMonitoringReason, request: {
                    if !Permissions.requestInputMonitoring() { Permissions.openInputMonitoringSettings() }
                    input = Permissions.inputMonitoring
                })
            }

            section("文字起こし") {
                Toggle("ライブ文字起こし（Google STT）", isOn: Binding(
                    get: { cloudTranscription },
                    set: { allowed in
                        cloudTranscription = allowed
                        RecordingRuntime.setCloudTranscriptionAllowed(allowed)
                    }))
                .toggleStyle(.switch)
                .accessibilityIdentifier("cloudTranscriptionToggle")
                Text(cloudTranscription
                     ? "録音中の音声をGoogleへ送り、字幕をリアルタイムに表示します。"
                     : "音声はこのMac内だけで処理します。Googleのライブ字幕を使うにはオンにします。")
                    .font(.system(size: 11)).foregroundStyle(.primary).opacity(0.78)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Gemini Live は「会話」の相手を Google に替える。送るものと費用を、オンにする前に読める場所に書く。
            section("会話（Gemini Live）") {
                Toggle("会話で Gemini Live を使う", isOn: Binding(
                    get: { gemini.enabled },
                    set: { gemini.setEnabled($0) }))
                .toggleStyle(.switch)
                .disabled(!gemini.enabled && (!gemini.hasKey || gemini.checkingKey || gemini.keyAccessIssue != nil || gemini.budget.monthlyMinutes == 0))
                .accessibilityIdentifier("geminiLiveToggle")
                VStack(alignment: .leading, spacing: 2) {
                    Text("「会話」の間の声と文字起こしを Google に送ります。")
                    Text("利用料はあなたの API キーにかかります。")
                    Text("「聞く」と会議の録音は送りません。")
                    Text("天気やニュースは Gemini が Google 検索で答えます。")
                    Text("仕事の中身は Google に返しません。")
                }
                .font(.system(size: 11)).foregroundStyle(.primary).opacity(0.78)
                HStack {
                    SecureField(gemini.hasKey ? "API キーは保存済み（置き換える）" : "API キー", text: $geminiKeyDraft)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("geminiLiveKey")
                    Button(gemini.hasKey && geminiKeyDraft.isEmpty ? "キーを消す" : "保存") {
                        let ok = gemini.setKey(geminiKeyDraft)
                        geminiKeyMessage = ok ? (geminiKeyDraft.isEmpty ? "キーを消しました。" : "キーチェーンに保存しました。") : "キーチェーンに保存できませんでした。"
                        if ok { geminiKeyDraft = ""; if !gemini.hasKey { gemini.setEnabled(false) } }
                    }
                    .controlSize(.small)
                    .disabled(gemini.checkingKey || gemini.keyAccessIssue != nil || (!gemini.hasKey && geminiKeyDraft.isEmpty))
                }
                Stepper(value: Binding(get: { gemini.budget.monthlyMinutes },
                                       set: { gemini.setMonthlyMinutes($0); if $0 == 0 { gemini.setEnabled(false) } }),
                        in: 0...6_000, step: 10) {
                    Text(gemini.budget.monthlyMinutes == 0
                         ? "月の上限: 未設定（決めるまで使えません）"
                         : "月の上限: \(gemini.budget.monthlyMinutes) 分 ・ 今月 \(Int(gemini.budget.current(at: Date()).usedSeconds / 60)) 分使用")
                        .font(.system(size: 12))
                }
                .accessibilityIdentifier("geminiLiveMinutes")
                if let message = gemini.keyAccessIssue ?? geminiKeyMessage {
                    Text(message).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }

            // 近くの店は、現在地と検索語を Google に送る。送るものと費用を、キーを置く前に読める場所に書く。
            section("近くの店（Google マップ）") {
                VStack(alignment: .leading, spacing: 2) {
                    Text("近くの店を頼んだときだけ、現在地を Google に送ります。")
                    Text("使う API: Places API (New) と Static Maps")
                    Text("利用料はあなたの API キーにかかります。")
                    Text("結果は画面に出すだけで、保存しません。")
                }
                .font(.system(size: 11)).foregroundStyle(.primary).opacity(0.78)
                HStack {
                    SecureField(places.hasKey ? "API キーは保存済み（置き換える）" : "API キー", text: $placesKeyDraft)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("placesKey")
                    Button(places.hasKey && placesKeyDraft.isEmpty ? "キーを消す" : "保存") {
                        let ok = places.setKey(placesKeyDraft)
                        placesKeyMessage = ok ? (placesKeyDraft.isEmpty ? "キーを消しました。" : "キーチェーンに保存しました。") : "キーチェーンに保存できませんでした。"
                        if ok { placesKeyDraft = "" }
                    }
                    .controlSize(.small)
                    .disabled(places.checkingKey || places.keyAccessIssue != nil || (!places.hasKey && placesKeyDraft.isEmpty))
                }
                Stepper(value: Binding(get: { places.monthlyLimit }, set: { places.setMonthlyLimit($0) }),
                        in: 0...10_000, step: 10) {
                    Text(places.monthlyLimit == 0
                         ? "月の上限: 未設定（決めるまで使えません）"
                         : "月の上限: \(places.monthlyLimit) 回 ・ 今月 \(places.usedThisMonth()) 回使用")
                        .font(.system(size: 12))
                }
                .accessibilityIdentifier("placesMonthlyLimit")
                if let message = places.keyAccessIssue ?? placesKeyMessage {
                    Text(message).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }

            Text(practice.isReadingScreen ? "画面を1枚読み取り中です。外部には送信していません。" : "画面は必要なときだけ読み取ります。許可はmacOSの設定で変更できます。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(width: 460)
        .fixedSize(horizontal: false, vertical: true)
        .onChange(of: showAdditionalPermissions) { _, _ in SettingsWindowController.shared.resizeToContent() }
        .onChange(of: gemini.keyAccessIssue) { _, _ in SettingsWindowController.shared.resizeToContent() }
        .onChange(of: places.keyAccessIssue) { _, _ in SettingsWindowController.shared.resizeToContent() }
        .sheet(isPresented: $showTransactionAuthorizations) { TransactionAuthorizationListView() }
        .onAppear(perform: refreshPermissions)
        .task(id: keyPresenceRevision) {
            await gemini.refreshKeyPresence()
            guard !Task.isCancelled else { return }
            await places.refreshKeyPresence()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            refreshPermissions(); keyPresenceRevision += 1
        }
        .onReceive(NotificationCenter.default.publisher(for: SettingsWindowController.didShow)) { _ in
            refreshPermissions(); keyPresenceRevision += 1
        }
        .onReceive(PermissionGuideCoordinator.shared.$state) { _ in refreshPermissions() }
    }

    private func capabilityRow(_ permission: GuidePermission, state: Permissions.State) -> some View {
        HStack(alignment: .center, spacing: Space.base) {
            Image(systemName: permission.symbol).frame(width: 20)
            VStack(alignment: .leading, spacing: Space.compact) {
                Text(permission.capabilityTitle).font(.system(size: S.type(TypeScale.secondarySize)))
                Text("macOS：" + permission.systemPermissionName)
                    .font(.system(size: S.type(TypeScale.captionSize))).foregroundStyle(.secondary)
            }
            Spacer(minLength: Space.compact)
            if state == .granted {
                Label("準備完了", systemImage: "checkmark")
                    .font(.system(size: S.type(TypeScale.captionSize))).foregroundStyle(.secondary)
            }
            Button(state == .granted ? "試す" : "有効にする") {
                if state == .granted { PermissionPractice.use(permission) }
                else { PermissionGuideCoordinator.shared.explain(permission) { PermissionPractice.use(permission) } }
            }
            .controlSize(.small)
            .accessibilityLabel(permission.capabilityTitle + (state == .granted ? "を試す" : "を有効にする"))
            .accessibilityIdentifier("permissionGuide-" + permission.rawValue)
        }.padding(.vertical, Space.compact)
    }

    private func refreshPermissions() {
        mic = Permissions.microphone; screen = Permissions.screenRecording
        ax = Permissions.accessibility; cal = Permissions.calendar
        input = Permissions.inputMonitoring; speech = Permissions.speechRecognition
        cloudTranscription = RecordingRuntime.cloudTranscriptionAllowed
    }

    private func section<C: View>(_ title: String, action: (() -> Void)? = nil, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                if let action {
                    Spacer()
                    Button("設定を案内…", action: action).controlSize(.small)
                        .help("アクセシビリティ・画面収録・マイクの設定を順に案内します")
                        .accessibilityIdentifier("settingsPermissionGuide")
                }
            }
            content()
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack { Text(label).font(.system(size: 12)); Spacer()
            Text(value).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
    }

    private func permissionRow(_ label: String, _ state: Permissions.State, reason: String,
                               guided: GuidePermission? = nil, request: @escaping () -> Void = {}) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.system(size: 12))
                // 理由は補足ではなく、許可を出すかを決める材料。薄い灰では読めない（盲検 3/3）。
                Text(reason).font(.system(size: 11)).foregroundStyle(.primary).opacity(0.78)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Text(state.rawValue).font(.system(size: 11))
                .foregroundStyle(state == .granted ? .green : .secondary)
            if state != .granted {
                Button(guided == nil ? Facts.permissionRequest : "設定を案内…") {
                    if let guided { PermissionGuideCoordinator.shared.explain(guided) { PermissionPractice.use(guided) } }
                    else { request() }
                }.controlSize(.small)
                    .accessibilityLabel("\(label)：\(guided == nil ? Facts.permissionRequest : "設定を案内")")
                    .accessibilityIdentifier(guided.map { "permissionGuide-\($0.rawValue)" } ?? "permission-\(label)")
            }
        }
    }
}
