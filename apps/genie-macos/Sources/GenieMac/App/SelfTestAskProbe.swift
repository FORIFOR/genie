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
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        print("SELFTEST_OK askprobe")
        exit(0)
    }
}
