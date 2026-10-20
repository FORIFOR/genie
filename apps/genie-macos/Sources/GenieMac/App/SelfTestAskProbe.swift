import AppKit

extension SelfTest {
    /// `--selftest askprobe <文>`: 会話を通さずに ask() へ渡し、受け付けたか・断った理由を出す。
    @MainActor static func askProbe(_ args: [String]) async {
        setvbuf(stdout, nil, _IONBF, 0)
        NSApp.setActivationPolicy(.accessory)
        let text = args.last ?? ""
        _ = LocalStore.shared.open()   // 本番のアプリは起動時に開く（検査の実行では開かれていない）
        MainData.shared.load()
        for _ in 0..<60 where !MainData.shared.connected { try? await Task.sleep(nanoseconds: 250_000_000) }
        let hud = VoiceHUDState.shared
        print("connected=\(MainData.shared.connected) inFlight=\(hud.requestInFlight)")
        let ok = hud.ask(text)
        print("ask=\(ok) answer=\(hud.answer) held=\(hud.heldUtterance ?? "-")")
        // ASKPROBE_WAIT 秒まで、答えが落ち着くのを待って最後の答えを出す（既定は 3 秒で受付だけ見る）
        let wait = Double(ProcessInfo.processInfo.environment["ASKPROBE_WAIT"] ?? "") ?? 3
        let until = Date().addingTimeInterval(wait)
        var last = ""
        var stableSince = Date()
        while Date() < until {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if hud.answer != last { last = hud.answer; stableSince = Date() }
            if !hud.requestInFlight, hud.followingRequests.isEmpty, !last.isEmpty, Date().timeIntervalSince(stableSince) > 3 { break }
        }
        print("final answer=\(hud.answer.replacingOccurrences(of: "\n", with: " ").prefix(400))")
        print("SELFTEST_OK askprobe")
        exit(0)
    }
}
