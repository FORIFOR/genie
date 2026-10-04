import AppKit

/// `--selftest wakehandoff`（`GENIE_GEMINI_FAKE` / `GENIE_GEMINI_FAKE_LOG`、偽の相手は `server.mjs <port> <log> wake`）:
/// 呼びかけの検出から Gemini Live の会話への引き継ぎ。本物の API もキーもマイクも使わない。
///
/// 1. 「ジーニー、ブラウザを開いて」: 検出の前・検出・接続を待つ間・つながった後の声が、この順で欠けずに届く
/// 2. 「呼びかけを試す」（呼びかけの声が無い）: つながったら挨拶を促し（clientContent）、返事の声が流れる
extension SelfTest {
    @MainActor
    static func wakeHandoff() async {
        NSApp.setActivationPolicy(.accessory)
        let env = ProcessInfo.processInfo.environment
        guard let fake = env["GENIE_GEMINI_FAKE"].flatMap(URL.init(string:)), let logPath = env["GENIE_GEMINI_FAKE_LOG"] else {
            print("SELFTEST_FAIL wakehandoff: GENIE_GEMINI_FAKE / GENIE_GEMINI_FAKE_LOG が無い"); exit(2)
        }
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        func events() -> [[String: Any]] {
            (try? String(contentsOfFile: logPath, encoding: .utf8))?.split(separator: "\n").compactMap {
                (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
            } ?? []
        }
        final class Marker: WakeDetector {
            func process(_ frame: [Float]) -> Bool { abs(frame[0] - 0.2) < 0.001 }
            func reset() {}
        }
        func frame(_ v: Float) -> [Float] { Array(repeating: v, count: 1600) }
        let suite = "genie.selftest.wake.\(getpid())"
        let settings = GeminiLiveSettings(defaults: UserDefaults(suiteName: suite)!, initialHasKey: false)
        settings.setMonthlyMinutes(5)
        let hud = VoiceHUDState.shared
        WindowCoordinator.shared.showVoiceHUD()

        // 1. 続けて頼む
        let hub = VoiceInputHub(mic: nil)
        try? hub.startStandby(detector: Marker()) {}
        hub.inject(frame(0.1)); hub.inject(frame(0.2)); hub.inject(frame(0.3))
        guard let first = GeminiLiveProvider.forLocalFake(url: fake, settings: settings, delegate: { _ in "accepted" },
                                                          onLost: { _ in }, input: hub) else { print("SELFTEST_FAIL wakehandoff: fake url"); exit(2) }
        hud.startConversation(using: first)
        await pause(1.5)
        hub.inject(frame(0.4))
        await pause(0.8)
        let order = events().filter { $0["event"] as? String == "audio" && $0["conn"] as? Int == 1 }
            .compactMap { $0["first"] as? Int }.map { (Double($0) / 32767 * 10).rounded() / 10 }
        hud.endConversation(.user)
        await pause(0.5)
        let backToStandby = hub.state == .standby

        // 2. 呼びかけを試す
        let hub2 = VoiceInputHub(mic: nil)
        hub2.simulateWake()
        guard let second = GeminiLiveProvider.forLocalFake(url: fake, settings: settings, delegate: { _ in "accepted" },
                                                           onLost: { _ in }, input: hub2) else { exit(2) }
        second.greetWhenReady = true
        hud.startConversation(using: second)
        await pause(2.0)
        let greeted = events().contains { $0["event"] as? String == "clientContent" && $0["conn"] as? Int == 2 }
        let played = second.trace.contains { $0.1 == "playback-start" }
        hud.endConversation(.user)
        UserDefaults().removePersistentDomain(forName: suite)

        let orderOK = Array(order.prefix(4)) == [0.1, 0.2, 0.3, 0.4]
        let ok = orderOK && backToStandby && greeted && played
        print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " wakehandoff: order=\(order.prefix(6)) standbyAfter=\(backToStandby) greetPrompted=\(greeted) greetingPlayed=\(played)")
        exit(ok ? 0 : 2)
    }
}
