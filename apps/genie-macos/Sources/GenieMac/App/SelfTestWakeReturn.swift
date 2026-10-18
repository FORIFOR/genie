import Foundation

extension SelfTest {
    /// `--selftest wakereturn [回数]`: 実マイクで「会話（エコー除去あり）→ 終わり」を繰り返し、
    /// 毎回、待ち受けに音が戻るか（genie.log 2026-10-16 07:27Z・10-17 09:17Z、-10875 のあと翌日まで無反応）。
    @MainActor static func wakeReturn(_ args: [String]) async {
        setvbuf(stdout, nil, _IONBF, 0)
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP wakereturn"); exit(0) }
        let cycles = args.compactMap { Int($0) }.first ?? 12
        /// 開き直しに失敗しても、見張りの再試行（stallSeconds + 余裕）で戻るはずの上限。
        let limit = VoiceInputHub.stallSeconds + VoiceInputHub.stallRetrySeconds + 6
        final class Counter: WakeDetector {
            let lock = NSLock(); var frames = 0
            func process(_ frame: [Float]) -> Bool { lock.lock(); frames += 1; lock.unlock(); return false }
            func reset() {}
            var count: Int { lock.lock(); defer { lock.unlock() }; return frames }
        }
        let counter = Counter()
        let hub = VoiceInputHub()
        do { try hub.startStandby(detector: counter, onWake: {}) } catch {
            print("SELFTEST_FAIL wakereturn: standby did not start: \(error)"); exit(1)
        }
        var failed = 0
        var slow = 0
        for i in 1...cycles {
            _ = try? hub.attach { _ in }
            hub.setEchoCancellation(true)
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            hub.detach()
            let before = counter.count
            let start = Date()
            while counter.count < before + 20, Date().timeIntervalSince(start) < limit {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            let waited = Date().timeIntervalSince(start)
            let back = counter.count >= before + 20
            if !back { failed += 1 } else if waited > 1.5 { slow += 1 }
            print(String(format: "cycle %d: %@ after %.1f s (state %@)", i, back ? "listening" : "NO SOUND", waited, "\(hub.state)"))
        }
        hub.stopStandby()
        if failed > 0 {
            print("SELFTEST_FAIL wakereturn: \(failed)/\(cycles) cycles never heard the microphone again")
            exit(1)
        }
        print("SELFTEST_OK wakereturn (\(cycles) cycles, \(slow) recovered by the retry)")
        exit(0)
    }
}
