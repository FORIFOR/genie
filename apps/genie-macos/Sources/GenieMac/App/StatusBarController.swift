import AppKit

/// メニューバーの Genie。**起動後にアプリへ触れる唯一の入口**。
///
/// Genie は Dock アイコンを持たない overlay（`.accessory`）なので、これが無いと
/// 起動後に Main Window も設定も終了も開けない（実機で確認した実際の行き止まり）。
/// macOS の常道どおり status item を置き、Home/録音/設定/終了をここから辿れるようにする。
@MainActor
final class StatusBarController {
    static let shared = StatusBarController()
    private var item: NSStatusItem?

    func install() {
        guard item == nil else { return }
        let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = status.button {
            // Genie の印（ランプ）。template なのでメニューバーの明暗に合わせて色が変わる。
            button.image = GenieBrandMark.image(height: 13)
            button.setAccessibilityLabel("Genie")
            button.toolTip = "Genie"
        }
        status.menu = buildMenu()
        item = status
    }

    /// 録音中かどうかで文言が変わるので、開くたびに作り直す。
    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = MenuRefresher.shared
        rebuild(menu)
        return menu
    }

    fileprivate func rebuild(_ menu: NSMenu) {
        menu.removeAllItems()

        // 設定が ⌘, 終了が ⌘Q を持つのに、いちばん開くものに割り当てが無かった。
        let open = NSMenuItem(title: Facts.menuOpen, action: #selector(openMain), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        // 常駐パネルは作業を止めずに隠せる。表示状態に応じて同じ場所の
        // 項目を切り替えるので、「隠したあと、どこから戻すか」が変わらない。
        let controlsTitle = WindowCoordinator.shared.isVoiceHUDVisible
            ? Facts.menuHideControls
            : Facts.menuShowControls
        let controls = NSMenuItem(title: controlsTitle, action: #selector(toggleControls), keyEquivalent: "")
        controls.target = self
        menu.addItem(controls)
        let recording = WindowCoordinator.shared.isRecording
        let rec = NSMenuItem(
            title: recording ? Facts.recordingMenuStop : Facts.recordingMenuStart,
            action: #selector(toggleRecording),
            keyEquivalent: ""
        )
        rec.target = self
        menu.addItem(rec)
        let wake = NSMenuItem(title: Facts.menuWakeWord, action: #selector(toggleWakeWord), keyEquivalent: "")
        wake.target = self
        wake.state = WakeController.shared.enabled ? .on : .off
        menu.addItem(wake)
        let tryWake = NSMenuItem(title: Facts.menuTryWake, action: #selector(tryWakeWord), keyEquivalent: "")
        tryWake.target = self
        menu.addItem(tryWake)
        let enroll = NSMenuItem(title: Facts.menuWakeEnroll, action: #selector(enrollWakeWord), keyEquivalent: "")
        enroll.target = self
        enroll.isEnabled = !WakeEnrollment.shared.running
        menu.addItem(enroll)

        menu.addItem(.separator())

        // ショートカットは覚えていないと使えないので、ここに書いておく。
        // 実装は録音の開始 / 停止（長押しではない）。言っていることと違う案内は置かない。
        let hint = NSMenuItem(title: "\(Facts.settingsShortcutRow): \(GlobalShortcut.label())", action: nil, keyEquivalent: "")
        hint.isEnabled = false
        menu.addItem(hint)

        let settings = NSMenuItem(title: Facts.menuSettings, action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        // 操作ガイドは GitHub Releases の対応するプレビュー版の PDF。アプリに同梱しないので
        // 常に公開中の最新版が開く。オフラインではブラウザが失敗を出す（偽の面は出さない）。
        let guide = NSMenuItem(title: Facts.menuGuide, action: #selector(openGuide), keyEquivalent: "")
        guide.target = self
        menu.addItem(guide)

        // Guided Setup。権限は変えず、右下のアバターが System Settings の対象を案内する。
        let guided = NSMenuItem(title: Facts.menuGuidedSetup, action: #selector(startGuidedSetup), keyEquivalent: "")
        guided.target = self
        menu.addItem(guided)

        // 自動更新は起動時に黙って見るだけだった（SoftwareUpdate.checkNow() に導線が無い、宣言だけの口）。
        // 確認できない実行体では灰色にせず、押したら理由と配布ページへの一手を出す。
        let update = NSMenuItem(title: Facts.menuCheckUpdates, action: #selector(checkUpdates), keyEquivalent: "")
        update.target = self
        menu.addItem(update)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: Facts.menuQuit, action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    /// メニューの項目（題とショートカット）。導線の検査から読む。
    /// status item を出せない環境でも読めるよう、作り直して返す。
    func menuItemTitles() -> [(title: String, key: String)] {
        menuSnapshot().filter { !$0.separator }.map { ($0.title, $0.key) }
    }

    /// 区切りと押せるかも含めた写し。操作ガイド（docs/guide/build.py）がメニューの絵を
    /// ここから描く——手で写した絵は 0.1.1 で実物とずれた（「音声入力 … 長押し」のまま）。
    func menuSnapshot() -> [(title: String, key: String, separator: Bool, enabled: Bool)] {
        buildMenu().items.map { ($0.title, $0.keyEquivalent, $0.isSeparatorItem, $0.isEnabled) }
    }

    /// 押せる項目に action と target が付いているか（題だけ在って何も起きない項目を作らない）。
    func menuWiring() -> [(title: String, wired: Bool)] {
        buildMenu().items.filter { !$0.isSeparatorItem && $0.isEnabled }
            .map { ($0.title, $0.action != nil && $0.target != nil) }
    }

    @objc func toggleWakeWord() {
        WakeController.shared.enabled.toggle()
    }
    @objc func tryWakeWord() { WakeController.shared.simulateWake() }
    @objc func enrollWakeWord() { Task { _ = await WakeEnrollment.shared.record() } }

    @objc private func openMain() { MainWindowController.shared.showSection(.home) }
    @objc private func toggleControls() {
        if WindowCoordinator.shared.isVoiceHUDVisible {
            WindowCoordinator.shared.hideVoiceHUD()
        } else {
            WindowCoordinator.shared.restoreControls()
        }
    }
    @objc private func toggleRecording() { WindowCoordinator.shared.toggleRecording() }
    @objc private func openSettings() { SettingsWindowController.shared.show() }
    @objc private func openGuide() { NSWorkspace.shared.open(Self.guideURL) }
    @objc private func startGuidedSetup() { SettingsWindowController.shared.show() }
    @objc private func checkUpdates() {
        guard let reason = SoftwareUpdate.shared.checkNow() else { return }
        Self.presentUpdateUnavailable(reason: reason)
    }

    /// 更新を確かめられない理由を出す。メニューと検査（Atlas system.update-unavailable）が同じ面を通る。
    static func presentUpdateUnavailable(reason: String) {
        let alert = NSAlert()
        alert.messageText = Facts.updateUnavailableTitle
        // 利用者の言葉で、事実といまの版、次の一手だけ。内向きの理由（SUFeedURL 等）は画面に出さず log へ
        // （4 行が同じ見た目で並ぶと、どれが理由でどれが状態か切り分けられない、盲検 2/2）。
        let version = SoftwareUpdate.currentVersion ?? "不明"
        NSLog("update unavailable: \(reason)")
        alert.informativeText = "この版は \(version) です。新しい版は配布ページで確かめられます。"
        alert.addButton(withTitle: Facts.updateOpenReleases)
        alert.addButton(withTitle: Facts.updateClose)
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(Self.releasesURL) }
    }

    /// 配布ページ（RELEASE.md §2.6）。更新を確認できない実行体からの次の一手。
    static let releasesURL = URL(string: "https://github.com/FORIFOR/genie/releases/latest")!

    /// RELEASE.md §2.6 の「一般利用者へ案内する固定 URL」。版ごとの PDF は Releases の各版に別名で残る。
    static let guideURL = URL(string: "https://github.com/FORIFOR/genie/releases/download/v0.1.3/Genie-guide-ja.pdf")!
    @objc private func quit() { NSApp.terminate(nil) }
}

/// メニューを開く直前に作り直す（録音中の文言を合わせる）。
@MainActor
private final class MenuRefresher: NSObject, NSMenuDelegate {
    static let shared = MenuRefresher()
    func menuNeedsUpdate(_ menu: NSMenu) {
        StatusBarController.shared.rebuild(menu)
    }
}
