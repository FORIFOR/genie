import AppKit

/// `--selftest dictationmic <audio> [--real]`: 音声入力を本番と同じ入口で始め、実マイクで聞き、
/// 前面のアプリの欄へ入るまでを見る。`--real` が無ければ打ち込まず、入れようとした文だけを書く。
/// 前面には検査用の欄だけのアプリを置く（本人のアプリへは打ち込まない）。
extension SelfTest {
    @MainActor
    static func dictationMic(_ args: [String]) async {
        NSApp.setActivationPolicy(.accessory)
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 2 else { print("SELFTEST_FAIL dictationmic: usage <audio> [--real]"); exit(2) }
        let file = args[i + 2]
        let real = args.contains("--real")
        // --inject: スピーカーを鳴らさず、同じ認識器へ音声を流し込む（マイクから先はすべて本番）。
        let inject = args.contains("--inject")
        if inject {
            guard let frames = loadMono16k(file), !frames.isEmpty else { print("SELFTEST_FAIL dictationmic: cannot read \(file)"); exit(2) }
            RecordingRuntime.shared.voiceInjection = frames
        }
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        var dictated: String?
        if !real { Dictation.dryRun = { dictated = $0; return true } }
        let hud = VoiceHUDState.shared
        WindowCoordinator.shared.showVoiceHUD()
        await pause(1.0)
        let front0 = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
        // 実際に打ち込むときは、前面が検査用のアプリであることを確かめてから（本人のアプリへ打ち込まない）。
        // 2026-09-28、検査用アプリが起動せず、本人のターミナルへ打ち込んでしまった。
        if real {
            let expected = args.firstIndex(of: "--expect-front").flatMap { args.count > $0 + 1 ? args[$0 + 1] : nil }
            let frontExec = NSWorkspace.shared.frontmostApplication?.executableURL?.lastPathComponent ?? ""
            guard let expected, frontExec == expected || front0 == expected else {
                print("SELFTEST_FAIL dictationmic: 前面が検査用のアプリではない（前面=\(front0) / \(frontExec)）。打ち込まずに止めた。--real には --expect-front <検査用アプリ> が要る")
                exit(2)
            }
        }
        var log: [String] = ["前面=\(front0)"]
        if Dictation.lastOtherAppPID == nil { Dictation.trackFrontApps() }
        // --dockkey: Dock を押して Quick Actions から始めたときのように、Dock がキーの状態から始める。
        if args.contains("--dockkey") {
            hud.toggleQuickActions()
            WindowCoordinator.shared.focusListeningDock()
            await pause(0.3)
            log.append("始める前の Dock のキー=\(WindowCoordinator.shared.isListeningDockKey)")
        }
        // --genie-front: Genie の窓を前面にしてから始める（入れる先は、直前に見ていたアプリ）。
        if args.contains("--genie-front") {
            MainWindowController.shared.showSection(.home)
            NSApp.activate(ignoringOtherApps: true)
            await pause(0.8)
            log.append("始める時の前面=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?")")
        }
        hud.beginDictation()
        await pause(0.3)
        var partials: [String] = []
        let key = WindowCoordinator.shared.isListeningDockKey
        // 音声入力の最中に、system-wide で「フォーカス中の欄」がどこを指しているか（自分の欄なら入れられない）。
        let targetDuring = Dictation.focusedTextTarget(excludingOwnProcess: true) != nil
        log.append("聞く面=\(hud.mode) Dockがkey=\(key) 入れる欄あり=\(targetDuring)")
        await pause(1.0)
        // --text <文>: 認識の代わりに、区切りの文として渡す（入れる・整える・戻すは本番と同じ）。
        /// 実際に打つ・押す前に毎回、前面がまだ検査用のアプリか確かめる（途中で本人が別のアプリへ移ることがある。
        /// 2026-09-28、途中で Chrome が前面になり、送信の Return が Chrome に届いた）。
        func stillFixture() -> Bool {
            guard real else { return true }
            let expected = args.firstIndex(of: "--expect-front").flatMap { args.count > $0 + 1 ? args[$0 + 1] : nil } ?? ""
            let front = NSWorkspace.shared.frontmostApplication
            return front?.executableURL?.lastPathComponent == expected || front?.localizedName == expected
        }
        func abortIfMoved(_ step: String) {
            guard !stillFixture() else { return }
            hud.cancelListening()
            print("SELFTEST_FAIL dictationmic: \(step)の前に前面が検査用のアプリから変わった（\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?")）。打たずに止めた")
            exit(2)
        }
        if let k = args.firstIndex(of: "--text"), args.count > k + 1 {
            for sentence in args[k + 1].components(separatedBy: "|") {
                abortIfMoved("入れる")
                hud.dictateSegment(sentence)
                partials.append(sentence)
                await pause(0.6)
            }
        } else if !inject {
            let play = Process(); play.executableURL = URL(fileURLWithPath: "/usr/bin/afplay"); play.arguments = [file]
            try? play.run()
        }
        // 続けて聞く: 区切りごとの結果を集める。音が終わって 4 秒、新しい結果が無ければ終わり。
        var statuses: [String] = []
        var lastChange = Date()
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline {
            await pause(0.1)
            if case .listening(let p) = hud.mode, !p.isEmpty, partials.last != p { partials.append(p); lastChange = Date() }
            abortIfMoved("聞いている間")
            if let st = hud.dictationStatus, statuses.count < hud.dictatedSegments || statuses.last != st {
                statuses.append(st); lastChange = Date()
            }
            if !statuses.isEmpty, Date().timeIntervalSince(lastChange) > 4 { break }
        }
        let stillListening: Bool = { if case .listening = hud.mode { return true }; return false }()
        log.append("区切りの結果=\(statuses) 入れた区切り=\(hud.dictatedSegments)")
        log.append("入れた後も聞いている=\(stillListening)")
        Dictation.dryRun = nil
        // --restore: 「元の文に戻す」を押す（整えて入れた時だけ出る）。
        if args.contains("--restore") {
            await pause(0.5)
            if case .dictated(let notice) = hud.mode {
                log.append("整えた=「\(notice.inserted)」元=「\(notice.original)」")
                hud.restoreDictated(notice)
                await pause(0.5)
                log.append("戻した後の面=\("\(hud.mode)".prefix(30))")
            } else {
                log.append("戻す面が出ていない(\(hud.mode))")
            }
        }
        // --send [未確定の文]: 送信ボタン（入れた先で Return）。未確定の文があれば入れてから押す。
        if let k = args.firstIndex(of: "--send") {
            let pending = args.count > k + 1 && !args[k + 1].hasPrefix("--") ? args[k + 1] : ""
            abortIfMoved("送信")
            hud.sendDictation(pending: pending)
            await pause(0.8)
            log.append("送信後の面=\("\(hud.mode)".prefix(30))")
        }
        // やめる（Esc）とマイクが閉じる。
        let micBefore = processIsRunningInput()
        hud.cancelListening()
        await pause(1.5)
        let micAfter = processIsRunningInput()
        log.append("Esc 前のマイク=\(micBefore.map(String.init) ?? "?") 後=\(micAfter.map(String.init) ?? "?")")
        let summary = (log + ["途中=\(partials.last ?? "なし")", "入れた文=\(dictated ?? (real ? "（実際に打ち込み）" : "なし"))",
                              "答え=\(hud.answer.prefix(60))"]).joined(separator: " | ")
        // 実際に打ち込んだときは、欄が見つからない等の答えが出ていないこと（欄の中身は外の検査が読む）。
        let expected = args.firstIndex(of: "--segments").flatMap { args.count > $0 + 1 ? Int(args[$0 + 1]) : nil } ?? 1
        let inserted = hud.dictatedSegments
        let sent = args.contains("--send") ? hud.mode == .idle : true
        let ok = (real ? inserted >= expected && stillListening && sent : (dictated?.isEmpty == false)) && micAfter == false
        print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " dictationmic: " + summary)
        exit(ok ? 0 : 2)
    }
}
