import AppKit
import GenieApproval

/// `--selftest approval-press`: backend の承認カードに、**本物のキー**で答えられるか。
///
/// 以前の `Confirm.approve` は答えを待つ間 CFRunLoopRunInMode を空回ししていた。その間は
/// NSApp.sendEvent を通らないので人のクリックやキーがボタンへ届かず、`await MainActor.run` の中では
/// メインキューも止まり、120 秒後に必ず「承認しない」になっていた。検査の側は `UIProbe.tap`
/// （クロージャを直に呼ぶ）や `JourneyRecorder.press`（NSApp.sendEvent を直に呼ぶ）で押していたので、
/// イベントの列を通らず、これに気づけなかった。
///
/// ここでは本番と同じく `Task.detached` から `VoiceHUDState.settleApprovals`（既定の聞き方 =
/// `Confirm.approve`）を呼び、待っている最中に **CGEvent.postToPid でこのプロセスへ実キーを送る**。
///   ① ⌘Return → 承認の中継が 1 回（証拠付き）。待つ間もメインキューが進む
///   ② 出た直後（押し間違いの窓）の ⌘Return は受け付けない → そのあとの Escape で「やめる」→ REJECTED が 1 回
///   ③ 何も押さない → 答えが無い。REJECTED も APPROVED も送らず、カードを引っ込める
extension SelfTest {
    /// 別の実行文脈（detached）から書かれる記録。
    private final class PressLog: @unchecked Sendable {
        private let lock = NSLock()
        private var _approved: [String] = [], _rejected: [String] = [], _replies: [TaskReply] = []
        func approved(_ id: String) { lock.lock(); _approved.append(id); lock.unlock() }
        func rejected(_ id: String) { lock.lock(); _rejected.append(id); lock.unlock() }
        func replied(_ r: TaskReply) { lock.lock(); _replies.append(r); lock.unlock() }
        var snapshot: (approved: [String], rejected: [String], replies: [TaskReply]) {
            lock.lock(); defer { lock.unlock() }
            return (_approved, _rejected, _replies)
        }
    }

    @MainActor
    static func approvalPress() async {
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        var fail: [String] = []
        var rows: [String] = []
        WindowCoordinator.shared.showVoiceHUD()
        await pause(0.5)
        guard WindowCoordinator.shared.isVoiceHUDVisible else {
            print("SELFTEST_SKIP approval-press: Dock を出せない（headless）"); exit(0)
        }
        let store = GenieStateStore.shared
        let pid = ProcessInfo.processInfo.processIdentifier
        /// 実キーをこのプロセスへ送る（NSApp.sendEvent を直に呼ばない。イベントの列を通す）。
        func post(_ key: CGKeyCode, command: Bool) {
            WindowCoordinator.shared.focusListeningDock()   // 鍵は key の窓にしか届かない
            let src = CGEventSource(stateID: .hidSystemState)
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) else { return }
            if command { down.flags = .maskCommand; up.flags = .maskCommand }
            down.postToPid(pid); up.postToPid(pid)
        }
        let returnKey: CGKeyCode = 36, escapeKey: CGKeyCode = 53

