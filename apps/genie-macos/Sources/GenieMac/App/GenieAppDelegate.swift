import AppKit

final class GenieAppDelegate: NSObject, NSApplicationDelegate {
    private var permissionRefreshObserver: NSObjectProtocol?
    private var terminationSignal: DispatchSourceSignal?
    private var terminationRequested = false
    private var externallyTerminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        ApplicationMenu.shared.install()
        // headless の自己検証（Swift → core → ディスク）。UI を出さずに終了する。
        if SelfTest.run(CommandLine.arguments) { return }
        // §9 Chrome の Native Messaging host として起動されたとき。UI は出さない。
        if CommandLine.arguments.contains("--native-messaging") {
            LocalStore.shared.open()
            NativeMessagingHost.runLoop()
            NSApp.terminate(nil)
            return
        }
        // Managed preview shutdown sends SIGTERM. Route it through the same owned-child
        // cleanup as Quit; an external termination request cannot wait for a UI answer.
        // A caught no-op resets to SIG_DFL on exec; SIG_IGN would leak into the CLI.
        signal(SIGTERM, { _ in })
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { [weak self] in
            TerminationDispatch.perform {
                self?.externallyTerminating = true
                NSApp.terminate(nil)
            }
        }
        termination.resume()
        terminationSignal = termination
        // §24 ローカル保存を開く。§23 走っていた task を読み戻す。
        LocalStore.shared.open()
        GenieStateStore.shared.restoreRunningTask()
        // §9 前回の会議を読み戻す。録音中のまま落ちていたものは interrupted になる。
        MeetingSessionStore.shared.load()
        let demo = DemoMode.fromArguments(CommandLine.arguments)
        WindowCoordinator.shared.start(demo: demo)
        // Dock アイコンが無いので、ここが起動後の唯一の入口になる（Main/録音/設定/終了）。
        StatusBarController.shared.install()
        // Prepare live transcription even when recording starts directly from the Dock.
        Task { @MainActor in MainData.shared.load() }

        // Speech authorization is often granted in System Settings while the
        // recording workspace remains alive.  The authorization callback is
        // not delivered for that manual Settings change, so refresh the live
        // session whenever Genie becomes active again.  Without this, a
        // recording that started before approval keeps an empty transcript
        // until the user stops and starts a new recording.
        permissionRefreshObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                MainData.shared.load()
                RecordingRuntime.shared.speechAuthorizationChanged()
                RecordingWorkspaceState.shared.refreshSpeechPermission()
            }
        }
        // focus リングは Tab / 矢印を押してから見せる（開いた瞬間に出さない）。
        KeyboardNavigation.shared.install()
        // 自動更新。配布先と公開鍵が Info.plist に入っていなければ何もしない
        // （確かめているつもりで何も見ていない状態を作らない）。
        SoftwareUpdate.shared.startIfConfigured()
        // 音声入力の入れる先: Genie の窓が前面でも、直前に見ていたアプリの欄へ入れるため。
        Dictation.trackFrontApps()
        // 前面アプリが変わったら、まだ繋がっていないものを 1 度だけ勧める（§14）。
        // 勧誘は Dock の下の別 Panel に出す（Dock 本体は伸ばさない）。
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                VoiceHUDState.shared.refreshContextualApp()
                // §6 Presence: 前面アプリを State と EventBus に流す。
                let app = NSWorkspace.shared.frontmostApplication
                GenieEventBus.shared.publish(.appChanged(
                    bundleId: app?.bundleIdentifier, name: app?.localizedName ?? "?"))
                // §7/§8 文脈を取り直す（取れたものだけ）。
                if let ax = AccessibilityContext.snapshot() {
                    GenieStateStore.shared.updateContext([ax.fact()])
                }
                // §18 会議アプリの検出。**録音は始めない。**
                MeetingDetector.refresh()
            }
        }
        // スクショを撮った瞬間、それを直近の会話コンテキストとして自動で持つ（保存先 + クリップボード監視）。
        ScreenshotDetectionService.shared.start()
        MeetingRecordingReminder.shared.start()
        // §22 画面共有が始まったら Genie を出さない。
        PresentationGuard.shared.start()
        // グローバル音声ショートカット（⌥Space）で録音を出し入れする。
        // CGEventTap（正本指定）で受信する。Accessibility 権限を使う（§3 と共用）。
        if !GlobalShortcut.shared.register(handler: { WindowCoordinator.shared.toggleRecording() }) {
            // **ここでは求めない。** 起動した瞬間にダイアログを出すと、まだ何も
            // 使っていない人に判断を迫ることになる。⌥Space を案内している場所
            // （Home の空状態）で、押されたときに求める。
            // 許可が無いこと自体は状態として持ち、画面がそれを見る。
            NSLog("astra: ⌥Space を登録できない（入力監視の許可が要る）")
        }
        // マイクが許可済みなら engine だけ先に用意する（IO は始めない・求めない）。
        // ⌥Space から音が届くまでを短くする（INVOCATION gate の実測）。
        RecordingRuntime.shared.prewarmMic()
        // 前回落ちたまま残っている録音があれば知らせる（§3 meeting recovery）。
        let recoverable = RecordingRuntime.shared.recoverableMeetings()
        if !recoverable.isEmpty {
            NSLog("astra: %d recoverable recording(s) found; will offer recovery once signed in", recoverable.count)
            RecoveryState.shared.pending = recoverable
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainWindowController.shared.showSection(.home)
        return true
    }

    /// 録音中の終了は会議を失う操作。黙って落とさず一度だけ聞く。
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationRequested else { return .terminateLater }
        if RecordingWorkspaceState.shared.isRecording {
            // §16 R3: 進行中の会議を失いうる、元に戻せない操作。
            let go = externallyTerminating || Confirm.ask(ActionConfirmation(
                title: "録音を止めて Genie を終了します",
                details: ["ここまでの音声はディスクに残ります",
                          "次の起動で続きから復元できます"],
                risk: .r3,
                confirmLabel: "録音を止めて終了"))
            guard go else { return .terminateCancel }
            RecordingWorkspaceState.shared.stop()
        }
        terminationRequested = true
        RecordingWorkspaceState.shared.translation.reset()
        TerminationDispatch.afterCleanup({
            await CodexTranslation.shutdown()
        }, reply: {
            sender.reply(toApplicationShouldTerminate: true)
        })
        return .terminateLater
    }
}
