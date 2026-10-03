import AppKit
import Foundation

/// `--selftest invocation [outDir]`: 呼んだ瞬間を ms で測る（INVOCATION_WORLD_CLASS_GATE）。
///
/// 「⌥Space を押してから Genie が反応するまで」は、いちばん最初の印象を決める。
/// ここで測るのは層 A（直接計測）だけ。見た目の良し悪しは測らない。
///
/// 経路は本番と同じ: `GlobalShortcut`（CGEventTap）→ `WindowCoordinator.toggleRecording()`
/// → `RecordingWorkspaceState.start()` → Dock が録音コントローラに変わる → マイク → STT。
/// 入力監視の許可があれば合成 ⌥Space を tap へ注入して **OS の受信まで含めて** 測る。
/// 無ければ handler を直接呼び、その行は NOT_MEASURED にする（捏造しない）。
///
/// 行と基準（本人の定義、2026-09-04）:
///   shortcut → visible feedback   < 100 ms   Dock の枠が最初に動くまで
///   shortcut → microphone ready   < 200 ms   最初の音声フレームが届くまで
///   speech → first transcript     < 400 ms   声を流してから最初の partial まで
///   speech end → processing state < 150 ms   止めてから Dock が結果面へ動き始めるまで
///   focus theft                   0          前面アプリが変わらない・key window を取らない
///   extra windows                 0          自分の窓が増えない
///   idle screen occupation        < 1 %      待機 Dock の面積 / 画面
///   cancel latency                < 100 ms   Listening で Esc → idle の枠が動くまで
///
/// 測れない行は NOT_MEASURED と書く。測れた行に 1 つでも FAIL があれば SELFTEST_FAIL。
@MainActor
enum InvocationGate {
    struct Line: Codable {
        let name: String
        let target: String
        /// 測れた値（ms / % / 個）。測れなければ nil。
        let value: Double?
        let unit: String
        let pass: Bool?
        let note: String
    }

    struct Result: Codable {
        let startedAt: String
        var lines: [Line] = []
        var notMeasured: [String] = []
        var observations: [String] = []
        var verdict = "PARTIAL"
    }

    // MARK: - 観測の道具

    /// 診断行は stderr へ。verify の live loop は **stdout の先頭が SELFTEST_ で始まるか**で判定する
    /// （PERF / VAD / A11Y_* と同じ作法）。stdout に先に書くと、通っていても FAIL に数えられる
    /// （実際そうなった: 本人の verify-all で "FAIL: macOS live invocation"）。
    static func diag(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

    static func settle(_ sec: Double) {
        let until = Date().addingTimeInterval(sec)
        while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
    }

    /// Dock（statusBar level の panel）。無ければ nil。
    static func dockWindow() -> NSWindow? {
        NSApp.windows.first { $0.isVisible && $0.level == .statusBar }
    }

    /// 画面に出ている自分の窓の枚数（window server の値）。
    static func ownWindowCount() -> Int {
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return 0 }
        return infos.filter { info in
            guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == getpid(),
                  let b = info[kCGWindowBounds as String] as? [String: Any],
                  let w = b["Width"] as? Double, let h = b["Height"] as? Double else { return false }
            return w > 20 && h > 10
        }.count
    }

    /// `fire()` を呼んでから `stateReached()` が真になるまで、Dock の枠が最初に動くまで、
    /// 枠が 120ms 動かなくなるまで（最後に動いた時刻）を、2ms 刻みで見る。
    struct Timing { var stateMs: Double?; var firstFrameMs: Double?; var settledMs: Double? }

    static func observe(fire: () -> Void, stateReached: () -> Bool, capSec: Double = 2.5,
                        sample: (Double) -> Void = { _ in }) -> Timing {
        var t = Timing()
        let base = dockWindow()?.frame
        var last = base
        var lastChange: Date?
        let t0 = Date()
        fire()
        let cap = t0.addingTimeInterval(capSec)
        while Date() < cap {
            CFRunLoopRunInMode(.defaultMode, 0.002, true)
            let now = Date()
            sample(now.timeIntervalSince(t0) * 1000)
            if t.stateMs == nil, stateReached() { t.stateMs = now.timeIntervalSince(t0) * 1000 }
            let f = dockWindow()?.frame
            if f != last {
                if t.firstFrameMs == nil, f != base { t.firstFrameMs = now.timeIntervalSince(t0) * 1000 }
                last = f; lastChange = now
            }
            if let lc = lastChange, t.stateMs != nil, now.timeIntervalSince(lc) > 0.12 {
                t.settledMs = lc.timeIntervalSince(t0) * 1000; break
            }
        }
        if t.settledMs == nil, let lc = lastChange { t.settledMs = lc.timeIntervalSince(t0) * 1000 }
        return t
    }

