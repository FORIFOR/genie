import AppKit
import AVFoundation
import Foundation

/// `--selftest voicee2e <音声ファイル> [base]`: 「会話」を、声の入口から次のターンまで本番の道で通す。
///
/// マイクの代わりに音声ファイル（`say -o` で作った合成音声など）を流し込む
/// （`RecordingRuntime.voiceInjection`）。そこから先はすべて本番と同じ:
/// VAD → オンデバイス STT → ConversationLoop → gateway の turn → 答え → 読み上げ → 次のターンを聞く。
/// **どこで止まったか**を段ごとに書く。人に試してもらう前に、ここが通ることを確かめる。
extension SelfTest {
    @MainActor
    static func voiceE2E(_ args: [String]) async {
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 2 else { print("SELFTEST_FAIL voicee2e: usage --selftest voicee2e <audio file> [base]"); exit(2) }
        let file = args[i + 2]
        let base = args.count > i + 3 ? args[i + 3] : "http://127.0.0.1:3000"
        guard GenieCoreBridge.reachable(base) else { print("SELFTEST_SKIP voicee2e: gateway unreachable"); exit(0) }
        guard let frames = loadMono16k(file), !frames.isEmpty else { print("SELFTEST_FAIL voicee2e: cannot read \(file)"); exit(2) }
        guard SpeechTranscriber.authorization == .authorized else { print("SELFTEST_FAIL voicee2e: stage=stt speech recognition not authorized"); exit(2) }

        // 準備済みの検査用 identity（host が付いている）を使う。無ければ開発サインイン。
        let token: String
        do {
            if let path = ProcessInfo.processInfo.environment["ASTRA_SELFTEST_AGENT_TOKEN_PATH"], path.hasPrefix("/tmp/") {
                token = try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            } else if let identity = UserDefaults(suiteName: "com.astra.mac")?.string(forKey: "astra.dev.identity.\(base)") {
                // アプリと**同じ本人**で通す（GatewaySession と同じ作り方）。別の本人で通すと、host が
                // 付いていない本人の失敗（端末待ちのまま止まる）を見逃す。実際に一度そうなった。
                token = try GenieCoreBridge.devSignIn(base, email: "main-\(identity)@astra.local", displayName: "Genie").accessToken
            } else {
                print("SELFTEST_FAIL voicee2e: stage=signin the app has no identity for \(base) (open Genie once)"); exit(2)
            }
        } catch { print("SELFTEST_FAIL voicee2e: stage=signin \(error)"); exit(2) }
        guard LocalStore.shared.open() else { print("SELFTEST_FAIL voicee2e: storage unavailable"); exit(2) }

        // 画面に Dock を出す（出さないと、処理の流れだけを見て画面を見ないことになる）。
        NSApp.setActivationPolicy(.regular)
        WindowCoordinator.shared.showVoiceHUD()
        let shotDir = args.firstIndex(of: "--shots").flatMap { args.count > $0 + 1 ? args[$0 + 1] : nil }
        if let shotDir { try? FileManager.default.createDirectory(atPath: shotDir, withIntermediateDirectories: true) }
        var shots: [String] = []
        func shoot(_ name: String) {
            guard let shotDir, let (id, w, h) = dockWindow() else { return }
            guard let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .nominalResolution]),
                  let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { return }
            try? png.write(to: URL(fileURLWithPath: "\(shotDir)/\(shots.count)-\(name).png"))
            shots.append("\(name)=\(w)x\(h)")
        }
        let hud = VoiceHUDState.shared
        hud.configureBackend(base: base, token: token)
        RecordingRuntime.shared.voiceInjection = frames
        if args.contains("--listen") { await listenE2E(hud) }
        let started = Date()
        func t() -> String { String(format: "%.1fs", Date().timeIntervalSince(started)) }
        var log: [String] = []
        var heard = "", sent = "", reply = ""
        var sawSpeaking = false, sawCard = false

        hud.beginConversation()
        try? await Task.sleep(nanoseconds: 600_000_000)
        shoot("listening")
        guard hud.conversation.isActive else { print("SELFTEST_FAIL voicee2e: stage=start conversation did not start (mode=\(hud.mode))"); exit(2) }
        log.append("start@\(t())")

        let deadline = Date().addingTimeInterval(90)
        var stage = "listen"
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if case .listening(let partial) = hud.mode, !partial.isEmpty { heard = partial }
            if case .info = hud.mode { sawCard = true }
            switch stage {
            case "listen":
                if hud.conversation.phase == .waiting {
                    sent = hud.latestRequestID.flatMap { id in LocalStore.shared.loadTasks().first { $0.id == id }?.requestRecord?.request } ?? ""
                    log.append("sent@\(t())"); stage = "answer"
                    try? await Task.sleep(nanoseconds: 400_000_000); shoot("thinking")
                } else if RecordingRuntime.shared.voiceTranscriptionUnavailable {
                    print("SELFTEST_FAIL voicee2e: stage=stt on-device speech recognition could not start (nothing would be heard) \(log)"); exit(2)
                }
            case "answer":
                if hud.conversation.phase == .speaking {
                    sawSpeaking = true; reply = hud.answer; log.append("speaking@\(t())"); stage = "next"
                    try? await Task.sleep(nanoseconds: 600_000_000); shoot("answer-speaking")
                }
                else if hud.conversation.phase == .preparing { reply = hud.answer; log.append("answered-silently@\(t())"); stage = "done" }
            case "next":
                if hud.conversation.phase == .preparing || hud.conversation.phase == .listening {
                    log.append("listening-again@\(t())"); stage = "done"
                    try? await Task.sleep(nanoseconds: 600_000_000); shoot("listening-again")
                }
            default: break
            }
            if stage == "done" || !hud.conversation.isActive { break }
        }
        let active = hud.conversation.isActive
        hud.endConversation(.user)
        let summary = "shots=[\(shots.joined(separator: ","))] heard=\"\(heard)\" sent=\"\(sent)\" reply=\"\(reply.prefix(40))\" card=\(sawCard) spoke=\(sawSpeaking) \(log.joined(separator: " "))"
        guard stage == "done" else {
            print("SELFTEST_FAIL voicee2e: stopped at stage=\(stage) conversationActive=\(active) mode=\(hud.mode) \(summary)"); exit(2)
        }
        print("SELFTEST_OK voicee2e: \(summary)")
        exit(0)
    }

    /// 一回の音声入力（聞く）。言い終えた文が Genie に送られるか、前面のアプリの欄へ回るかを見る。
    /// 欄へ回る側は dryRun で**打ち込まずに**記録する。
    @MainActor
    private static func listenE2E(_ hud: VoiceHUDState) async {
        var dictated: String?
        Dictation.dryRun = { dictated = $0; return true }
        let before = hud.latestRequestID
        let started = Date()
        hud.beginDictation()
        let dockKey = WindowCoordinator.shared.isListeningDockKey
        var answer = ""
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if dictated != nil { break }
            if hud.latestRequestID != before, !hud.requestInFlight {
                if case .info = hud.mode { answer = hud.answer; break }
                if case .answer(let t) = hud.mode { answer = t; break }
            }
        }
        Dictation.dryRun = nil
        let t = String(format: "%.1fs", Date().timeIntervalSince(started))
        // 「聞く」は一回の音声入力。Dock が入力を受けていなければ前面のアプリの欄へ入れる（HUD-004）。
        // 質問・依頼は「会話」から Genie へ。どちらへ回したかと、その根拠を書く（打ち込みはしていない）。
        if let dictated {
            print("SELFTEST_OK voicee2e(listen): route=frontmost-field (dockKey=\(dockKey); one-shot input goes to the focused field by design) text=\"\(dictated)\" @\(t)"); exit(0)
        }
        guard !answer.isEmpty else {
            print("SELFTEST_FAIL voicee2e(listen): no answer (dockKey=\(dockKey) mode=\(hud.mode) request=\(hud.latestRequestID != before)) @\(t)"); exit(2)
        }
        print("SELFTEST_OK voicee2e(listen): route=genie (dockKey=\(dockKey)) answer=\"\(answer.prefix(40))\" @\(t)")
        exit(0)
    }

    /// 自分の Dock の窓（画面に出ている、いちばん上のもの）。
    static func dockWindow() -> (CGWindowID, Int, Int)? {
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in infos {
            guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                  let id = info[kCGWindowNumber as String] as? CGWindowID,
                  let b = info[kCGWindowBounds as String] as? [String: Any],
                  let w = b["Width"] as? CGFloat, let h = b["Height"] as? CGFloat, w > 100, h > 30 else { continue }
            return (id, Int(w), Int(h))
        }
        return nil
    }

    /// 音声ファイル → 16 kHz mono の float。
    static func loadMono16k(_ path: String) -> [Float]? {
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
              let out = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: file.processingFormat, to: out),
              let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: input)) != nil else { return nil }
        let capacity = AVAudioFrameCount(Double(input.frameLength) * 16_000 / file.processingFormat.sampleRate + 1_024)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        converter.convert(to: buffer, error: &error) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true; status.pointee = .haveData; return input
        }
        guard error == nil, let ch = buffer.floatChannelData else { return nil }
        return Array(UnsafeBufferPointer(start: ch[0], count: Int(buffer.frameLength)))
    }
}
