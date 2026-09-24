import AppKit
import SwiftUI

/// Task Dock。画面上辺中央に常駐する **Genie という一つの存在**。
///
/// 窓は増やさない。状態に応じてこの一枚が大きさと役割を変える:
///
/// ```text
/// idle          156×34   ◦
/// appContext    196×34   ◈ Notion
/// 展開          320×190  Notion / Q3 Product Roadmap / Suggested…
/// listening     420×84   ◉ ▁▂▄▆▃  このページからタスクを作って…
///                        Screen ✓  Notion ✓  Selection ✓
/// thinking      300×44
/// agent         480×可変 ✓ Calendar / ● Notion / ○ Web …
/// confirmation  420×210  Dock 自身が聞く（NSAlert も別窓も使わない）
/// meeting       460×56   必要な面だけ開く（常時 5 枚並べない）
/// ```
///
/// 高さが変わるときは **上辺の Y を固定**して下へ伸ばす（`WindowCoordinator`）。
struct VoiceTaskDockView: View {
    @ObservedObject var screenLayout: DockScreenLayout = DockScreenLayout()
    /// §10 Interface Size を変えたら描き直す（購読していないと変わらない）。
    @ObservedObject private var uiScale = UIScale.shared
    @ObservedObject private var store = GenieStateStore.shared
    @ObservedObject private var state = VoiceHUDState.shared
    /// スクショの chip で idle の幅が変わる。購読していないと `size` が古いまま、窓が 220 のまま中身が切れる（実測）。
    @ObservedObject private var visual = VisualContextStore.shared
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var dark: Bool { scheme == .dark }

    /// 面が縮み終わってから中身を出す。同時に動かすと中身がはみ出して見える。
    @State private var contentVisible = true

    var body: some View {
        ZStack(alignment: .top) {
            DockSurface()
            content
                .frame(width: size.width, height: size.height, alignment: .top)
                .padding(.top, screenLayout.topInset)
                .opacity(contentVisible ? 1 : 0)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: contentVisible)
        }
        // 地が暗いので、中身も暗色側の配色で描く。
        // 各 View は `@Environment(\.colorScheme)` を見ているので、ここで一括して切り替わる。
        .environment(\.colorScheme, .dark)
        .frame(width: size.width, height: size.height + screenLayout.topInset)
        .onChange(of: store.dock) { old, new in
            guard !reduceMotion else { return }
            // 会議 Dock の中で板（メモ / 字幕 / Ask）が開閉するだけのときは、変わらない見出し
            // （録音中・メモ・字幕・Ask Genie・停止）を消さない。全体を消すと、盲検 3 名全員が
            // 「途中で全面が真っ黒」と観察し、2 名が「別物が載った」と読んだ（journeys/perceived）。
            // 開閉する板の側だけが MeetingDock の中で同じ間合いで fade する。
            if case .meeting = old, case .meeting = new { return }
            // 面のリサイズが終わる少し後に中身を戻す（§Animation 40–70ms）。
            contentVisible = false
            DispatchQueue.main.asyncAfter(deadline: .now() + Motion.dockResizeMs + Motion.dockContentDelayMs) {
                contentVisible = true
            }
        }
        // **container として扱う。** `.accessibilityLabel` を付けると SwiftUI は
        // 全体を 1 要素に畳み、中の操作が AX に出なくなる（実寸を測ろうとしたら
        // Dock 全体で 1 個・96x19 しか取れなかった。それはラベルの寸法だった）。
        // VoiceOver から見ても、複数の操作を持つ面を 1 つの読み上げにするのは誤り。
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voiceHUD")
    }

    private var size: CGSize { store.dock.size(agentRows: store.state.activeTask?.steps.count ?? 0) }

    @ViewBuilder private var content: some View {
        switch store.dock {
        case .idle: IdleDock()
        case .appContext(let summary): AppContextDock(summary: summary, expanded: false)
        case .appContextExpanded(let summary): AppContextDock(summary: summary, expanded: true)
        case .listening(let partial): ListeningDock(partial: partial)
        case .thinking: ThinkingDock()
        case .agent: AgentDock()
        case .confirmation(let confirmation): ConfirmationDock(confirmation: confirmation)
        case .meeting(let panel): MeetingDock(open: panel)
        case .answer(let text): AnswerDock(text: text)
        case .result(let result): ResultDock(result: result)
        case .contextDetail: ContextDetailDock()
        case .quickActions: QuickActionsDock()
        case .enteringRecording: SimpleDock(icon: "record.circle", text: "録音を始めます…", tint: .recordingRed)
        }
    }
}

/// 旧名。既存の呼び出しを壊さないための別名。
typealias VoiceHUDView = VoiceTaskDockView

// MARK: - 短い回答（Task Dock 内で完結）