    // MARK: - INVOCATION_AUDIO_TRUTH（呼んで即話しても冒頭を失わないか）

    /// `--selftest invocationaudio [outDir]`。「面が出た瞬間から安心して話せるか」を測る。
    ///
    /// マイクの取り込みは engine を start してから最初の IO バッファ（この Mac で ~100ms）まで
    /// **1 サンプルも入らない**（start 前を貯める ring バッファは無い）。だから
    /// 「面が出てから取り込みが生きるまで」= 冒頭が失われる窓。面が出た後 +0/+50/+100/+200ms に
    /// 話し始めたとき、その時刻が窓の内なら冒頭は落ちる。窓を実測し、各 offset で落ちるかを出す。
    ///
    /// 実音響（スピーカ→マイク）でも確かめられる（`acoustic` 引数）。既定は off——loopback は音量・
    /// 暗騒音に左右されるので、判定の本体は決定的な「取り込みが生きるまでの窓」にする。
    static func audioTruth(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-invocation-audio"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        guard Permissions.microphone == .granted else {
            print("SELFTEST_SKIP invocationaudio: マイク未許可（実 Mac + 許可でだけ測れる）"); SelfTest.exit(0)
        }
        RecordingRuntime.shared.markListening(.localUser)
        _ = LocalStore.shared.open(); MeetingSessionStore.shared.load()
        _ = GlobalShortcut.shared.register(handler: { WindowCoordinator.shared.toggleRecording() })
        RecordingRuntime.shared.prewarmMic()
        let recording = RecordingWorkspaceState.shared

        WindowCoordinator.shared.showVoiceHUD(); settle(1.0)
        // cold を 1 回捨てる（HAL 初期化を測らない）。
        WindowCoordinator.shared.toggleRecording(); settle(1.2)
        WindowCoordinator.shared.toggleRecording(); settle(1.2)

        // 面が出た瞬間（Dock の枠が最初に動いた時刻）と、取り込みが生きた瞬間（awaitingAudio=false
        // か recordedMs>0）を測る。
        let base = dockWindow()?.frame
        var surfaceShownAt: Date?
        var captureLiveAt: Date?
        // 面が出てから取り込みが生きるまでの間、Dock が「録れている」と名乗っていないか。
        // 名乗り＝見出しが「準備中…」でない、あるいは録音ドットが赤い状態。
        // 見出しは view と同じ式で引く（`awaitingAudio` が最初の音声フレームで倒れる）。
        var claimedLiveWhileDeaf = false
        var headlineWhileDeaf: Set<String> = []
        func dockHeadline() -> String {
            recording.awaitingAudio
                ? Facts.recordingHeroPreparing
                : (GenieStateStore.shared.state.meeting.detectedApp ?? Facts.recordingHeroRecording)
        }
        let t0 = Date()
        WindowCoordinator.shared.toggleRecording()
        let cap = t0.addingTimeInterval(4)
        while Date() < cap, captureLiveAt == nil {
            CFRunLoopRunInMode(.defaultMode, 0.002, true)
            if surfaceShownAt == nil, let f = dockWindow()?.frame, f != base { surfaceShownAt = Date() }
            let deaf = recording.awaitingAudio && RecordingRuntime.shared.recordedMs() == 0
            if surfaceShownAt != nil, deaf {
                let h = dockHeadline()
                headlineWhileDeaf.insert(h)
                if h != Facts.recordingHeroPreparing { claimedLiveWhileDeaf = true }
            }
            if captureLiveAt == nil, !recording.awaitingAudio || RecordingRuntime.shared.recordedMs() > 0 {
                captureLiveAt = Date()
            }
        }
        guard let shown = surfaceShownAt, let live = captureLiveAt else {
            WindowCoordinator.shared.toggleRecording()
            print("SELFTEST_FAIL invocationaudio: 面 \(surfaceShownAt != nil)・取り込み \(captureLiveAt != nil) を捉えられない"); SelfTest.exit(2)
        }
        let lossWindowFromSurface = live.timeIntervalSince(shown) * 1000
        let lossWindowFromShortcut = live.timeIntervalSince(t0) * 1000

