import AppKit
import CoreAudio

/// `--selftest micrelease`: やめたらマイクが本当に閉じるか。
///
/// 画面が待機に戻っても、この process がマイクの入力を回し続けていれば、メニューバーに
/// マイクの印が出たままになる（2026-09-28 に実機で起きた）。見た目ではなく、CoreAudio に
/// 「この process は入力を回しているか」を聞いて確かめる。実マイクを開くので .app として動かす。
extension SelfTest {
    /// この process がいま音声入力を回しているか（CoreAudio の process object）。
    static func processIsRunningInput() -> Bool? {
        var pid = getpid()
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var translate = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &translate,
                                         UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object) == noErr,
              object != kAudioObjectUnknown else { return false }   // 音声の process object が無い＝回していない
        var running: UInt32 = 0
        var runningSize = UInt32(MemoryLayout<UInt32>.size)
        var input = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningInput,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(object, &input, 0, nil, &runningSize, &running) == noErr else { return nil }
        return running != 0
    }

    @MainActor
    static func micRelease() async {
        NSApp.setActivationPolicy(.accessory)
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP micrelease: マイクの許可が無い"); exit(0) }
        let hud = VoiceHUDState.shared
        WindowCoordinator.shared.showVoiceHUD()
        await pause(1.0)

        var report: [String] = []
        var failures: [String] = []
        /// 開いている間は回っていること（回っていなければ、閉じたかどうかを測れていない）、
        /// やめた後 1.5 秒で止まっていることを見る。
        func check(_ name: String, open: () -> Void, close: () -> Void) async {
            open()
            await pause(2.0)
            let during = processIsRunningInput()
            close()
            await pause(1.5)
            let after = processIsRunningInput()
            let mode = "\(hud.mode)".prefix(24)
            report.append("\(name)(開いて=\(during.map(String.init) ?? "?") やめて=\(after.map(String.init) ?? "?") 面=\(mode))")
            if during != true { failures.append("\(name)=開いている間に入力が回っていない（測れていない）") }
            if after != false { failures.append("\(name)=やめた後もマイクが回っている") }
            // 次の検査の前に必ず閉じた状態へ戻す。
            hud.endConversation(.user); hud.cancelListening(); hud.mode = .idle
            await pause(0.8)
        }

        let atStart = processIsRunningInput()
        report.append("起動直後=\(atStart.map(String.init) ?? "?")")
        if atStart != false { failures.append("起動直後からマイクが回っている") }

        await check("会話→会話を終了", open: { hud.beginConversation() }, close: { hud.endConversation(.user) })
        await check("会話→Esc", open: { hud.beginConversation() }, close: { hud.cancelListening() })
        await check("会話→Dockを押す", open: { hud.beginConversation() }, close: { hud.toggleQuickActions() })
        if AXIsProcessTrusted() {
            await check("音声入力→Esc", open: { hud.beginDictation() }, close: { hud.cancelListening() })
            await check("音声入力→Dockを押す", open: { hud.beginDictation() }, close: { hud.toggleQuickActions() })
        } else {
            report.append("音声入力=アクセシビリティ未許可のため測らない")
        }
        // 面が別のところから差し替えられる（メニューの「操作を出す」・画面の質問・遅れて届いた答え）。
        await check("会話→面の差し替え", open: { hud.beginConversation() }, close: { GenieStateStore.shared.setDock(.idle) })
        await check("会話→消音", open: { hud.beginConversation() }, close: { hud.toggleListeningMute() })
        await check("会議の問い→答えの面", open: { hud.beginMeetingAsk() }, close: { hud.mode = .answer("遅れて届いた答え") })
        await check("会議の問い→Esc", open: { hud.beginMeetingAsk() }, close: { hud.cancelListening() })
        // 考え中で Esc（会話の行はあるが、答えを待っている）。
        await check("会話→考え中でEsc", open: { hud.beginConversation() }, close: { hud.mode = .thinking; hud.leaveThinking() })

        // 閉じてすぐ開き直す: 新しい取り込みが生きていること（以前は前の開始の後始末が新しい方を止めた）。
        // 間を置かない（マイクの起動が終わる前に閉じて開く。起動は 47〜770ms かかる）。
        hud.beginMeetingAsk()
        hud.cancelListening()
        hud.beginMeetingAsk()
        await pause(2.0)
        let reopened = processIsRunningInput()
        report.append("閉じてすぐ開き直す(開いて=\(reopened.map(String.init) ?? "?"))")
        if reopened != true { failures.append("閉じてすぐ開き直す=新しい取り込みが止まっている") }
        hud.cancelListening()
        await pause(1.5)
        if processIsRunningInput() != false { failures.append("開き直した後に閉じてもマイクが回っている") }

        // 素早く開いて閉じる（マイクの起動が終わる前にやめる）。
        hud.beginConversation(); hud.endConversation(.user)
        await pause(2.0)
        let quick = processIsRunningInput()
        report.append("会話→すぐ終了(やめて=\(quick.map(String.init) ?? "?"))")
        if quick != false { failures.append("会話→すぐ終了=起動途中でやめるとマイクが残る") }

        let ok = failures.isEmpty
        print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " micrelease: " + (report + failures).joined(separator: " "))
        exit(ok ? 0 : 2)
    }
}