        /// 本番と同じ道で 1 件の承認を聞く。聞き方は既定（`Confirm.approve`）のまま。
        func settle(_ id: String, log: PressLog, timeout: TimeInterval) {
            let first = TaskFollowUp(reply: TaskReply(text: "", phase: .waiting), pendingApprovals: [BackendApproval(
                id: id, summary: "対象の窓1つを、1操作ごとの確認なしで最大12操作・5分まで操作します", risk: "EXTERNAL_COMMIT",
                details: [.init(label: "目的", value: "検査用の操作"),
                          .init(label: "画像の送信先", value: "この端末で設定したモデル")],
                impact: .init(primaryActionLabel: "画面の操作を始める", affectedCount: nil, external: true, reversible: false, recoveryNote: nil))])
            Task.detached {
                let reply = try? await VoiceHUDState.settleApprovals(first, waitMs: 1,
                    ask: { await Confirm.approve($0, timeout: timeout) },
                    approve: { id, _ in log.approved(id) },
                    reject: { log.rejected($0) },
                    follow: { _ in TaskFollowUp(reply: TaskReply(text: "done", phase: .complete)) })
                log.replied(reply?.reply ?? TaskReply(text: "throw", phase: .unknown))
            }
        }
        /// 実キーを送ってよい状態になるまで待つ。**固定の時間では待たない。**
        /// 以前は固定の 0.8 秒の後に送っていたので、起動直後（Dock がまだ key になっていない）は
        /// キーが届かず、8 回に 1 回ほど ① が落ちた。カードが Dock に出ている・「実行する」が描かれている・
        /// Dock が key の窓である、を確かめ、`armed` の間（押し間違いの窓）を越えたら送る。
        /// 期限までに揃わなければ、何が揃わなかったかを返す（送らない）。
        /// `drawnAt` は「実行する」が描かれたのを見た時刻（押し間違いの窓の中かを数えるため）。
        func readyToPress(armed: Bool, seconds: Double = 8) async -> (notReady: String?, drawnAt: Date?) {
            let until = Date().addingTimeInterval(seconds)
            var drawnAt: Date?
            while Date() < until {
                let shown: Bool
                if case .confirmation = store.dock { shown = true } else { shown = false }
                if shown, UIProbe.exists("confirmProceed") {
                    if drawnAt == nil { drawnAt = Date() }
                    if !WindowCoordinator.shared.isVoiceHUDKey { WindowCoordinator.shared.focusListeningDock() }
                    else if !armed || Date().timeIntervalSince(drawnAt!) >= ActionConfirmation.proceedArmDelay + 0.2 { return (nil, drawnAt) }
                }
                await pause(0.02)
            }
            if case .confirmation = store.dock {} else { return ("承認カードが Dock に出ない", drawnAt) }
            if !UIProbe.exists("confirmProceed") { return ("カードの「実行する」が描かれない", drawnAt) }
            return ("Dock が key の窓にならない（実キーが届かない）", drawnAt)
        }
        /// カードを出す前に Dock を key にしておく（② で、描かれた直後＝押し間違いの窓の中に送れるように）。
        func focusDockBeforeCard(seconds: Double = 8) async -> Bool {
            let until = Date().addingTimeInterval(seconds)
            while Date() < until {
                if WindowCoordinator.shared.isVoiceHUDKey { return true }
                WindowCoordinator.shared.focusListeningDock()
                await pause(0.05)
            }
            return false
        }
        func waitFor(_ log: PressLog, seconds: Double) async {
            let until = Date().addingTimeInterval(seconds)
            while log.snapshot.replies.isEmpty, Date() < until { await pause(0.05) }
        }

        // ① ⌘Return（実キー）で実行する。
        let one = PressLog()
        settle("press-approve", log: one, timeout: 15)
        let notReady1 = await readyToPress(armed: true).notReady   // 出た直後の押下は受け付けないので、それを越えてから
        var mainQueueRan = false
        DispatchQueue.main.async { mainQueueRan = true }
        if let notReady1 { fail.append("① " + notReady1) } else { post(returnKey, command: true) }
        await waitFor(one, seconds: 5)
        let r1 = one.snapshot
        if notReady1 == nil, r1.approved != ["press-approve"] { fail.append("実キーの ⌘Return で承認が届かない approved=\(r1.approved) replies=\(r1.replies.map(\.text))") }
        if !r1.rejected.isEmpty { fail.append("⌘Return なのに REJECTED を送った") }
        if !mainQueueRan { fail.append("答えを待つ間にメインキューが止まった") }
        if store.state.confirmation != nil { fail.append("答えたのにカードが残る") }
        rows.append("real_cmd_return=\(notReady1 != nil ? "NOT_READY" : r1.approved == ["press-approve"] ? "approved" : "FAIL")")
        // ① のカードが残ったまま ② ③ を続けると、落ちた理由が連鎖して読めなくなる。
        if store.state.confirmation != nil {
            for r in rows { FileHandle.standardError.write(("APPROVAL_PRESS\t" + r + "\n").data(using: .utf8)!) }
            print("SELFTEST_FAIL approval-press: " + fail.joined(separator: " / ") + "（① のカードが残ったので ② ③ は行わない）"); exit(1)
        }

