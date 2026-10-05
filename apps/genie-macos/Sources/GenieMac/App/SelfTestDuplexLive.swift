import AppKit

extension SelfTest {
    /// `--selftest duplexlive`: 本物の Gemini Live（本人のキー・数十秒）で、Genie が話している間もマイクを送り続けたとき、
    /// 自分の声（エコー除去の残り）で割り込まれずに最後まで話せるか。足跡の interrupted を数える。
    @MainActor static func duplexLive() async {
        setvbuf(stdout, nil, _IONBF, 0)
        NSApp.setActivationPolicy(.accessory)
        let settings = GeminiLiveSettings.shared
        await settings.refreshKeyPresence()
        guard let key = settings.apiKey() else { print("SELFTEST_SKIP duplexlive: no key"); exit(0) }
        let provider = GeminiLiveProvider(apiKey: key, settings: settings, delegate: { _ in "accepted" },
                                          onLost: { print("lost: \($0)") }, input: VoiceInputHub())
        provider.greetWhenReady = true
        provider.openingPrompt = "東京の観光名所を3つ、それぞれ一文ずつ紹介してください。"
        let hud = VoiceHUDState.shared
        hud.startConversation(using: provider)
        print("duplex: \(provider.capabilities.bargeIn)")
        try? await Task.sleep(nanoseconds: 25_000_000_000)
        let events = provider.trace.map(\.1)
        hud.endConversation(.user)
        let interrupts = events.filter { $0 == "interrupted" }.count
        print("trace: \(events)")
        print((interrupts == 0 && events.contains("turn-complete") ? "SELFTEST_OK" : "SELFTEST_FAIL") + " duplexlive: interrupts=\(interrupts)")
        exit(0)
    }
}