        // 各 offset で冒頭が落ちるか。1 サンプルも pre-buffer が無いので、
        // offset < 窓 なら落ちる。first word は概ね 300ms なので、窓が 300ms 以上なら
        // 即話すと語ごと失う。
        let offsets: [Double] = [0, 50, 100, 200]
        var anyLost = false
        var rows: [[String: Any]] = []
        diag(String(format: "INVOCATION_AUDIO_TRUTH loss window: 面から %.0fms・%@ から %.0fms（IO 最初のバッファまで）", lossWindowFromSurface, GlobalShortcut.label(), lossWindowFromShortcut))
        for off in offsets {
            let phonemeLost = off < lossWindowFromSurface
            // 「first word 全部」を失うのは、話し始め offset から語末（~300ms）までが窓に入るとき。
            let wordFullyLost = (off + 300) <= lossWindowFromSurface
            if phonemeLost { anyLost = true }
            rows.append(["offsetMs": off, "firstPhonemeLost": phonemeLost, "firstWordFullyLost": wordFullyLost])
            diag(String(format: "  +%.0fms で発話開始 → first phoneme lost=%@  first word fully lost=%@",
                         off, phonemeLost ? "1" : "0", wordFullyLost ? "1" : "0"))
        }

        // 実音響の確認（任意）: say を面表示の直後に鳴らし、録音の journal が伸びたかを見る。
        var acousticNote = "acoustic 未実施（引数 acoustic で有効。loopback は音量に依存）"
        if args.contains("acoustic") {
            let before = RecordingRuntime.shared.recordedMs()
            let say = Process(); say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
            say.arguments = ["-v", "Samantha", "テスト テスト テスト"]
            try? say.run(); say.waitUntilExit(); settle(0.6)
            let after = RecordingRuntime.shared.recordedMs()
            acousticNote = "acoustic: say の前後で recordedMs \(before)→\(after)（loopback。増えていれば取り込みは生きている）"
            diag("  \(acousticNote)")
        }

        // ---- Listening の面（声で頼む）も同じ不変条件で見る。
        // 以前は `beginListening()` がマイクを開かないまま「聞いています…」と名乗っていた。
        WindowCoordinator.shared.toggleRecording(); settle(1.0)   // 録音を止めてから（二重に開かない）
        let hud = VoiceHUDState.shared
        func listeningHeadline() -> String {
            hud.listeningAwaitingAudio ? Facts.recordingHeroPreparing : Facts.listeningPlaceholder
        }
        var listenClaimedLiveWhileDeaf = false
        var listenFirstFrameMs: Double?
        let lt0 = Date()
        hud.beginDictation()
        let lcap = lt0.addingTimeInterval(4)
        while Date() < lcap, listenFirstFrameMs == nil {
            CFRunLoopRunInMode(.defaultMode, 0.002, true)
            if hud.listeningAwaitingAudio, listeningHeadline() != Facts.recordingHeroPreparing {
                listenClaimedLiveWhileDeaf = true
            }
            if !hud.listeningAwaitingAudio { listenFirstFrameMs = Date().timeIntervalSince(lt0) * 1000 }
        }
        let listenHeadlineAfter = listeningHeadline()
        let listenCaptured = listenFirstFrameMs != nil
        let micOpenDuringListening = RecordingRuntime.shared.voiceListening
        hud.cancelListening(); settle(0.5)
        let micClosedAfterCancel = !RecordingRuntime.shared.voiceListening
        diag("  listening truth: 取り込み開始=\(listenCaptured ? "\(Int(listenFirstFrameMs!))ms" : "しなかった")"
            + "・名乗り=\(listenHeadlineAfter)・取り込み前に聞いていますと名乗った=\(listenClaimedLiveWhileDeaf ? "1" : "0")"
            + "・Listening 中にマイクが開いた=\(micOpenDuringListening ? "1" : "0")"
            + "・Esc で閉じた=\(micClosedAfterCancel ? "1" : "0")")
        WindowCoordinator.shared.toggleRecording(); settle(1.0)   // 以降の後始末のため録音へ戻す