/// すぐ返せる質問の答えを、Task Dock から離れずに確認できる面。
/// 仕事の成果物（`ResultDock`）とは分け、短い回答には進捗や別の作業ボタンを混ぜない。
struct AnswerDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 9) {
                Image(systemName: "sparkles")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.accent(dark))
                Text("回答")
                    .font(.system(size: S.type(Metrics.dockTitleSize), weight: .semibold))
                    .foregroundStyle(Palette.text(dark))
                Spacer(minLength: 0)
                Button { copy() } label: {
                    Text(Facts.resultCopy)
                        .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                        .foregroundStyle(Palette.text(dark))
                        .frame(height: 28)
                        .padding(.horizontal, 9)
                }
                .buttonStyle(GenieControlStyle(radius: 7, base: 0.06))
                .accessibilityIdentifier("answerCopy")
                Button { GenieStateStore.shared.dismissResult() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted(dark))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
                .accessibilityIdentifier("answerDismiss")
                .accessibilityLabel("回答を閉じる")
            }
            ScrollView {
                Text(text)
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.text(dark))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 82)
            .accessibilityIdentifier("answerText")
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .escapeKey { GenieStateStore.shared.dismissResult() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockAnswer")
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

// MARK: - 1. Idle / Presence

/// 小さな入口。Genie の操作と録音を別々に押せる。
private struct IdleDock: View {
    @Environment(\.colorScheme) private var scheme
    @ObservedObject private var visual = VisualContextStore.shared
    var body: some View {
        // 撮影直後から、画像に対する質問へ直接進める。押すまでは focus を奪わない。
        if let shot = visual.justCaptured {
            // × は chip と同じ位置に（一瞬の面でも、消す手が同じ場所にあること — 盲検の consistency）。
            screenshotChip(shot: shot, tint: Palette.accent(scheme == .dark),
                           meta: Facts.screenshotDetected, dismiss: shot.id, id: "screenshotContextChip", metaIsState: true)
                .help(VisualEgressPolicy.current.disclosure)
        } else if let shot = visual.offeredCapture {
            // 質問で添えたあとは出所（初回「質問したときだけ Claude に送信」、以降「Claude に送信 · たった今」）。
            screenshotChip(shot: shot, tint: Palette.muted(scheme == .dark),
                           meta: visual.lastProvenance.map { $0.contains("質問") ? $0 : "\($0) · \(shot.ageLabel())" } ?? shot.ageLabel(),
                           dismiss: shot.id, id: "screenshotContextChipSmall")
                .help(VisualEgressPolicy.current.disclosure)
        } else {
        HStack(spacing: 7) {
            Button { VoiceHUDState.shared.toggleQuickActions() } label: {
                HStack(spacing: 7) {
                    GenieVoiceMark()
                    Text("Genie")
                        .font(.system(size: S.type(Metrics.dockPrimarySize), weight: .medium))
                }
                .foregroundStyle(Palette.text(scheme == .dark))
                .frame(maxHeight: .infinity)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("dockOpenActions")
            .accessibilityLabel("Genieの操作を開く")
            Spacer(minLength: 0)
            Button { WindowCoordinator.shared.toggleRecording() } label: {
                Label(Facts.dockRecord, systemImage: "record.circle")
                    .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                    .frame(height: 32)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0))
            .accessibilityIdentifier("dockStartRecording")
            .help(GlobalShortcut.shared.isRegistered
                  ? Facts.recordingMenuStart + " · " + GlobalShortcut.label() : Facts.recordingMenuStart)
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .frame(maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockIdle")
        }   // else（スクショ chip でないとき = 通常の idle）
    }

    /// 1 行目は画像について質問する入口、2 行目は撮影元と時刻。
    /// 先頭は**その画像の縮小**（どの絵の話かが一目で分かる。記号だけだと「何かの通知」に見える — 盲検の指摘）。
    /// `metaIsState`: 2 行目が「いま起きたこと」（認識の一瞬）なら本文色で出す（薄い灰では状態の変化に気づけない — 盲検）。
    private func screenshotChip(shot: VisualContextArtifact, tint: Color, meta: String, dismiss: UUID?, id: String, metaIsState: Bool = false) -> some View {
        HStack(spacing: 10) {
            Button { MainWindowController.shared.askAboutScreenshot(shot) } label: {
                HStack(spacing: 10) {
                    ScreenshotThumb(url: shot.imageURL, tint: tint)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("この画像について質問")
                            .font(.system(size: S.type(Metrics.dockPrimarySize), weight: .medium))
                            .foregroundStyle(Palette.accent(scheme == .dark))
                            .lineLimit(1)
                        Text("\(shot.kind == .clipboardImage ? "コピーした画像" : Facts.screenshotChip) · \(shot.ageLabel())")
                            .font(.system(size: S.type(Metrics.dockMetaSize)))
                            .foregroundStyle(metaIsState ? Palette.text(scheme == .dark) : Palette.muted(scheme == .dark))
                            .lineLimit(1)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("screenshotOpenActions")
            .accessibilityLabel("この画像について質問")
            .help("画像を添えた質問欄を開きます。送信するまでAIには渡しません。")
            Spacer(minLength: 0)
            if let dismiss {
                Button { VisualContextStore.shared.remove(dismiss) } label: {
                    Image(systemName: "xmark").font(.system(size: 10)).foregroundStyle(Palette.muted(scheme == .dark))
                }.buttonStyle(GenieControlStyle(radius: 6, base: 0.0))
                    .accessibilityIdentifier("dismissScreenshot")
                    .accessibilityLabel("スクリーンショットの案内を閉じる")
            }
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .frame(maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
    }
}

/// スクショの縮小（28×20、角丸 4、細い縁）。読めなければ記号に落ちる。
struct ScreenshotThumb: View {
    let url: URL
    let tint: Color
    var body: some View {
        Group {
            if let img = NSImage(contentsOf: url) {
                Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "photo").font(.system(size: 12)).foregroundStyle(tint)
            }
        }
        .frame(width: 28, height: 20)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(Color.white.opacity(0.22), lineWidth: 1))
        .accessibilityHidden(true)
    }
}

// MARK: - 2. App Context

/// アプリを認識したとき。閉じているときは **1 行だけ**（巨大 popup を出さない）。
struct AppContextDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let summary: AppContextSummary
    let expanded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: "diamond.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(Palette.accent(dark))
                Text(summary.app)
                    .font(.system(size: S.type(Metrics.dockPrimarySize), weight: .medium))
                    .foregroundStyle(Palette.text(dark))
                Spacer(minLength: 0)
                if !summary.suggestions.isEmpty {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Palette.muted(dark))
                }
            }
            .padding(.horizontal, S.metric(Metrics.dockPadH))
            .frame(height: Metrics.dockContextHeight)
            .contentShape(Rectangle())
            .onTapGesture { VoiceHUDState.shared.toggleContextExpanded() }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("dockAppContext")

            if expanded {
                Divider().overlay(Palette.border(dark))
                // 左端は 1 本。題・見出し・候補の字がすべて padH（20）から始まる。
                // 候補の押せる矩形は字より 8pt 外へ張り出すので、列全体を padH-8 に置き、
                // 題と見出しだけ 8 戻す。（前は 16 / 16 / 24 の 3 本になっていた。実測。）
                VStack(alignment: .leading, spacing: 8) {
                    if let document = summary.document {
                        Text(document)
                            .font(.system(size: S.type(Metrics.dockTitleSize), weight: .semibold))
                            .foregroundStyle(Palette.text(dark))
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                    }
                    DockLabel(text: Facts.dockSuggested)
                        .padding(.horizontal, 8)
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(summary.suggestions, id: \.self) { s in
                            Button { VoiceHUDState.shared.runSuggestion(s) } label: {
                                HStack(spacing: 8) {
                                    // 押せる行だと分かるよう、各行に控えめなアイコン（Raycast の作法）。
                                    Image(systemName: "arrow.turn.down.right")
                                        .font(.system(size: 11))
                                        .foregroundStyle(Palette.muted(dark))
                                        .frame(width: 14)
                                    Text(s)
                                        .font(.system(size: S.type(Metrics.dockRowSize)))
                                        .foregroundStyle(Palette.text(dark))
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 8)
                                .frame(height: Metrics.dockAgentRowHeight)
                            }
                            .buttonStyle(GenieControlStyle(radius: 6, base: 0.0))
                            .accessibilityIdentifier("suggest-\(s)")
                        }
                    }
                }
                .padding(.horizontal, S.metric(Metrics.dockPadH) - 8)
                .padding(.top, 9)
                // 最後の候補の下は padV。面の高さは実寸で決まるので、ここが底になる。
                .padding(.bottom, S.metric(Metrics.dockPadV))
                Spacer(minLength: 0)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - 3. Listening

/// 声を聞いている。主役は波形ではなく**話した内容**。
/// 波形は左端の小さな印にとどめ、下に「何を見ているか」を必ず出す。
struct ListeningDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var store = GenieStateStore.shared
    @ObservedObject private var voice = VoiceHUDState.shared
    @ObservedObject private var session = VoiceSessionController.shared
    let partial: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 9) {
                GenieOrb(mode: voice.listeningAwaitingAudio ? .preparing : .listening,
                         level: voice.inputLevel)
                // **取り込みが生きるまで「聞いています…」と名乗らない。**
                // 切り替えるのは最初の音声フレームの到着（`listeningAwaitingAudio`）で、タイマーではない。
                Text(partial.isEmpty
                     ? (voice.listeningAwaitingAudio ? Facts.recordingHeroPreparing : Facts.listeningPlaceholder)
                     : partial)
                    .font(.system(size: S.type(Metrics.dockSpeechSize)))
                    .foregroundStyle(partial.isEmpty ? Palette.muted(dark) : Palette.text(dark))
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                if session.isActive {
                    Text(session.remainingText)
                        .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium, design: .monospaced))
                        .foregroundStyle(Palette.muted(dark))
                        .accessibilityLabel("音声セッション残り")
                        .accessibilityValue(session.remainingText)
                }
                // マイクが開いている面に逃げ道が**見えない**、と盲検の 2 名が同じ観察をした
                // （journeys/panel1）。鍵は効いていても、書いていなければ無いのと同じ。
                KeyBadge(UserShortcut.cancel.display)
            }
            ContextStrip()
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        // 面の高さはこの view の実寸で決まる（`DockContentMeasure`）。上下は padV。
        // 120pt 固定だったころは 2 行 47pt の上下に 36pt ずつ空いていた。
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        // 逃げ道は確認面と同じ鍵。Esc で聞くのをやめる。
        .escapeKey { VoiceHUDState.shared.cancelListening() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockListening")
    }
}

