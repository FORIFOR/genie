import AppKit

/// `--selftest geminiresume`（`GENIE_GEMINI_FAKE=ws://127.0.0.1:<port>` と `GENIE_GEMINI_FAKE_LOG=<path>`）:
/// 偽の Gemini（`tools/gemini-fake/server.mjs`）に、本番と同じ会話の流れ（ConversationLoop + GeminiLiveProvider）でつなぐ。
/// 本物の API もキーも使わない（課金なし）。実マイクの音は偽の相手へ送る（偽の相手は数えるだけ）。
///
/// 確かめること:
/// 1. 答えの声を、turnComplete を待たずに流し始める（ためない）。
/// 2. interrupted で、流している声と待ちの声を捨てる。
/// 3. goAway の後、再開の鍵で同じ会話へつなぎ直し（setup に鍵）、会話が続く（終わらない）。
/// 4. setup に 3.8 で送ってはいけない設定が無い。
extension SelfTest {
    @MainActor
    static func geminiResume() async {
        NSApp.setActivationPolicy(.accessory)
        let env = ProcessInfo.processInfo.environment
        guard let fake = env["GENIE_GEMINI_FAKE"].flatMap(URL.init(string:)), let logPath = env["GENIE_GEMINI_FAKE_LOG"] else {
            print("SELFTEST_FAIL geminiresume: GENIE_GEMINI_FAKE / GENIE_GEMINI_FAKE_LOG が無い"); exit(2)
        }
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP geminiresume: マイクの許可が無い"); exit(0) }
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }

        // 本人の設定・今月の使用量に触れない。
        let suite = "genie.selftest.gemini.\(getpid())"
        let settings = GeminiLiveSettings(defaults: UserDefaults(suiteName: suite)!, initialHasKey: false)
        settings.setMonthlyMinutes(5)
        var lost: String?
        guard let provider = GeminiLiveProvider.forLocalFake(url: fake, settings: settings,
                                                             delegate: { _ in "accepted" }, onLost: { lost = $0 }) else {
            print("SELFTEST_FAIL geminiresume: 偽の Gemini はこの Mac の中（127.0.0.1）にしか置けない（\(fake)）"); exit(2)
        }
        let hud = VoiceHUDState.shared
        WindowCoordinator.shared.showVoiceHUD()
        hud.startConversation(using: provider)

        // 偽の相手の台本が終わる（接続 2 で答える）まで待つ。最大 40 秒。
        func serverEvents() -> [[String: Any]] {
            (try? String(contentsOfFile: logPath, encoding: .utf8))?.split(separator: "\n").compactMap {
                (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
            } ?? []
        }
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline {
            await pause(0.5)
            if serverEvents().contains(where: { $0["event"] as? String == "turn" && $0["kind"] as? String == "after-resume" }) { break }
            if lost != nil { break }
        }
        await pause(1.5)
        let events = serverEvents()
        let active = hud.conversation.isActive
        hud.endConversation(.user)
        UserDefaults().removePersistentDomain(forName: suite)

        func at(_ event: String, conn: Int = 1, turn: Int? = nil) -> Double? {
            events.first { $0["event"] as? String == event && $0["conn"] as? Int == conn && (turn == nil || $0["turn"] as? Int == turn) }
                .flatMap { $0["t"] as? Double }.map { $0 / 1000 }
        }
        let trace = provider.trace
        let firstPlayback = trace.first { $0.1 == "playback-start" }?.0.timeIntervalSince1970
        let turn1Complete = at("turnComplete", turn: 1)
        let cleared = trace.contains { $0.1.hasPrefix("playback-cleared") }
        let resumed = trace.contains { $0.1.hasPrefix("resume-") }
        let setups = events.filter { $0["event"] as? String == "setup" }
        let secondHandle = setups.count >= 2 ? setups[1]["handle"] as? String : nil
        let firstSetup = (setups.first?["setup"] as? [String: Any]).map { GeminiLive.json($0) } ?? ""
        let forbidden = ["thinkingConfig", "enableAffectiveDialog", "proactivity", "languageCode"].filter { firstSetup.contains($0) }
        let afterResume = events.contains { $0["event"] as? String == "turn" && $0["kind"] as? String == "after-resume" }

        let streamedEarly = (firstPlayback != nil && turn1Complete != nil) ? firstPlayback! < turn1Complete! : false
        let lead = (firstPlayback != nil && turn1Complete != nil) ? turn1Complete! - firstPlayback! : 0
        let report = "流し始め→turnComplete=\(String(format: "%.2f", lead))秒前 割り込みで捨てた=\(cleared) つなぎ直し=\(resumed) 2つ目のsetupの鍵=\(secondHandle ?? "なし") 再開後も会話=\(afterResume) 会話中=\(active) 失った=\(lost ?? "なし") 禁止設定=\(forbidden) 足跡=\(trace.map(\.1))"
        let ok = streamedEarly && cleared && resumed && secondHandle == "h1" && afterResume && lost == nil && forbidden.isEmpty
        print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " geminiresume: " + report)
        exit(ok ? 0 : 2)
    }
}