        // ② 出た直後の ⌘Return は受け付けない。そのあとの Escape（実キー）で「やめる」。
        let two = PressLog()
        let keyed = await focusDockBeforeCard()
        settle("press-decline", log: two, timeout: 15)
        // 押し間違いの窓の中で送る。カードが描かれ Dock が key になった直後（armed を待たない）。
        var (notReady2, drawnAt2) = await readyToPress(armed: false)
        if notReady2 == nil, !keyed { notReady2 = "カードの前に Dock が key の窓にならない" }
        // 送る時点で窓（proceedArmDelay）の中にいること。越えていたら、この段は何も確かめていない。
        if notReady2 == nil, let drawnAt2, Date().timeIntervalSince(drawnAt2) >= ActionConfirmation.proceedArmDelay - 0.1 {
            notReady2 = "押し間違いの窓の中で送れなかった（描かれてから \(String(format: "%.2f", Date().timeIntervalSince(drawnAt2))) 秒）"
        }
        if let notReady2 { fail.append("② " + notReady2) } else { post(returnKey, command: true) }
        await pause(0.6)
        let earlyApproved = !two.snapshot.approved.isEmpty
        if earlyApproved { fail.append("出た直後の ⌘Return で承認した") }
        let notReady2b = await readyToPress(armed: false).notReady
        if let notReady2b { fail.append("② Escape: " + notReady2b) } else { post(escapeKey, command: false) }
        await waitFor(two, seconds: 5)
        let r2 = two.snapshot
        let declined = r2.rejected == ["press-decline"] && r2.approved.isEmpty && r2.replies.first?.phase == .cancelled
        if r2.rejected != ["press-decline"] { fail.append("実キーの Escape で「やめる」が届かない rejected=\(r2.rejected)") }
        if !r2.approved.isEmpty { fail.append("Escape なのに承認した") }
        if r2.replies.first?.phase != .cancelled { fail.append("やめたのに取り消しと言わない") }
        rows.append("early_cmd_return=\(notReady2 != nil ? "NOT_READY" : earlyApproved ? "FAIL" : "ignored")")
        rows.append("real_escape=\(notReady2b != nil ? "NOT_READY" : declined ? "declined" : "FAIL")")

        // ③ 何も押さない。答えが無いのは「やめた」ではない。
        let three = PressLog()
        var resolved = 0
        let token = GenieEventBus.shared.subscribe { e in if case .confirmationResolved = e { resolved += 1 } }
        settle("press-none", log: three, timeout: 1.0)
        await waitFor(three, seconds: 5)
        GenieEventBus.shared.unsubscribe(token)
        let r3 = three.snapshot
        if !r3.rejected.isEmpty || !r3.approved.isEmpty { fail.append("答えが無いのに送った approved=\(r3.approved) rejected=\(r3.rejected)") }
        if r3.replies.first?.phase != .waiting { fail.append("答えが無いのに待ちと言わない \(r3.replies.map(\.text))") }
        if resolved != 0 { fail.append("答えが無いのを「やめた」として流した") }
        if store.state.confirmation != nil { fail.append("答えが無いカードが残る") }
        let pendingOK = r3.rejected.isEmpty && r3.approved.isEmpty && r3.replies.first?.phase == .waiting
            && resolved == 0 && store.state.confirmation == nil
        rows.append("no_answer=\(pendingOK ? "pending" : "FAIL")")

        for r in rows { FileHandle.standardError.write(("APPROVAL_PRESS\t" + r + "\n").data(using: .utf8)!) }
        if fail.isEmpty { print("SELFTEST_OK approval-press: " + rows.joined(separator: " ")); exit(0) }
        print("SELFTEST_FAIL approval-press: " + fail.joined(separator: " / ")); exit(1)
    }
}