/// 「AI がいま何を見ているか」。Listening 中は必ず出す（§Listening）。
struct ContextStrip: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var store = GenieStateStore.shared

    var body: some View {
        // 文脈が無いときは下段を**出さない**（「見えている文脈はありません」の否定文を出すと冷たく、
        // 情報量も 0。preparing/listening が 1 行に畳まれる）。文脈があるときだけ棚を出す。
        if store.state.context.items.isEmpty {
            EmptyView()
        } else {
            HStack(spacing: 12) {
                ForEach(store.state.context.items) { item in
                    HStack(spacing: 4) {
                        // 色を増やさない。印は形（✓）で伝え、色は orb だけに持たせる。
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Palette.muted(dark))
                        Text(item.application)
                            .font(.system(size: S.type(Metrics.dockMetaSize)))
                            .foregroundStyle(Palette.text(dark))
                    }
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(Palette.muted(dark))
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
            // Dropover の作法。棚を押すと、棚そのものが詳細へ広がる。
            .onTapGesture { VoiceHUDState.shared.mode = .contextDetail }
            .accessibilityIdentifier("contextStrip")
        }
    }
}

// MARK: - 4. Thinking

struct ThinkingDock: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 8) {
            GenieOrb(mode: .thinking)
            Text("考えています…")
                .font(.system(size: S.type(Metrics.dockPrimarySize)))
                .foregroundStyle(Palette.text(scheme == .dark))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockThinking")
    }
}

struct SimpleDock: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    let text: String
    var tint: Color = .secondary

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 14)).foregroundStyle(tint)
            Text(text)
                .font(.system(size: S.type(Metrics.dockPrimarySize)))
                .foregroundStyle(Palette.text(scheme == .dark))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        // 1 行の面。高さは実寸 + padV（idle の pill と同じ背丈になる）。
        // 88pt 固定だったころは 19pt の 1 行の上下に 34pt ずつ空いていた。
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockSimple")
    }
}

// MARK: - 5. Agent

/// 仕事の進行そのもの。chat bubble では出さない。
///
/// 「小さな floating utility」ではなく、デスクトップに現れる **AI task surface** に見せる。
/// そのために横幅を取り、各段に「いま何を見ているか」を 1 行添える。
struct AgentDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var store = GenieStateStore.shared
    @State private var tick = Date()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            taskTitle
            progressBar
            steps
            contextChips
            Spacer(minLength: 0)
            footer
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onReceive(timer) { tick = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockAgent")
    }

    /// 状態語。英語の rawValue をそのまま出していたので、面の中で言語が混ざっていた。
    private func statusLabel(_ s: AgentRunState) -> String {
        switch s {
        case .pending: return "待機中"
        case .running: return "作業中"
        case .success: return "完了"
        case .failed: return "止まりました"
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            GenieOrb(mode: store.state.activeTask?.status == .running ? .thinking : .idle,
                     size: Metrics.hudOrbCompactSize)
            Text("Genie")
                .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                .foregroundStyle(Palette.muted(dark))
            Spacer(minLength: 0)
            if let task = store.state.activeTask {
                // 何をしているか（状態語）と、どこまで進んだか。
                Text(statusLabel(task.status))
                    .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                    .foregroundStyle(Palette.muted(dark))
                // 待っている間、どれだけ待つのかが分かるように経過も出す。
                Text(elapsedLabel(task))
                    .font(.system(size: S.type(Metrics.dockMetaSize), design: .monospaced))
                    .foregroundStyle(Palette.muted(dark))
                Text("\(Int(task.progress * 100))%")
                    .font(.system(size: S.type(Metrics.dockMetaSize), design: .monospaced))
                    .foregroundStyle(Palette.muted(dark))
            }
        }
    }

    /// 進み具合は数字だけだと目に入らない。細い帯で出す。
    @ViewBuilder private var progressBar: some View {
        if let task = store.state.activeTask {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.subtleFill(dark, 0.10))
                    Capsule().fill(Palette.accent(dark))
                        .frame(width: max(2, geo.size.width * task.progress))
                }
            }
            .frame(height: 3)
            .animation(.easeOut(duration: Motion.drawerMs), value: task.progress)
            .accessibilityIdentifier("agentProgress")
            .accessibilityLabel("進み具合 \(Int(task.progress * 100))%")
        }
    }

    private func elapsedLabel(_ task: AgentTask) -> String {
        let t = Int(max(0, tick.timeIntervalSince(task.startedAt)))
        return String(format: "%02d:%02d", t / 60, t % 60)
    }

    /// 仕事の名前は状態語と分けて、1 行の見出しにする。
    private var taskTitle: some View {
        Text(store.state.activeTask?.title ?? "実行中")
            .font(.system(size: S.type(Metrics.dockTitleSize), weight: .semibold))
            .foregroundStyle(Palette.text(dark))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 段取り（PLAN）と、見ているもの（CONTEXT）を同じ型の見出しで分ける。
    /// 以前は段取りに見出しが無く、下の SOURCES だけが見出しを持っていて、
    /// 5 行の段取りが「見出しの無い表」に見えていた。
    private var steps: some View {
        VStack(alignment: .leading, spacing: 6) {
            DockLabel(text: Facts.dockPlan)
            VStack(alignment: .leading, spacing: 0) {
            ForEach(store.state.activeTask?.steps ?? []) { step in
                HStack(spacing: 10) {
                    Image(systemName: icon(step.state))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(tint(step.state))
                        .frame(width: 13)
                    Text(step.title)
                        .font(.system(size: S.type(Metrics.dockRowSize),
                                      weight: step.state == .running ? .semibold : .regular))
                        .foregroundStyle(step.state == .pending ? Palette.muted(dark) : Palette.text(dark))
                        .frame(width: 118, alignment: .leading)
                    // その段で実際に何を見ているか。空欄のままにしない。
                    Text(step.detail)
                        .font(.system(size: S.type(Metrics.dockMetaSize)))
                        .foregroundStyle(Palette.muted(dark))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .frame(height: Metrics.dockAgentRowHeight)
                .accessibilityIdentifier("step-\(step.tool)")
            }
            }
        }
    }

    /// 見ているもの。3 つの capsule（塗り + 線）で出していたが、ここで押せるものは
    /// 無いので、押せそうな形を与えない。語を「·」で並べる（⑨ 図形の重さ）。
    /// 名前は SOURCES から CONTEXT へ。結果の根拠（sources）ではなく、
    /// いま Genie が見ている文脈だから。
    @ViewBuilder private var contextChips: some View {
        let items = store.state.context.items
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                DockLabel(text: Facts.dockContext)
                Text(items.map(\.application).joined(separator: " · "))
                    .font(.system(size: S.type(Metrics.dockMetaSize)))
                    .foregroundStyle(Palette.text(dark))
                    .lineLimit(1)
            }
            .accessibilityIdentifier("agentContextChips")
        }
    }

    private var footer: some View {
        HStack(spacing: 0) {
            // 走っている仕事は止められること。止め方が無いまま待たせない。
            if store.state.activeTask?.status == .running {
                // 押せる範囲を label へ付ける。Button の外側に .frame を付けると
                // 当たりは文字のままで、実寸は 29x16 だった（隣の openWorkspace は
                // 178x28）。**止める操作がいちばん小さい**のは、あってはならない。
                StopButton(label: Facts.taskStop,
                           font: .system(size: S.type(Metrics.dockMetaSize), weight: .medium)) {
                    GenieStateStore.shared.finishTask(.failed)
                }
                .accessibilityIdentifier("stopAgent")
            }
            Spacer(minLength: 0)
            Button {
                MainWindowController.shared.show()
                GenieStateStore.shared.workspaceOpened()
            } label: {
                HStack(spacing: 5) {
                    Text(Facts.taskOpenWorkspace)
                    Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .semibold))
                }
                .font(.system(size: S.type(Metrics.dockMetaSize), weight: .medium))
                .foregroundStyle(Palette.accent(dark))
                .frame(height: 28).padding(.horizontal, 10)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
            .accessibilityIdentifier("openWorkspace")
        }
    }

    private func icon(_ s: AgentRunState) -> String {
        switch s {
        case .pending: return "circle"
        case .running: return "circle.fill"
        case .success: return "checkmark"
        case .failed: return "xmark"
        }
    }

    private func tint(_ s: AgentRunState) -> Color {
        switch s {
        case .pending: return Palette.muted(dark)
        case .running: return Palette.accent(dark)
        case .success: return Palette.success(dark)
        case .failed: return Palette.danger(dark)
        }
    }
}

