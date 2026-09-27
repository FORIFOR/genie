import AppKit
import SwiftUI

/// Genie UI の中心。通常は Voice OS ピル、録音中は Recording Workspace。
/// 上↔下はフェードで切り替える（黒いバーが画面中央を横切らないように、移動アニメはしない）。
@MainActor
final class WindowCoordinator {
    static let shared = WindowCoordinator()

    /// テスト用: window を実際に出さずに状態遷移だけ回す（本番は false のまま）。
    static var headless = false

    private var hudPanel: GeniePanel<VoiceTaskDockView>?
    private let dockLayout = DockScreenLayout()
    var dockTopInset: CGFloat { dockLayout.topInset }
    private var screenObserver: NSObjectProtocol?

    private init() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.dockScreen = nil
                self?.pendingScreen = nil
                self?.syncDockPanels()
            }
        }
    }
    private var recordingPanel: GeniePanel<RecordingWorkspaceView>?
    private var screenshotOfferTimer: Timer?
    private var screenshotOfferWasHidden = false

    /// A capture replaces passive navigation with the existing offer, without taking focus.
    /// Never replace recording controls, running work, sharing, or a permission guide.
    func offerScreenshot() {
        guard (Self.headless || hudPanel != nil), !PresentationGuard.shared.isSharing,
              !RecordingWorkspaceState.shared.isRecording, !VoiceHUDState.shared.requestInFlight,
              GenieStateStore.shared.state.activeTask?.status != .running,
              PermissionGuideCoordinator.shared.state == .idle || PermissionGuideCoordinator.shared.state.isTerminal,
              VisualContextStore.shared.offeredCapture != nil else { return }
        switch VoiceHUDState.shared.mode {
        case .idle, .quickActions, .appContext:
            // The offer is rendered by IdleDock. Keeping Quick Actions visible hid
            // a successfully detected capture until the user happened to press Esc.
            VoiceHUDState.shared.mode = .idle
        default: return
        }
        guard !Self.headless else { return }
        screenshotOfferWasHidden = screenshotOfferWasHidden || !isVoiceHUDVisible
        screenshotOfferTimer?.invalidate()
        if !isVoiceHUDVisible { showVoiceHUD() }
        guard screenshotOfferWasHidden else { return }
        screenshotOfferTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.endScreenshotOffer() }
        }
    }

    func endScreenshotOffer() {
        screenshotOfferTimer?.invalidate(); screenshotOfferTimer = nil
        if screenshotOfferWasHidden, VoiceHUDState.shared.mode == .idle { hideVoiceHUD() }
        screenshotOfferWasHidden = false
    }
    /// Dock を置く画面。切り替えは 500ms 安定してから（画面間でバタつかせない）。
    private var dockScreen: NSScreen?
    private var pendingScreen: (screen: NSScreen, since: Date)?
    /// グローバルショートカットが録音を出し入れするための状態。
    private(set) var isRecording = false

    func start(demo: DemoMode) {
        switch demo {
        case .none:
            VoiceHUDState.shared.mode = .idle
            showVoiceHUD()
        case .hudListening:
            VoiceHUDState.shared.mode = .listening(partial: "")
            showVoiceHUD()
        case .hudThinking:
            VoiceHUDState.shared.mode = .thinking
            showVoiceHUD()
        case .recording:
            RecordingWorkspaceState.shared.loadDemo(ragOpen: false)
            showRecordingWorkspace()
        case .recordingRAG:
            RecordingWorkspaceState.shared.loadDemo(ragOpen: true)
            showRecordingWorkspace()
        case .startRecording:
            // 実アプリと同じ状態から、ボタンが呼ぶのと同じものを呼ぶ。
            VoiceHUDState.shared.mode = .idle
            showVoiceHUD()
            MainWindowController.shared.show()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                RecordingWorkspaceState.shared.start()
            }
        case .main:
            // Dock は常駐。Main を開いていても上端から消えない
            // （--demo main で Dock が出ず、実機で「Dock が無い」状態になっていた）。
            VoiceHUDState.shared.mode = .idle
            showVoiceHUD()
            MainWindowController.shared.show()
        case .settings:
            VoiceHUDState.shared.mode = .idle
            showVoiceHUD()
            SettingsWindowController.shared.show()
        }
    }

    /// window 専用: Recording Workspace を出して HUD を退ける。録音ランタイムの開始は
    /// RecordingWorkspaceState.start() が持つ（ここから start を呼ぶと相互再帰になるので呼ばない）。
    func enterRecordingMode() {
        isRecording = true
        hideVoiceHUD()
        showRecordingWorkspace()
    }

    /// 「両方同時に見たい」と言われたときだけ、大きな面を出す。既定では出さない。
    func detachMeetingSurface() {
        if Self.headless { return }
        showRecordingWorkspace()
    }

    func leaveRecordingMode() {
        isRecording = false
        hideRecordingWorkspace()
        showVoiceHUD()
    }

    /// グローバル音声ショートカットの入口。押すたびに録音を出し入れする。
    /// 正本 §2「通常時 Top HUD → 録音開始で Recording Workspace → 終了で HUD 復帰」。
    func toggleRecording() {
        // 録音の単一エントリは RecordingWorkspaceState。start/stop がランタイムと window の両方を回す。
        if RecordingWorkspaceState.shared.isRecording {
            RecordingWorkspaceState.shared.stop()
        } else {
            RecordingWorkspaceState.shared.start()
        }
    }

    func showVoiceHUD() {
        if Self.headless { return }
        guard let screen = activeScreen() else { return }
        dockLayout.topInset = max(0, screen.safeAreaInsets.top)
        if hudPanel == nil {
            // 確認や入力を受けるので key になれる必要がある（ただし他アプリを非活性にしない）。
            hudPanel = GeniePanel(
                size: GenieStateStore.shared.dock.size(),
                level: .statusBar,
                canKey: true,
                content: VoiceTaskDockView(screenLayout: dockLayout)
            )
        }
        guard let panel = hudPanel else { return }
        panel.setFrame(
            PanelPositioner.voiceHUDFrame(screen: screen, size: GenieStateStore.shared.dock.size()),
            display: false)
        Elevation.apply(to: panel, .attached)
        fadeIn(panel, makeKey: false)
    }

    /// Home explicitly opens a tool: keyboard input must follow that action.
    /// Passive Dock updates still use showVoiceHUD without taking focus.
    func openMeetingPanelFromHome(_ requested: DockPresentation.MeetingPanel) {
        VoiceHUDState.shared.toggleMeetingPanel(requested)
        guard !Self.headless, !PresentationGuard.shared.isSharing,
              case .meeting(let expanded) = VoiceHUDState.shared.mode, expanded != nil,
              let panel = hudPanel, panel.isVisible else { return }
        panel.makeKeyAndOrderFront(nil)
    }

    /// 検査専用: Dock の窓（キー入力を受けられるかを確かめる）。
    var hudPanelForTest: NSWindow? { hudPanel }

    /// Listening 面を開いたとき、直接キーボード入力できるよう Dock にキー入力を渡す。
    func focusListeningDock() {
        guard !Self.headless, !PresentationGuard.shared.isSharing,
              let panel = hudPanel, panel.isVisible else { return }
        panel.makeKeyAndOrderFront(nil)
    }

    /// Listening 面の Dock がキー入力を受けているか（`focusListeningDock` が効いたか）。
    /// 受けているなら、話しかけた相手は前面アプリの欄ではなく Dock の入力欄。
    var isListeningDockKey: Bool {
        guard !Self.headless, let panel = hudPanel else { return false }
        return panel.isVisible && panel.isKeyWindow
    }

    func restoreControls() {
        screenshotOfferTimer?.invalidate(); screenshotOfferTimer = nil
        screenshotOfferWasHidden = false
        if RecordingWorkspaceState.shared.isRecording {
            VoiceHUDState.shared.mode = .meeting(expanded: nil)
        } else { VoiceHUDState.shared.mode = .idle }
        // An explicit user action restores the controls, including Stop.
        showVoiceHUD()
    }

    func hideVoiceHUD() {
        if Self.headless { return }
        guard let panel = hudPanel else { return }
        fadeOut(panel)
    }

    /// Dock が画面に出ているか。確認を Dock 1 面で済ませられるかの判断に使う。
    var isVoiceHUDVisible: Bool { hudPanel?.isVisible == true }

    /// Dock が鍵（キー入力）を受け取る窓か。鍵は key の窓にしか届かない（検査が実キーを送る前に確かめる）。
    var isVoiceHUDKey: Bool { hudPanel?.isKeyWindow == true }

    /// Dock の大きさを状態に合わせる。**窓は増やさない**。
    ///
    /// 上辺の Y を固定したまま高さだけ変える。中央から上下へ広がると、
    /// メニューバーの上にはみ出したり、画面の縁から離れたりして一体感が壊れる。
    func syncDockPanels() {
        if Self.headless { return }
        guard let panel = hudPanel, let screen = activeScreen() else { return }
        let inset = max(0, screen.safeAreaInsets.top)
        let screenInsetChanged = dockLayout.topInset != inset
        dockLayout.topInset = inset
        let target = PanelPositioner.voiceHUDFrame(
            screen: screen,
            size: GenieStateStore.shared.dock.size(
                agentRows: GenieStateStore.shared.state.activeTask?.steps.count ?? 0))
        // Dock は画面の縁から生えている。大きさが変わっても浮かない。
        Elevation.apply(to: panel, .attached)
        guard panel.frame != target else { return }
        // Reduce Motion のときは一気に。そうでなければ 180ms で。
        if screenInsetChanged || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            panel.setFrame(target, display: true)
            panel.invalidateShadow()
        } else {
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = Motion.dockResizeMs
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(target, display: true)
            }, completionHandler: {
                // 形が変わったら影も計算し直す（古い形の影が残る）。
                panel.invalidateShadow()
            })
        }
    }

    /// Dock を置く画面。使っているアプリの窓がある画面へ移すが、跨いだ瞬間には動かさない。
    ///
    /// 画面を跨ぐたびに Dock が飛ぶと、上端の静けさが壊れる。500ms 同じ画面に居続けたときだけ移す。
    func activeScreen(now: Date = Date()) -> NSScreen? {
        let candidate = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) }
            ?? NSScreen.main
        guard let candidate else { return dockScreen }
        if dockScreen == nil { dockScreen = candidate; return candidate }
        if candidate == dockScreen { pendingScreen = nil; return candidate }
        if let pending = pendingScreen, pending.screen == candidate {
            if now.timeIntervalSince(pending.since) >= 0.5 {
                dockScreen = candidate
                pendingScreen = nil
                return candidate
            }
        } else {
            pendingScreen = (candidate, now)
        }
        return dockScreen
    }

    func showRecordingWorkspace() {
        if Self.headless { return }
        if recordingPanel == nil {
            recordingPanel = GeniePanel(
                size: NSSize(width: Metrics.workspaceWidth, height: Metrics.workspaceHeight),
                level: .floating,
                canKey: true,
                content: RecordingWorkspaceView()
            )
        }
        guard let panel = recordingPanel, let screen = NSScreen.main else { return }
        panel.setFrame(PanelPositioner.recordingWorkspaceFrame(screen: screen), display: false)
        fadeIn(panel, makeKey: true)
    }

    func hideRecordingWorkspace() {
        if Self.headless { return }
        guard let panel = recordingPanel else { return }
        fadeOut(panel)
    }

    private func fadeIn(_ panel: NSPanel, makeKey: Bool) {
        panel.alphaValue = 0
        if makeKey {
            panel.makeKeyAndOrderFront(nil)
        } else {
            panel.orderFrontRegardless()
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Motion.showMs
            panel.animator().alphaValue = 1
        }
    }

    private func fadeOut(_ panel: NSPanel) {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = Motion.hideMs
            panel.animator().alphaValue = 0
        }, completionHandler: {
            panel.orderOut(nil)
            panel.alphaValue = 1
        })
    }
}
