import AppKit

/// `--selftest selfecho`: Genie の声が自分のマイクに入って、次の依頼にならないか（段階 3）。
///
/// 実機のスピーカーから実際に読み上げ、実際のマイクと音声認識で聞く。3 通り:
///   A 本番の形（半二重）: 読み上げを**終えてから**マイクを開き、2.5 秒聞く → 何も拾わなければ PASS
///   B 参考: 読み上げ中もマイクを開いたまま（エコー除去なし）→ 何を拾ったかを記録
///   C 参考: 読み上げ中もマイクを開いたまま（エコー除去あり）→ 何を拾ったか・除去が効いたかを記録
/// B と C は、話している途中で割り込める会話（barge-in）にしてよいかの材料で、合否には入れない。
extension SelfTest {
    @MainActor
    static func selfEcho() async {
        guard Permissions.microphone == .granted else { print("SELFTEST_SKIP selfecho: mic not granted"); exit(0) }
        guard SpeechTranscriber.authorization == .authorized else { print("SELFTEST_SKIP selfecho: speech recognition not authorized"); exit(0) }
        let sentence = "明日の東京は雨です。最高気温は二十二度の予報です。"
        let runtime = RecordingRuntime.shared

        func pause(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

        /// マイクを開いて、聞こえた文を集める。
        func listen(echoCancellation: Bool) -> (heard: () -> String, stop: () -> Bool) {
            var partial = "", finals: [String] = []
            let ok = runtime.beginVoiceListening(echoCancellation: echoCancellation,
                                                 onFirstFrame: {},
                                                 onPartial: { partial = $0 },
                                                 onFinal: { finals.append($0) })
            if !ok { print("SELFTEST_FAIL selfecho: could not open the microphone"); exit(2) }
            return ({ (finals + [partial]).filter { !$0.isEmpty }.joined(separator: " / ") },
                    { let vp = runtime.voiceEchoCancellationActive; runtime.endVoiceListening(); return vp })
        }

        /// 読み上げが終わるまで待つ（最大 15 秒）。
        func speakAndWait() async {
            var done = false
            GenieSpeechOutput.shared.read(sentence, owner: UUID()) { done = true }
            let deadline = Date().addingTimeInterval(15)
            while !done && Date() < deadline { await pause(0.1) }
        }

        // A: 半二重（本番）。読み終えてからマイクを開く。
        await speakAndWait()
        let a = listen(echoCancellation: true)
        await pause(2.5)
        let heardA = a.heard(); let vpA = a.stop()
        await pause(1.0)

        // B: 読み上げ中も開いたまま、除去なし。
        let b = listen(echoCancellation: false)
        await pause(0.8)
        await speakAndWait()
        await pause(1.5)
        let heardB = b.heard(); let vpBActual = b.stop()
        if vpBActual { print("SELFTEST_FAIL selfecho: the control could not turn echo cancellation off"); exit(2) }
        await pause(1.0)

        // C: 読み上げ中も開いたまま、除去あり。
        let c = listen(echoCancellation: true)
        await pause(0.8)
        await speakAndWait()
        await pause(1.5)
        let heardC = c.heard(); let vpC = c.stop()

        let report = "halfDuplex=\(heardA.isEmpty ? "clean" : "heard(\(heardA))") vpA=\(vpA) control(openMic noAEC vp=\(vpBActual))=\"\(heardB)\" openMic(AEC vp=\(vpC))=\"\(heardC)\""
        // 対照: 除去なしで読み上げ中に開いたマイクが、読み上げを拾えること。拾えないなら、
        // スピーカーの声がマイクに届いていない（音量・経路）ので、A の「何も拾わない」は何も示さない。
        guard !heardB.isEmpty else {
            print("SELFTEST_SKIP selfecho: inconclusive — the control heard nothing, so the speaker does not reach the microphone here. \(report)")
            exit(0)
        }
        if heardA.isEmpty {
            print("SELFTEST_OK selfecho: \(report)")
            exit(0)
        }
        print("SELFTEST_FAIL selfecho: \(report)")
        exit(2)
    }
}