// MARK: - 6. Confirmation

/// 確認は **Dock 自身が下へ伸びて**聞く。NSAlert も別窓も使わない。
/// 造形② 字面の階層は 3 案を伏せて採点し、C を採った。
/// 補助（宛先・出所のラベル）を値より一段弱くし、「外部に出る」を題の下の
/// **独立した段**へ出す。3 人とも visual_craft で C を 1 位に置いた。
/// 「C は背が高い」という証言は出たが、実寸は 3 枚とも 560x286 で同じ。
/// **面積は目で測らない**（`docs/ux-benchmark/auto/CRAFT.md`）。

struct ConfirmationDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    let confirmation: ActionConfirmation

    /// その場で直しているか。**別の窓は開かない。** 同じ面の中で入れ替える。
    @State private var editing = false
    @State private var edited: [String: String] = [:]

    private var riskTint: Color {
        confirmation.risk == .r3 ? Palette.danger(dark) : Palette.warning(dark)
    }



    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            // ① どのアプリ / どこへ。**一番上で「何が起きるか」の宛先が分かる。**
            HStack(spacing: 6) {
                if let app = confirmation.app {
                    if let icon = confirmation.appIcon {
                        Image(systemName: icon)
                            .font(.system(size: 11, weight: ActionConfirmation.Glyph.infoWeight))
                            .foregroundStyle(Palette.accent(dark))
                    }
                    Text(app)
                        .font(.system(size: S.type(Metrics.dockMetaSize), weight: .semibold))
                        .foregroundStyle(Palette.text(dark))
                }
                Spacer(minLength: 0)
            }

            // ② 何が起きるか。
            Text(editing ? Facts.confirmationEditTitle : confirmation.title)
                .font(.system(size: S.type(Metrics.dockTitleSize), weight: .semibold))
                .tracking(-0.2)
                .foregroundStyle(Palette.text(dark))
                .fixedSize(horizontal: false, vertical: true)

            // 「外部に出る」は宛先の並びでも題でもない。**独立した補助の段**にする。
            do {
                HStack(spacing: 5) {
                    Image(systemName: editing ? "arrow.uturn.backward" : "arrow.up.forward")
                        .font(.system(size: ActionConfirmation.Glyph.criticalSize,
                                      weight: ActionConfirmation.Glyph.criticalWeight))
                    Text(editing ? Facts.confirmationEditReturn : confirmation.risk.label)
                    Spacer(minLength: 0)
                }
                .font(.system(size: S.type(Metrics.dockLabelSize)))
                .foregroundStyle(riskTint)
            }

            if editing { editor } else { readOnly }

            Spacer(minLength: 0)

            // ⑥ 取消 / 直す / 実行。**主たる操作は 1 つだけ。**
            HStack(spacing: 8) {
                // 鍵は効いていても、書いていなければ無いのと同じ（Listening の esc と同じ理由、
                // journeys/panel1）。外へ出る面ほど、逃げ道と実行の鍵を先に見せる。
                if !editing {
                    // 語はボタンだけに置く。ここは鍵記号だけ（「やめる」がヒントとボタンで二重だった）。
                    // 破壊操作（r3）は鍵で実行させないので、実行の鍵ヒントも出さない。
                    HStack(spacing: 4) {
                        KeyBadge(UserShortcut.cancel.display)
                        if confirmation.risk != .r3 {
                            KeyBadge(UserShortcut.confirm.display).padding(.leading, 6)
                        }
                    }
                    .font(.system(size: S.type(Metrics.dockLabelSize)))
                    .foregroundStyle(Palette.muted(dark).opacity(0.72))
                }
                Spacer(minLength: 0)
                if editing {
                    Button(Facts.confirmationCancel) { editing = false; edited = [:] }
                        .font(.system(size: S.type(Metrics.dockRowSize)))
                        .foregroundStyle(Palette.muted(dark))
                        .frame(height: 32).padding(.horizontal, 14)
                        .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
                        .accessibilityIdentifier("confirmEditCancel")
                    Button(Facts.confirmationEditDone) { editing = false }
                        .font(.system(size: S.type(Metrics.dockRowSize), weight: .semibold))
                        .foregroundStyle(Palette.accent(dark))
                        .frame(height: 32).padding(.horizontal, 18)
                        .buttonStyle(GenieControlStyle(radius: 7, base: 0.05))
                        .accessibilityIdentifier("confirmEditDone")
                } else {
                    // 「キャンセル」は 5 字で 102pt になり、主たる操作（96）より広くなる
                    // （造形⑤、`scripts/ux-auto/primary.py`）。逃げ道は主より狭く保つ。
                    // 検査が押すのも同じ 1 本（`ProbeButton`）。
                    ProbeButton(id: "confirmCancel", action: { GenieStateStore.shared.resolveConfirmation(approved: false) }) {
                        Text(Facts.confirmationCancel)
                    }
                        .font(.system(size: S.type(Metrics.dockRowSize)))
                        .foregroundStyle(Palette.muted(dark))
                        .frame(height: 32).padding(.horizontal, 14)
                        .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
                    if confirmation.risk != .r3, !confirmation.params.isEmpty || confirmation.preview != nil {
                        // 検査から押せる目印付き（Atlas dock.confirmation-edit）。走るものは 1 本。
                        // 破壊（r3・捨てる等）は二択にする。「直す」は出さない。
                        ProbeButton(id: "confirmEdit", action: { editing = true }) { Text(Facts.confirmationEdit) }
                            .font(.system(size: S.type(Metrics.dockRowSize)))
                            // 「目を引くものは 1 つだけ」と考えて静かにしてみたが、
                            // 測ると control_visibility が 0-3 で落ちた。
                            // 取消（灰）・直す（強調）・実行（塗り）の 3 段があるほうが、
                            // それぞれの重さが読めるという指摘。強調色に戻す。
                            .foregroundStyle(Palette.accent(dark))
                            .frame(height: 32).padding(.horizontal, 14)
                            .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
                    }
                    // 外へ出る操作は、押す先が一目で分かる面にする。
                    //
                    // **主たる操作を、逃げ道より小さくしない。**
                    // 「送る」は 2 文字なので、padding だけ足しても 70pt にしかならず、
                    // 6 文字の Cancel（76pt）に負けていた（実測）。字数で重さが
                    // 決まってしまうので、最小幅で下から支える。
                    ProbeButton(id: "confirmProceed", action: { GenieStateStore.shared.resolveConfirmation(approved: true, edits: edited) }) {
                        Text(confirmation.confirmLabel)
                    }
                        .font(.system(size: S.type(Metrics.dockRowSize), weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(height: 32).padding(.horizontal, 20)
                        .frame(minWidth: S.metric(Metrics.dockConfirmPrimaryMinWidth))
                        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(riskTint))
                        .buttonStyle(GenieControlStyle(radius: 7, base: 0.0, filled: false))
                }
            }
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Escape は取消。直している最中なら、直すのをやめて確認へ戻る。
        // **逃げ道は常に同じ鍵**でないと、危ないときに手が止まる。
        .escapeKey {
            if editing { editing = false; edited = [:] }
            else { GenieStateStore.shared.resolveConfirmation(approved: false) }
        }
        // Return では実行しない。**押し慣れた鍵で外へ出る操作が走るのは危ない。**
        // 実行は ⌘Return だけ。**さらに破壊（r3・元に戻せない）は鍵で実行させない**（既定は安全側=やめる）。
        .background(
            Group {
                if confirmation.risk != .r3 {
                    Button("") { GenieStateStore.shared.resolveConfirmation(approved: true) }
                        .keyboardShortcut(UserShortcut.confirm.key, modifiers: UserShortcut.confirm.modifiers)
                        .opacity(0)
                        .accessibilityHidden(true)
                }
            }
        )
    }

    /// ③ 決定的な値 ④ 中身の下見 ⑤ 出所。
    @ViewBuilder private var readOnly: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(confirmation.params, id: \.self) { p in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(p.label)
                        .font(.system(size: S.type(Metrics.dockLabelSize)))
                        .foregroundStyle(Palette.muted(dark).opacity(0.72))
                        .frame(width: 56, alignment: .leading)
                    Text(edited[p.label] ?? p.value)
                        .font(.system(size: S.type(Metrics.dockRowSize)))
                        .foregroundStyle(Palette.text(dark))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            if let preview = edited["__preview"] ?? confirmation.preview {
                let body = Text(preview)
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .lineSpacing(3)
                    .foregroundStyle(Palette.muted(dark))
                // 収まるなら流さない。ScrollView を置くだけで摘みが出て、
                // 1 行の下見の右肩に**動かせそうな灰色の棒**が残る。
                // 長いときだけ**ここだけ**流す。面ごと大きくしない。
                if confirmation.previewOverflows {
                    ScrollView {
                        body
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: confirmation.previewHeight())
                    .accessibilityIdentifier("confirmPreview")
                } else {
                    body
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("confirmPreview")
                }
            }
            ForEach(confirmation.details, id: \.self) { d in
                Text(d)
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.muted(dark))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let src = confirmation.source {
                // ⑤ AI が作ったものなら、どこから来たかを出す。
                Button {
                    MainWindowController.shared.showLibrary(.meetings)
                } label: {
                    HStack(spacing: 5) {
                        Text(Facts.sourceLabel).foregroundStyle(Palette.muted(dark))
                        Text([src.title, src.speaker, src.time].compactMap { $0 }.joined(separator: " · "))
                            .foregroundStyle(Palette.text(dark))
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(Palette.accent(dark))
                        Spacer(minLength: 0)
                    }
                    .font(.system(size: S.type(Metrics.dockLabelSize)))
                    .opacity(0.8)
                }
                .buttonStyle(GenieControlStyle(radius: 6, base: 0.0))
                // 出所は値でも本文でもない。**一段離す。**
                // 穴を埋めた拍子にここが 4pt まで潰れ、本文と地続きに見えていた。
                .padding(.top, 5)
                .accessibilityIdentifier("confirmSource")
            }
        }
    }

    /// その場で直す。**別の窓を開かない。**
    @ViewBuilder private var editor: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(confirmation.params.filter { $0.editable }, id: \.self) { p in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(p.label)
                        .font(.system(size: S.type(Metrics.dockLabelSize)))
                        .foregroundStyle(Palette.muted(dark))
                        .frame(width: 56, alignment: .leading)
                    TextField(p.value, text: Binding(
                        get: { edited[p.label] ?? p.value },
                        set: { edited[p.label] = $0 }))
                        .textFieldStyle(.plain)
                        .font(.system(size: S.type(Metrics.dockRowSize)))
                        .padding(.horizontal, 7).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.subtleFill(dark, 0.05)))
                }
            }
            if let preview = confirmation.preview {
                TextField(preview, text: Binding(
                    get: { edited["__preview"] ?? preview },
                    set: { edited["__preview"] = $0 }), axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(3)
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .padding(7)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.subtleFill(dark, 0.05)))
                    .accessibilityIdentifier("confirmPreviewEdit")
            }
        }
    }
}