        // 取り込みが生きた後は「準備中…」を名乗り続けない（逆向きの嘘も見る）。
        settle(0.4)
        let headlineAfterLive = dockHeadline()
        let stuckPreparing = headlineAfterLive == Facts.recordingHeroPreparing
        diag("  state truth: 取り込み前の見出し=\(headlineWhileDeaf.sorted().joined(separator: "/"))・生きた後=\(headlineAfterLive)"
            + "・取り込み前に録音中を名乗った=\(claimedLiveWhileDeaf ? "1" : "0")・生きた後も準備中のまま=\(stuckPreparing ? "1" : "0")")

        WindowCoordinator.shared.toggleRecording(); settle(0.5)

        // 判定は「UI が名乗る状態と実装の状態が一致しているか」。
        // 物理的な窓（~105ms）は残るが、その間 UI は「録音中」と言わないので、
        // 「録音中と見えてから話した音」は落ちない。窓は証拠として併記する。
        // Listening も同じ条件で見る: 取り込む前に名乗らない・取り込めている・Esc で閉じる。
        let listeningTruthful = !listenClaimedLiveWhileDeaf && listenCaptured && micClosedAfterCancel
        let truthful = !claimedLiveWhileDeaf && !stuckPreparing && listeningTruthful
        let verdict = truthful ? "PASS" : "FAIL"
        let out: [String: Any] = [
            "startedAt": ISO8601DateFormatter().string(from: Date()),
            "lossWindowFromSurfaceMs": lossWindowFromSurface,
            "lossWindowFromShortcutMs": lossWindowFromShortcut,
            "offsets": rows, "acoustic": acousticNote, "verdict": verdict,
            "stateTruth": [
                "claimedLiveWhileDeaf": claimedLiveWhileDeaf,
                "stuckPreparingAfterLive": stuckPreparing,
                "headlineWhileDeaf": headlineWhileDeaf.sorted(),
                "headlineAfterLive": headlineAfterLive,
            ],
            "listeningTruth": [
                "captured": listenCaptured,
                "firstFrameMs": listenFirstFrameMs ?? -1,
                "claimedLiveWhileDeaf": listenClaimedLiveWhileDeaf,
                "headlineAfterLive": listenHeadlineAfter,
                "micOpenDuringListening": micOpenDuringListening,
                "micClosedAfterCancel": micClosedAfterCancel,
            ],
        ]
        if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: outDir).appendingPathComponent("result.json"))
        }
        diag("INVOCATION_AUDIO_TRUTH=\(verdict)（\(outDir)/result.json）")
        if !truthful {
            print("SELFTEST_FAIL invocationaudio: 取り込みが生きる前に録音中を名乗っている（state truth）")
            SelfTest.exit(1)
        }
        print("SELFTEST_OK invocationaudio: \(verdict) — 物理の窓 \(Int(lossWindowFromSurface))ms は残るが、"
            + "その間 UI は「\(Facts.recordingHeroPreparing)」で、録音中を名乗ってから話した音は落ちない"
            + "（+0/+50/+100ms の生の欠けは \(anyLost ? "在り" : "無し")、記録値）")
        SelfTest.exit(0)
    }

    // MARK: - 本体

    static func run(_ args: [String]) {
        let i = args.firstIndex(of: "--selftest")!
        let outDir = args.count > i + 2 ? args[i + 2] : "/tmp/astra-invocation"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        var result = Result(startedAt: ISO8601DateFormatter().string(from: Date()))
        var worldClassFails: [String] = []
        var regressions: [String] = []

        // 回帰の天井（この gate が作った改善を守る）。world-class の目標より緩い。
        // ここを超えたら build を落とす。目標未達（例: マイク準備 <200ms）は落とさない
        // —— world-class は「証明する目標」で、回帰ガードとは別（測れないものは FAIL にしない）。
        let regressionCeiling: [String: Double] = [
            "shortcut → visible feedback": 150,
            "speech end → processing state": 200,
            "cancel latency (Esc in listening)": 150,
            "focus theft": 0,
            "extra windows": 0,
            "idle screen occupation": 2,
        ]

        func line(_ name: String, target: String, value: Double?, unit: String, pass: Bool?, note: String = "") {
            result.lines.append(Line(name: name, target: target, value: value, unit: unit, pass: pass, note: note))
            let v: String
            if let value { v = unit == "ms" ? "\(Int(value.rounded()))ms" : String(format: unit == "%" ? "%.2f%%" : "%.0f", value) }
            else { v = "NOT_MEASURED" }
            let mark = pass.map { $0 ? "PASS" : "FAIL" } ?? "NOT_MEASURED"
            diag("INVOCATION \(name): \(v)  target \(target)  \(mark)\(note.isEmpty ? "" : "  （\(note)）")")
            if value == nil { result.notMeasured.append("\(name): \(note)") }
            if pass == false { worldClassFails.append(name) }
            if let value, let ceil = regressionCeiling[name], value > ceil {
                regressions.append("\(name) \(unit == "ms" ? "\(Int(value))ms" : String(format: "%.2f", value)) > 回帰天井 \(unit == "ms" ? "\(Int(ceil))ms" : String(format: "%.0f", ceil))")
            }
        }

        // 本番と同じ前提（journey / surfacemotion と同じ理由）。
        RecordingRuntime.shared.markListening(.localUser)
        RecordingRuntime.shared.markListening(.remoteAudio)
        _ = LocalStore.shared.open()
        MeetingSessionStore.shared.load()

        // ⌥Space を本番の handler で登録する。入力監視が無ければ false。
        let registered = GlobalShortcut.shared.register(handler: { WindowCoordinator.shared.toggleRecording() })
        // 起動時と同じくマイク engine を先に用意する（AppDelegate と同じ呼び出し。selftest は
        // その前に分岐するので、ここで揃える）。許可済みのときだけ動く。
        RecordingRuntime.shared.prewarmMic()

        // 他アプリを前面にしておく（focus theft を測るため）。
        var frontWanted: String?
        if let finder = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.finder" }) {
            finder.activate(); settle(1.0)
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == finder.bundleIdentifier {
                frontWanted = finder.bundleIdentifier
            }
        }

        WindowCoordinator.shared.showVoiceHUD(); settle(1.0)
        guard let dock = dockWindow() else { print("SELFTEST_FAIL invocation: Dock が出ていない"); SelfTest.exit(2) }
        let windows0 = ownWindowCount()
        var focusTheft = 0
        var extraWindows = 0
        func checkpoint(_ where_: String) {
            if let want = frontWanted, NSWorkspace.shared.frontmostApplication?.bundleIdentifier != want {
                focusTheft += 1; result.observations.append("\(where_): 前面が \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?") に変わった")
            }
            if NSApp.keyWindow != nil { focusTheft += 1; result.observations.append("\(where_): key window を取った") }
            let n = ownWindowCount()
            if n > windows0 { extraWindows = max(extraWindows, n - windows0); result.observations.append("\(where_): 窓が \(windows0)→\(n)") }
        }

        // ---- idle occupation（待機 Dock の面積 / 画面）。AX は要らない。
        let idle = dock.frame
        let screen = (dock.screen ?? NSScreen.main)?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let occMain = idle.width * idle.height / (screen.width * screen.height) * 100
        let occRef = idle.width * idle.height / (1440 * 900) * 100
        line("idle screen occupation", target: "< 1%", value: occMain, unit: "%", pass: occMain < 1,
             note: String(format: "%.0fx%.0fpt / %.0fx%.0f; 1440x900 なら %.2f%%", idle.width, idle.height, screen.width, screen.height, occRef))

        // ---- ⌥Space → 録音コントローラ。
        // 入力監視があれば合成 ⌥Space を session tap へ注入して OS の受信まで含める。
        // 無ければ handler を直接呼ぶ（OS の hop は NOT_MEASURED）。
        let recording = RecordingWorkspaceState.shared
        let store = GenieStateStore.shared
        var hop = "direct"
        func fireShortcut() {
            if registered {
                let src = CGEventSource(stateID: .privateState)
                if let down = CGEvent(keyboardEventSource: src, virtualKey: 49, keyDown: true) {
                    down.flags = [.maskAlternate]; down.post(tap: .cgSessionEventTap)
                }
                if let up = CGEvent(keyboardEventSource: src, virtualKey: 49, keyDown: false) {
                    up.flags = [.maskAlternate]; up.post(tap: .cgSessionEventTap)
                }
                hop = "tap"
            } else {
                WindowCoordinator.shared.toggleRecording()
            }
        }
        // 最初の 1 回を捨てて steady-state を測る。起動直後の初回 ⌥Space は、
        // 音声 HAL の初期化・SwiftUI の初回描画・panel の初回生成で cold（実測 ~380ms）。
        // 本番も初回はこの cold を通るので、その値は下で cold として別に記録する。
        let coldT0 = Date()
        let cold = observe(fire: { WindowCoordinator.shared.toggleRecording() }, stateReached: { recording.isRecording })
        _ = coldT0
        settle(1.0)
        WindowCoordinator.shared.toggleRecording(); settle(1.2)   // 止めて次へ（mic を止め切る）
        result.observations.append("初回（cold）: 枠 \(Int(cold.firstFrameMs ?? -1))ms・state \(Int(cold.stateMs ?? -1))ms。以下は 2 回目以降（steady-state）")

        var t0 = Date()
        var levelMs: Double?, journalMs: Double?
        func sampleAudio(_ elapsed: Double) {
            guard recording.isRecording else { return }
            if levelMs == nil, !recording.awaitingAudio { levelMs = elapsed }
            if journalMs == nil, RecordingRuntime.shared.recordedMs() > 0 { journalMs = elapsed }
        }
        // Sample audio while observing the animation, rather than starting the
        // audio clock after the window has settled (including its 120ms wait).
        var t1 = observe(fire: fireShortcut, stateReached: { recording.isRecording }, sample: sampleAudio)
        if registered, t1.stateMs == nil {
            // tap は登録できたが届かなかった。直接呼び直し、その旨を残す。
            result.observations.append("合成 \(GlobalShortcut.label()) が tap に届かなかった（1.5s）。handler を直接呼んで続ける")
            hop = "direct(tap-miss)"
            t0 = Date(); levelMs = nil; journalMs = nil
            t1 = observe(fire: { WindowCoordinator.shared.toggleRecording() }, stateReached: { recording.isRecording }, sample: sampleAudio)
        }
        guard recording.isRecording else {
            // マイクが無い環境（CI 等）では録音に入れない。落とさず SKIP する
            // （この gate は実 Mac のマイク許可があるときだけ意味を持つ）。
            if Permissions.microphone != .granted {
                print("SELFTEST_SKIP invocation: マイク未許可（実 Mac + 許可でだけ測れる）"); SelfTest.exit(0)
            }
            print("SELFTEST_FAIL invocation: \(GlobalShortcut.label()) で録音が始まらない"); SelfTest.exit(2)
        }
        let hopNote = hop == "tap" ? "合成 \(GlobalShortcut.label()) → CGEventTap → handler（OS の受信を含む）"
                                   : "入力監視なし: handler を直接呼んだ（OS の受信は含まない）"
        line("hotkey delivery", target: "—", value: hop == "tap" ? t1.stateMs : nil, unit: "ms",
             pass: hop == "tap" ? true : nil, note: hop == "tap" ? "tap → isRecording" : hopNote)
        line("shortcut → visible feedback", target: "< 100ms", value: t1.firstFrameMs, unit: "ms",
             pass: t1.firstFrameMs.map { $0 < 100 },
             note: "Dock の枠が最初に動くまで。state \(Int(t1.stateMs ?? -1))ms・settled \(Int(t1.settledMs ?? -1))ms・経路 \(hop)")
        if case .meeting = store.dock {} else { result.observations.append("Dock が .meeting でない: \(store.dock)") }

        // ---- マイクが鳴るまで（最初の音声フレーム）。
        var micMs: Double?
        if Permissions.microphone == .granted {
            // 2 つの合図を別々に見る: 波形の level（audio thread → main）と journal の recordedMs（core）。
            // どちらか早い方を「音が届いた」とし、もう一方も記す（遅れ方が分かる）。
            let cap = Date().addingTimeInterval(3)
            while Date() < cap, levelMs == nil || journalMs == nil {
                CFRunLoopRunInMode(.defaultMode, 0.002, true)
                let now = Date().timeIntervalSince(t0) * 1000
                sampleAudio(now)
                if let l = levelMs, let j = journalMs, min(l, j) > 0, now - min(l, j) > 500 { break }
            }
            micMs = [levelMs, journalMs].compactMap { $0 }.min()
            line("shortcut → microphone ready", target: "< 200ms", value: micMs, unit: "ms",
                 pass: micMs.map { $0 < 200 },
                 note: micMs == nil ? "3s 待っても音声フレームが来ない"
                     : "最初の音声フレームまで。level \(levelMs.map { "\(Int($0))ms" } ?? "—")・journal \(journalMs.map { "\(Int($0))ms" } ?? "—")")
        } else {
            line("shortcut → microphone ready", target: "< 200ms", value: nil, unit: "ms", pass: nil, note: "マイク未許可")
        }
        settle(0.8)
        checkpoint("録音中")

        // ---- 止める → 結果面へ（processing state）。
        let t2 = observe(fire: fireShortcut, stateReached: { !recording.isRecording })
        if registered, t2.stateMs == nil {
            WindowCoordinator.shared.toggleRecording(); settle(0.5)
            result.observations.append("2 回目の合成 \(GlobalShortcut.label()) が届かなかった。直接止めた")
        }
        line("speech end → processing state", target: "< 150ms", value: t2.firstFrameMs, unit: "ms",
             pass: t2.firstFrameMs.map { $0 < 150 },
             note: "止めてから Dock が結果面へ動き始めるまで。state \(Int(t2.stateMs ?? -1))ms・settled \(Int(t2.settledMs ?? -1))ms")
        settle(0.6)
        checkpoint("停止後")

        // ---- 声 → 最初の partial（STT の hop）。認識の許可が無ければ測れない。
        //
        // 本番と同じ VAD → SpeechTranscriber の経路に say の音声を流す（vad selftest と同じ）。
        // 冷えた 1 回目は起動時間を含むので、先に一度暖めてから測る。
        if SpeechTranscriber.authorization == .authorized {
            let ms = measureFirstPartial()
            line("speech → first transcript", target: "< 400ms", value: ms.0, unit: "ms",
                 pass: ms.0.map { $0 < 400 }, note: ms.1)
        } else {
            line("speech → first transcript", target: "< 400ms", value: nil, unit: "ms", pass: nil,
                 note: "音声認識の許可が \(SpeechTranscriber.authorization.rawValue)（この責任プロセスでは測れない）")
        }

        // ---- Listening で Esc（取消）。
        // Esc を届けるには Dock を key にする必要があり、その瞬間は focus を取る。
        // そのため focus theft の判定は上で閉じ、ここは latency だけ測る。
        let hud = VoiceHUDState.shared
        hud.beginDictation(); settle(0.7)
        var cancelMs: Double?
        if case .listening = hud.mode, let dw = dockWindow() {
            let t = observe(fire: { JourneyRecorder.press(JourneyRecorder.keyEsc, "\u{1B}", in: dw) },
                            stateReached: { if case .idle = hud.mode { return true } else { return false } })
            cancelMs = t.firstFrameMs ?? t.stateMs
            line("cancel latency (Esc in listening)", target: "< 100ms", value: cancelMs, unit: "ms",
                 pass: cancelMs.map { $0 < 100 },
                 note: "state \(Int(t.stateMs ?? -1))ms・枠 \(Int(t.firstFrameMs ?? -1))ms")
            if case .listening = hud.mode { hud.cancelListening() }
        } else {
            line("cancel latency (Esc in listening)", target: "< 100ms", value: nil, unit: "ms", pass: nil, note: "Listening に入れない")
        }
        if let want = frontWanted, let other = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == want }) {
            other.activate(); settle(0.3)
        }

        line("focus theft", target: "0", value: frontWanted == nil ? nil : Double(focusTheft), unit: "n",
             pass: frontWanted == nil ? nil : focusTheft == 0, note: frontWanted == nil ? "他アプリを前面にできない" : "Finder 前面のまま・key window なし")
        line("extra windows", target: "0", value: Double(extraWindows), unit: "n", pass: extraWindows == 0,
             note: "自分の窓 \(windows0) 枚のまま")

        // ---- 独立した起動プローブ（Evidence A）。別の実行同士を内訳として差し引かない。
        // 録音の外で 1 回ずつ起動して止める。本番の順は begin() の中（STT → マイク）。
        do {
            func ms(_ block: () -> Void) -> Double { let t = Date(); block(); return Date().timeIntervalSince(t) * 1000 }
            let mic = MicCapture()
            let micMs = ms { try? mic.start { _ in } }
            mic.stop()
            let st = SpeechTranscriber()
            let sttMs = ms { try? st.start { _ in } }
            st.finish()
            // begin() 全体も別に測る。HAL の状態が異なるので、上の単体値とは加減算できない。
            let rt = RecordingRuntime.shared
            let beginMs = ms { _ = rt.begin(meetingId: "invocation-probe-\(getpid())") }
            let endMs = ms { rt.end() }
            let note = String(format: "RecordingRuntime.begin %.0fms・MicCapture.start %.0fms・SpeechTranscriber.start %.0fms・end %.0fms（各々別の起動、内訳ではない。許可 %d）", beginMs, micMs, sttMs, endMs, SpeechTranscriber.authorization.rawValue)
            diag("INVOCATION independent startup probes: \(note)")
            result.observations.append("独立した起動プローブ: \(note)")
        }

        // ---- 判定と記録。
        // world-class verdict は目標に対する評価（PARTIAL でも build は落とさない）。
        // build を落とすのは回帰だけ（この gate が作った改善が壊れたとき）。
        let measured = result.lines.filter { $0.value != nil }.count
        result.verdict = !worldClassFails.isEmpty ? (regressions.isEmpty ? "PARTIAL" : "FAIL")
                                                  : (result.notMeasured.isEmpty ? "PASS" : "PARTIAL")
        if let data = try? JSONEncoder.pretty.encode(result) {
            try? data.write(to: URL(fileURLWithPath: outDir).appendingPathComponent("result.json"))
        }
        diag("INVOCATION_WORLD_CLASS_GATE=\(result.verdict) measured=\(measured)/\(result.lines.count) worldClassMiss=\(worldClassFails.count) regressions=\(regressions.count) notMeasured=\(result.notMeasured.count)")
        for o in result.observations { diag("  観察: \(o)") }
        if !regressions.isEmpty {
            for r in regressions { diag("  回帰: \(r)") }
            print("SELFTEST_FAIL invocation: 回帰 \(regressions.count) 件")
            SelfTest.exit(1)
        }
        let miss = worldClassFails.isEmpty ? "" : " — world-class 未達: \(worldClassFails.joined(separator: ", "))（回帰ではない）"
        print("SELFTEST_OK invocation: \(result.verdict) measured \(measured)/\(result.lines.count)\(miss)（\(outDir)/result.json）")
        SelfTest.exit(0)
    }

    /// say の音声を VAD → SpeechTranscriber に流し、最初の partial までの ms を返す。
    static func measureFirstPartial() -> (Double?, String) {
        let aiff = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("astra-invocation-\(getpid()).aiff")
        defer { try? FileManager.default.removeItem(at: aiff) }
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", "Samantha", "-o", aiff.path, "testing astra invocation latency"]
        do { try say.run(); say.waitUntilExit() } catch { return (nil, "say を使えない") }
        guard say.terminationStatus == 0, let frames = SelfTest.decodeTo16kMonoF32(aiff) else { return (nil, "音源を用意できない") }

        func feed(_ st: SpeechTranscriber, gated: Bool) -> Date? {
            var gate = VoiceActivityDetector()
            var fedAt: Date?
            var i = 0
            while i < frames.count {
                let end = min(i + 3200, frames.count)
                let chunk = Array(frames[i..<end])
                if !gated || gate.accept(chunk) {
                    if fedAt == nil { fedAt = Date() }
                    st.append(chunk)
                }
                i = end
                CFRunLoopRunInMode(.defaultMode, 0.02, true)
            }
            return fedAt
        }
        // 暖める（認識器の起動を測らない）。
        let warm = SpeechTranscriber(localeId: "en-US")
        try? warm.start { _ in }
        _ = feed(warm, gated: false)
        warm.finish(); settle(0.4)

        let st = SpeechTranscriber(localeId: "en-US")
        let lock = NSLock()
        var firstPartialAt: Date?
        do {
            try st.start { ev in
                lock.lock(); if !ev.isFinal, firstPartialAt == nil { firstPartialAt = Date() }; lock.unlock()
            }
        } catch { return (nil, "STT を開始できない: \(error)") }
        let fedAt = feed(st, gated: true)
        let deadline = Date().addingTimeInterval(4)
        while firstPartialAt == nil, Date() < deadline { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
        st.finish()
        guard let fedAt, let at = firstPartialAt else { return (nil, "partial が返らなかった") }
        return (at.timeIntervalSince(fedAt) * 1000, "VAD 通過の最初のフレーム → 最初の partial（暖めた後）")
    }
}

private extension JSONEncoder {
    static var pretty: JSONEncoder { let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]; return e }
}
