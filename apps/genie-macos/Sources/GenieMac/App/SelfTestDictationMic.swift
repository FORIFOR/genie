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
        var log: [String] = ["前面=\(front0)"]
        // --dockkey: Dock を押して Quick Actions から始めたときのように、Dock がキーの状態から始める。
        if args.contains("--dockkey") {
            hud.toggleQuickActions()
            WindowCoordinator.shared.focusListeningDock()
            await pause(0.3)
            log.append("始める前の Dock のキー=\(WindowCoordinator.shared.isListeningDockKey)")
        }
        hud.beginDictation()
        await pause(0.3)
        var partials: [String] = []
        let key = WindowCoordinator.shared.isListeningDockKey
        // 音声入力の最中に、system-wide で「フォーカス中の欄」がどこを指しているか（自分の欄なら入れられない）。
        let targetDuring = Dictation.focusedTextTarget(excludingOwnProcess: true) != nil
        log.append("聞く面=\(hud.mode) Dockがkey=\(key) 入れる欄あり=\(targetDuring)")
        await pause(1.0)
        // --text <文>: 認識の代わりに、言い終えた文として渡す（入れる・整える・戻すは本番と同じ）。
        if let k = args.firstIndex(of: "--text"), args.count > k + 1 {
            _ = hud.speak(args[k + 1])
            partials.append(args[k + 1])
        } else if !inject {
            let play = Process(); play.executableURL = URL(fileURLWithPath: "/usr/bin/afplay"); play.arguments = [file]
            try? play.run()
        }
        let deadline = Date().addingTimeInterval(25)
        var lastMode = "\(hud.mode)"
        while Date() < deadline {
            await pause(0.1)
            if case .listening(let p) = hud.mode, !p.isEmpty, partials.last != p { partials.append(p) }
            let m = "\(hud.mode)"
            if m != lastMode { log.append("面→\(m.prefix(40))"); lastMode = m }
            if dictated != nil { break }
            if case .listening = hud.mode {} else if !partials.isEmpty { await pause(1.0); break }
        }
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
        let summary = (log + ["途中=\(partials.last ?? "なし")", "入れた文=\(dictated ?? (real ? "（実際に打ち込み）" : "なし"))",
                              "答え=\(hud.answer.prefix(60))"]).joined(separator: " | ")
        // 実際に打ち込んだときは、欄が見つからない等の答えが出ていないこと（欄の中身は外の検査が読む）。
        let ok = real ? (!partials.isEmpty && hud.answer.isEmpty) : (dictated?.isEmpty == false)
        print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " dictationmic: " + summary)
        exit(ok ? 0 : 2)
    }
}