// MARK: - 7. Meeting

/// 録音中の Dock。**これが録音 UI の本体**（別窓を 3 枚出さない）。
///
/// SuperIntern の control bar の考え方を Dock に吸収した。録音を始めた時点では
/// controller だけが出て、Notes / Captions / Ask は押されたときにこの面の中身として開く。
/// 両方同時に見たいときだけ、明示的に大きな面へ detach する。
/// 録音中の Dock。上段はいつも同じ高さのコントローラ、下段は開いた 1 枚だけ。
/// `DockContentMeasure` が `.notes` の高さを測るので `private` にしない。
struct MeetingDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var store = GenieStateStore.shared
    @ObservedObject private var recording = RecordingWorkspaceState.shared
    @ObservedObject private var secret = SecretMode.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let open: DockPresentation.MeetingPanel?
    /// 開く板だけを、面が伸び終わってから出す（見出しは消さない）。
    @State private var bodyVisible = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            controller
            if let open {
                Group {
                    Divider().overlay(Palette.border(dark))
                    MeetingPanelBody(panel: open)
                        .padding(.horizontal, S.metric(Metrics.dockPadH))
                        .padding(.vertical, S.metric(Metrics.dockPadV))
                }
                .opacity(bodyVisible || reduceMotion ? 1 : 0)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: bodyVisible)
                Spacer(minLength: 0)
            }
        }
        .onAppear { if open != nil { revealBody() } }
        .onChange(of: open) { _, new in
            if new == nil { bodyVisible = false } else { revealBody() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockMeeting")
    }

    /// 面のリサイズが終わる少し後に板を出す（全体 fade と同じ間合い。§Animation 40–70ms）。
    private func revealBody() {
        if reduceMotion { bodyVisible = true; return }
        bodyVisible = false
        DispatchQueue.main.asyncAfter(deadline: .now() + Motion.dockResizeMs + Motion.dockContentDelayMs) {
            bodyVisible = true
        }
    }

    private var controller: some View {
        HStack(spacing: 12) {
            // 取り込みが生きるまでは赤くしない。赤い点は「録れている」の意味なので、
            // 最初の IO バッファが来る前に点けると、その間に話した頭が落ちたことに気づけない。
            Circle().fill(recording.isPaused || recording.awaitingAudio ? Color.secondary : Color.recordingRed)
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                // **実際に 1 サンプル入るまでは「準備中…」。**タイマーではなく
                // 最初の音声フレームの到着（`awaitingAudio`）で切り替える。
                // 一時停止中は見出しでもそう言う（点が灰になるだけでは、止まっていると分からなかった）。
                Text(recording.isPaused ? Facts.recordingHeroPaused
                     : recording.awaitingAudio ? Facts.recordingHeroPreparing
                     : (store.state.meeting.detectedApp ?? Facts.recordingHeroRecording))
                    .font(.system(size: S.type(Metrics.dockPrimarySize), weight: .semibold))
                    .foregroundStyle(Palette.text(dark))
                    .lineLimit(1)
                Text(recording.elapsedText)
                    .font(.system(size: S.type(Metrics.dockMetaSize), design: .monospaced))
                    .foregroundStyle(Palette.muted(dark))
            }
            // 状態を造形でも分ける: 準備中=波形を出さない / 一時停止=平坦 / 録音中=実振幅。
            if !recording.awaitingAudio {
                Waveform(levels: recording.isPaused ? [] : recording.audioLevels, awaitingInput: false)
                    .frame(width: 56, height: 16)
                    .opacity(recording.isPaused ? 0.5 : 1)
            }
            Spacer(minLength: 0)
            ForEach(DockPresentation.MeetingPanel.allCases, id: \.self) { panel in
                Button { VoiceHUDState.shared.toggleMeetingPanel(panel) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: panel.icon).font(.system(size: 13))
                        Text(panel.title).font(.system(size: S.type(Metrics.dockRowSize), weight: .medium))
                    }
                    .foregroundStyle(open == panel ? Palette.accent(dark) : Palette.muted(dark))
                    .frame(height: 30).padding(.horizontal, 10)
                }
                .buttonStyle(GenieControlStyle(radius: 8, base: open == panel ? 0.07 : 0.0))
                .accessibilityIdentifier("meetingPanel-\(panel.rawValue)")
            }
            // ここから先はアイコンだけのモード/操作。板タブ（ラベル付き）と種類が違うので仕切る。
            Divider().frame(height: 18).padding(.horizontal, 2)
            // シークレット: 画面共有・録画に Genie を映さない。会議中こそ要る。
            Button { SecretMode.shared.toggle() } label: {
                Image(systemName: secret.isOn ? "eye.slash.fill" : "eye")
                    .font(.system(size: 12))
                    .foregroundStyle(secret.isOn ? Palette.accent(dark) : Palette.muted(dark))
                    .frame(width: 32, height: 30)
            }
            .buttonStyle(GenieControlStyle(radius: 8, base: secret.isOn ? 0.07 : 0.0))
            .help(secret.isOn ? "画面共有に映りません" : "画面共有に映ります")
            .accessibilityIdentifier("secretToggle")
            // 一時停止 / 再開。手は録音面の pill にしか無く、Dock からは止められなかった（Atlas meeting.paused）。
            ProbeButton(id: "pauseRecording", action: { recording.togglePause() }) {
                Image(systemName: recording.isPaused ? "play.fill" : "pause.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(recording.isPaused ? Palette.accent(dark) : Palette.muted(dark))
                    .frame(width: 32, height: 30)
            }
            .buttonStyle(GenieControlStyle(radius: 8, base: recording.isPaused ? 0.07 : 0.0))
            .help(recording.isPaused ? Facts.recordingResume : Facts.recordingPause)
            .accessibilityLabel(recording.isPaused ? Facts.recordingResume : Facts.recordingPause)
            StopRecordingButton { WindowCoordinator.shared.toggleRecording() }
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .frame(height: Metrics.dockMeetingHeight)
    }
}

