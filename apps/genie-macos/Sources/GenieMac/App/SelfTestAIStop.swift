import AppKit

/// `--selftest aistop [base]`: Dock の「止める」が backend の仕事を本当に取り消すか。
///
/// 以前の止めるは表示を変えるだけで、backend の仕事は動き続け、後から届いた成功で「止めた」面が ✓ に変わった。
/// 実 gateway に会議の AI 操作を出し、backend の仕事ができたところで止めるを押し、その仕事の状態を読み戻す。
/// 試験用の利用者は `ASTRA_SELFTEST_AGENT_EMAIL`（host がある利用者）。外部には何も送らない。
extension SelfTest {
    @MainActor
    static func aiStop(_ args: [String]) async {
        let i = args.firstIndex(of: "--selftest")!
        let base = args.count > i + 2 ? args[i + 2] : "http://127.0.0.1:3000"
        func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        guard GenieCoreBridge.reachable(base) else { print("SELFTEST_SKIP aistop: gateway unreachable"); exit(0) }
        do {
            let configured = ProcessInfo.processInfo.environment["ASTRA_SELFTEST_AGENT_EMAIL"]
            let email = configured?.hasSuffix("@astra.local") == true ? configured! : "aistop-\(getpid())@astra.local"
            let token = try GenieCoreBridge.devSignIn(base, email: email, displayName: "AI").accessToken
            let state = RecordingWorkspaceState.shared
            let store = GenieStateStore.shared
            store.reset()
            state.configureBackend(base: base, token: token)
            state.transcript = [
                TranscriptSegment(speaker: "田中", text: "リリースは 9 月 12 日にしましょう。", interim: false),
                TranscriptSegment(speaker: "鈴木", text: "OAuth の確認を私がやります。", interim: false),
            ]
            state.runAIAction("リアルタイム要約")
            // backend の仕事ができるまで待つ（最大 20 秒）。
            let deadline = Date().addingTimeInterval(20)
            while state.aiJobIdForTest == nil, store.state.activeTask?.status == .running, Date() < deadline { await pause(0.1) }
            guard let job = state.aiJobIdForTest, !job.isEmpty else {
                print("SELFTEST_SKIP aistop: backend の仕事ができる前に終わった（status=\(store.state.activeTask?.status.rawValue ?? "nil")）")
                exit(0)
            }
            store.stopTask()
            let stoppedStatus = store.state.activeTask?.status
            // 止めた直後は「停止しました」の結果（3 秒で縮む。One Continuous Surface）。
            let cancelledShown: Bool = { if case .result(let r) = store.dock { return r.cancelled }; return false }()
            var sawSuccess = false
            // 取り消しが届くのと、後から届くかもしれない結果を待つ。
            var server = ""
            for _ in 0..<30 {
                await pause(0.3)
                let json = try GenieCoreBridge.taskGet(base, accessToken: token, taskId: job)
                server = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])?["status"] as? String ?? ""
                if case .result(let r) = store.dock, !r.failed { sawSuccess = true }
                if ["CANCELLED", "COMPLETED", "FAILED"].contains(server) { break }
            }
            for _ in 0..<20 {   // 遅れた成功で面が ✓ に変わらないか
                await pause(0.1)
                if case .result(let r) = store.dock, !r.failed { sawSuccess = true }
            }
            let finalStatus = store.state.activeTask?.status
            let report = "job=\(job.prefix(8)) server=\(server) local=\(stoppedStatus?.rawValue ?? "nil")→\(finalStatus?.rawValue ?? "nil") 面=停止の結果:\(cancelledShown) 成功に変わった:\(sawSuccess)"
            // backend が先に終わっていたら（COMPLETED）取り消しは 409 で届かない。それは「取り消せた」ではない。
            if server == "COMPLETED" { print("SELFTEST_SKIP aistop: 止める前に backend が終わっていた \(report)"); exit(0) }
            let ok = ["CANCELLED", "CANCELLING"].contains(server) && finalStatus == .failed && cancelledShown && !sawSuccess
            print((ok ? "SELFTEST_OK" : "SELFTEST_FAIL") + " aistop: " + report)
            exit(ok ? 0 : 2)
        } catch { print("SELFTEST_FAIL aistop error=\(error)"); exit(3) }
    }
}