private struct MeetingPanelBody: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var store = GenieStateStore.shared
    @ObservedObject private var recording = RecordingWorkspaceState.shared
    let panel: DockPresentation.MeetingPanel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                // captions は controller のタブ名（字幕）と重複するのでパネル見出しを出さない。
                if panel != .captions {
                    DockLabel(text: panel == .notes ? Facts.meetingNotesPanelTitle : panel.title)
                }
                Spacer(minLength: 0)
                // 両方同時に見たいときだけ、大きな面へ出す（既定では出さない）。
                Button { WindowCoordinator.shared.detachMeetingSurface() } label: {
                    HStack(spacing: 4) {
                        Text(Facts.meetingDetach)
                        Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .semibold))
                    }
                    .font(.system(size: S.type(Metrics.dockLabelSize), weight: .medium))
                    .foregroundStyle(Palette.muted(dark))
                    .frame(height: 26).padding(.horizontal, 8)
                }
                .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
                .accessibilityIdentifier("detachMeeting")
            }
            content
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meetingPanelBody")
    }

    /// 字幕・文字起こしがまだ空のとき。翻訳タブの「まだ訳すものがありません。」と同じ姿。
    private var captionsEmptyLine: some View {
        VStack(alignment: .leading, spacing: 8) {
            if RecordingRuntime.shared.transcriptionUnavailable {
                // 黙って空にしない。理由と、直しに行く道（Atlas system.stt-unavailable）。
                Label(RecordingRuntime.shared.transcriptionFailureMessage, systemImage: "text.badge.xmark")
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.danger(dark))
                ProbeButton(id: "openDictationSettings", action: {
                    if RecordingRuntime.shared.liveTranscriptionFailure != nil { RecordingRuntime.shared.retryLiveTranscription() }
                    else { Permissions.openDictationSettings() }
                }) {
                    Text(RecordingRuntime.shared.liveTranscriptionFailure != nil
                         ? Facts.liveRetry : "\(Facts.resultOpenSettings)（音声入力）")
                }
                .font(.system(size: S.type(Metrics.dockRowSize), weight: .medium))
                .foregroundStyle(Palette.accent(dark))
                .frame(height: 30).padding(.horizontal, 10)
                .buttonStyle(GenieControlStyle(radius: 8, base: 0.0))
            } else {
                Text(Facts.captionsEmpty)
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.muted(dark))
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch panel {
        case .captions:
            // 切替は Dock の中に置く。以前は大きな面へ detach しないと
            // 翻訳へ行けなかった（既定の経路から到達できない機能になっていた）。
            VStack(alignment: .leading, spacing: 10) {
                RecordingToolPalette(selection: Binding(
                    get: { recording.selectedTool },
                    set: recording.selectTool))
                if RecordingRuntime.shared.liveTranscriptionFailure != nil { captionsEmptyLine }
                if recording.selectedTool == .translation {
                    MeetingTranslationView(model: recording.translation, compact: true)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 9) {
                            // 空のまま黙らない。メモ（`.notes`）・翻訳と同じ 1 行を出す。
                            if recording.transcript.isEmpty && RecordingRuntime.shared.liveTranscriptionFailure == nil { captionsEmptyLine }
                            ForEach(recording.transcript.suffix(8)) { line in
                                captionLine(speaker: line.speaker, at: line.timeLabel, text: line.text, interim: line.interim)
                            }
                        }
                    }
                    .scrollIndicators(.never)
                }
            }
        case .notes:
            let canvas = store.state.meeting.canvas
            if canvas.isEmpty {
                Text("聞きながら、決まったこと・やること・懸念をここに書いていきます。")
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.muted(dark))
            } else {
                // 高さは中身で決まる（`DockContentMeasure`）。上限 460 に当たってからだけ scroll。
                // 4 件のメモに 460pt の面を出すと、面の 6 割が空だった。
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        notesGroup(Facts.notesDecisions, canvas.decisions)
                        notesGroup(Facts.notesConcerns, canvas.concerns)
                        notesGroup(Facts.notesActions, canvas.actions)
                        notesGroup(Facts.notesQuestions, canvas.questions)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollIndicators(.never)
            }
        case .ask:
            AskInDockField()
        }
    }

    private func captionLine(speaker: String, at: String, text: String, interim: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(speaker)
                    .font(.system(size: S.type(Metrics.dockMetaSize), weight: .semibold))
                    .foregroundStyle(Palette.accent(dark))
                Text(at)   // 話者 · 時刻。どこで言われたかが分かると、後から音に戻れる。
                    .font(.system(size: S.type(Metrics.dockMetaSize), design: .monospaced))
                    .foregroundStyle(Palette.muted(dark))
            }
            Text(text)
                .font(.system(size: S.type(Metrics.dockRowSize)))
                .foregroundStyle(interim ? Palette.muted(dark) : Palette.text(dark))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func notesGroup(_ title: String, _ lines: [CanvasItem]) -> some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.system(size: S.type(Metrics.dockMetaSize), weight: .semibold))
                    .foregroundStyle(Palette.muted(dark))
                ForEach(lines) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let t = line.timeLabel {
                            Text(t)
                                .font(.system(size: S.type(Metrics.dockMetaSize), design: .monospaced))
                                .foregroundStyle(Palette.muted(dark))
                        } else {
                            Text("•").foregroundStyle(Palette.muted(dark))
                        }
                        // 出所は「いつ・誰が」。Library と同じ 2 つを、ここでも落とさない
                        // （時刻だけだと、Library で初めて話者が現れ、同じ発言と分からない）。
                        if let who = line.speaker, !who.isEmpty {
                            Text(who)
                                .font(.system(size: S.type(Metrics.dockMetaSize), weight: .semibold))
                                .foregroundStyle(Palette.muted(dark))
                        }
                        Text(line.text)
                            .font(.system(size: S.type(Metrics.dockRowSize)))
                            .foregroundStyle(Palette.text(dark))
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }
}

/// 会議中に、その場で聞く。
private struct AskInDockField: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @State private var question = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").font(.system(size: 12))
                    .foregroundStyle(Palette.accent(dark))
                TextField("この会議について聞く", text: $question)
                    .textFieldStyle(.plain)
                    .font(.system(size: S.type(Metrics.dockPrimarySize)))
                    .foregroundStyle(Palette.text(dark))
                    .focused($focused)
                    .onSubmit(ask)
                    .accessibilityIdentifier("askInDock")
            }
            .padding(.horizontal, 14)
            .frame(height: 42)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.subtleFill(dark, 0.04))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(focused ? Palette.accent(dark) : Color.hairline(dark),
                                lineWidth: focused ? Metrics.focusRing : 1)))
            if !RecordingWorkspaceState.shared.aiResult.isEmpty {
                Text(RecordingWorkspaceState.shared.aiResult)
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.text(dark))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                // 空欄 + 巨大な余白にしない。左寄せの compact な候補行で「何を聞けるか」を示す
                // （pill を 4 つ並べる AI 製品の見た目は避ける）。
                VStack(alignment: .leading, spacing: 7) {
                    Text("よく聞くこと")
                        .font(.system(size: S.type(Metrics.dockMetaSize), weight: .semibold))
                        .foregroundStyle(Palette.muted(dark))
                    ForEach(["決まったことは？", "私のやることは？", "反対意見や懸念は？"], id: \.self) { q in
                        Button { question = q; ask() } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "arrow.turn.down.right")
                                    .font(.system(size: 11)).foregroundStyle(Palette.muted(dark))
                                Text(q)
                                    .font(.system(size: S.type(Metrics.dockRowSize)))
                                    .foregroundStyle(Palette.text(dark))
                                Spacer(minLength: 0)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("askSuggestion-\(q)")
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    private func ask() {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        question = ""
        RecordingWorkspaceState.shared.runAIAction(text)
    }
}

// MARK: - 結果（CleanShot 型: 終わっても消さず、後始末を出して残す）

struct ResultDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var sessions = MeetingSessionStore.shared
    let result: AgentResult

    /// 直近の会議の状態を 1 行で。processing の間は spinner だけにしない。
    private var sessionLine: String {
        if let d = result.detail { return d }
        guard let s = sessions.recent.first(where: { $0.title == result.title }) else {
            if let n = result.sourceCount, n > 0 { return "\(n) 件のソースから作成しました" }
            return "できました"
        }
        switch s.status {
        case .processing: return "要約とやることを作っています…"
        case .ready:
            // 語は Notes と同じ（やること / 決まったこと）。面ごとに言い換えない。
            return "\(Facts.notesActions) \(s.actionCount) · \(Facts.notesDecisions) \(s.decisionCount) · \(s.participantCount) 人"
        case .interrupted: return Facts.sessionInterrupted
        case .failed: return "失敗しました"
        case .recording: return Facts.recordingHeroRecording
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                // できなかった結果に ✓ を付けない。
                Image(systemName: result.failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(result.failed ? Palette.warning(dark) : Palette.success(dark))
                VStack(alignment: .leading, spacing: 1) {
                    Text(result.title)
                        .font(.system(size: S.type(Metrics.dockTitleSize), weight: .semibold))
                        .foregroundStyle(Palette.text(dark))
                        .lineLimit(1)
                    // Session の状態をそのまま出す。読み取り中は「何をしているか」を言う。
                    Text(sessionLine)
                        .font(.system(size: S.type(Metrics.dockMetaSize)))
                        // 失敗の理由は補足ではなく本文。灰にすると題より読めない（盲検 3/3）。
                        .foregroundStyle(result.failed ? Palette.text(dark) : Palette.muted(dark))
                }
                Spacer(minLength: 0)
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                ForEach(result.actions, id: \.self) { action in
                    ProbeButton(id: "result-\(action.rawValue)",
                                action: { ResultActionRunner.run(action, title: result.title, sessionId: result.sessionId) }) {
                        Text(action.title)
                    }
                        .font(.system(size: S.type(Metrics.dockRowSize), weight: .medium))
                        .foregroundStyle(Palette.text(dark))
                        .frame(height: 32).padding(.horizontal, 16)
                        .buttonStyle(GenieControlStyle(radius: 8, base: 0.07))
                }
                Spacer(minLength: 0)
                Button { GenieStateStore.shared.dismissResult() } label: {
                    Image(systemName: "xmark").font(.system(size: 11))
                        .foregroundStyle(Palette.muted(dark))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(GenieControlStyle(radius: 8, base: 0.0))
                .accessibilityIdentifier("resultDismiss")
            }
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // 済んだ面も同じ鍵で閉じる。
        .escapeKey { GenieStateStore.shared.dismissResult() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockResult")
    }


}

// MARK: - 文脈の棚（Dropover 型: 棚そのものが詳細へ展開する）

struct ContextDetailDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var store = GenieStateStore.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                DockLabel(text: Facts.dockContext)
                Spacer(minLength: 0)
                Text("Genie が見ているもの \(store.state.context.items.count) 件")
                    .font(.system(size: S.type(Metrics.dockMetaSize)))
                    .foregroundStyle(Palette.muted(dark))
                Button { VoiceHUDState.shared.mode = .idle } label: {
                    Image(systemName: "chevron.up").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Palette.muted(dark))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
                .accessibilityIdentifier("contextCollapse")
            }
            if store.state.context.items.isEmpty {
                Text("いま見えている文脈はありません。")
                    .font(.system(size: S.type(Metrics.dockRowSize)))
                    .foregroundStyle(Palette.muted(dark))
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
                    ForEach(store.state.context.items) { item in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item.application)
                                .font(.system(size: S.type(Metrics.dockRowSize), weight: .semibold))
                                .foregroundStyle(Palette.text(dark))
                                .lineLimit(1)
                            Text(item.summary)
                                .font(.system(size: S.type(Metrics.dockMetaSize)))
                                .foregroundStyle(Palette.muted(dark))
                                .lineLimit(2)
                            Spacer(minLength: 0)
                            Text(item.source.label)
                                .font(.system(size: S.type(Metrics.dockLabelSize)))
                                .foregroundStyle(Palette.muted(dark))
                        }
                        .padding(12)
                        .frame(height: 104, alignment: .topLeading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color.subtleFill(dark, 0.04))
                                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .stroke(Color.hairline(dark))))
                        .accessibilityIdentifier("contextCard-\(item.application)")
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, S.metric(Metrics.dockPadH))
        .padding(.vertical, S.metric(Metrics.dockPadV))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockContextDetail")
    }
}

// MARK: - Quick actions

struct QuickActionsDock: View {
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    @ObservedObject private var state = VoiceHUDState.shared

    private struct Item: Identifiable {
        let id = UUID()
        let icon: String
        let title: String
        let run: () -> Void
    }

    private var items: [Item] {
        var actions = [
            Item(icon: "sparkles", title: "聞く") { state.beginListening() },
            Item(icon: "record.circle", title: Facts.dockRecord) { WindowCoordinator.shared.toggleRecording() },
            Item(icon: "square.grid.2x2", title: Facts.resultOpen) { MainWindowController.shared.show() },
        ]
        if let summary = AppContextResolver.current(), !summary.suggestions.isEmpty {
            actions.append(Item(icon: "rectangle.inset.filled", title: Facts.dockRelated) { state.mode = .appContextExpanded(summary) })
        }
        return actions
    }

    var body: some View {
        HStack(spacing: 4) {
            ForEach(items) { item in
                Button(action: item.run) {
                    HStack(spacing: 6) {
                        Image(systemName: item.icon).font(.system(size: 14))
                        Text(item.title).font(.system(size: S.type(Metrics.dockRowSize)))
                    }
                    .foregroundStyle(Palette.text(dark))
                    .frame(maxWidth: .infinity)
                    .frame(height: 36)
                }
                .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
                .accessibilityIdentifier("quick-\(item.title)")
            }
        }
        .padding(.horizontal, 8)
        .frame(maxHeight: .infinity)
        // クイック操作が作業領域に重なるときは、Escape で一手で静かな Dock に戻す。
        // ボタンを増やして閉じる専用の面を作らず、Genie 全体の逃げ道の鍵に揃える。
        .escapeKey { state.mode = .idle }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dockQuickActions")
    }
}
