import AVFoundation
import Foundation

/// マイク取り込み（AVAudioEngine）。tap の f32 サンプルを 16 kHz mono へ変換して渡す。
///
/// **注意**: ライブ取り込みは署名済み .app + マイク許可(TCC)が要る。SwiftPM の裸実行では
/// 許可プロンプトが出ないため headless では動かない。ここは実装であり、実許可の検証は .app 側で。
final class MicCapture {
    private var engine = AVAudioEngine()
    /// 同じ engine で鳴らす再生（Gemini の声）。**同じ engine で鳴らした音だけ**がエコー除去で消える。
    /// エコー除去を切り替えると engine ごと作り直すので、再生の node も替わる（使う側は毎回ここから取る）。
    private(set) var player = AVAudioPlayerNode()
    static let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    private var playerConnected = false
    private let targetRate: Double = 16_000
    /// 直近の start でエコー除去（voice processing）が実際に効いたか。頼んだかではなく、効いたか。
    private(set) var voiceProcessingActive = false

    /// 16 kHz mono の f32 フレームを繰り返し渡す。
    ///
    /// `echoCancellation`: 会話で Genie の声を自分のマイクに入れないためのエコー除去。
    /// 有効にできなければ**従来の取り込みに戻す**（失敗で音声を止めない）。会議の録音では使わない
    /// （相手の声を消す処理を録音に挟まない）。
    func start(echoCancellation: Bool = false, onFrame: @escaping ([Float]) -> Void) throws {
        // 再生をつないでから voice processing を有効にする（逆だと出力の初期化が -10875 で失敗するか固まる。
        // --selftest aecvariants、2026-10-05）。
        if !playerConnected {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: Self.playbackFormat)
            playerConnected = true
        }
        voiceProcessingActive = false
        if engine.inputNode.isVoiceProcessingEnabled != echoCancellation {
            // 動いていた engine の切り替えでは、再生の接続が壊れて鳴らなくなった（--selftest hubecho で固まる）。
            // engine ごと作り直し、再生をつないでから voice processing を切り替える。
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            engine = AVAudioEngine()
            player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: Self.playbackFormat)
        }
        let input = engine.inputNode
        if input.isVoiceProcessingEnabled != echoCancellation {
            do {
                try input.setVoiceProcessingEnabled(echoCancellation)
            } catch {
                NSLog("mic: voice processing \(echoCancellation ? "on" : "off") failed: \(error)")
                if input.isVoiceProcessingEnabled { try? input.setVoiceProcessingEnabled(false) }
            }
        }
        voiceProcessingActive = input.isVoiceProcessingEnabled
        // エコー除去の間、ほかのアプリの音（配信・動画・音楽）を下げない（macOS の既定は大きく下げる）。
        if voiceProcessingActive {
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }
        // 有効にすると入力の形式が変わる。形式は切り替えの後に読む。
        let inFormat = input.outputFormat(forBus: 0)
        guard
            let outFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: targetRate, channels: 1, interleaved: false)
        else { throw NSError(domain: "MicCapture", code: 1) }
        // voice processing の入力は多チャンネル（この Mac で 9ch）で、処理済みの声は 1 本目。1 本目だけを使う
        // （全チャンネルを混ぜる変換では無音になっていた）。
        guard let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inFormat.sampleRate,
                                             channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: monoFormat, to: outFormat) else {
            throw NSError(domain: "MicCapture", code: 2)
        }

        // 前の取り込みの tap が残っていたら外す（同じ bus に二重に付けると例外で落ちる）。
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] raw, _ in
            guard let self, let source = raw.floatChannelData,
                  let buffer = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: raw.frameLength) else { return }
            buffer.frameLength = raw.frameLength
            buffer.floatChannelData![0].update(from: source[0], count: Int(raw.frameLength))
            let capacity = AVAudioFrameCount(
                Double(buffer.frameLength) * self.targetRate / inFormat.sampleRate + 1)
            guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity)
            else { return }
            var error: NSError?
            var fed = false
            converter.convert(to: out, error: &error) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            if let ch = out.floatChannelData, out.frameLength > 0 {
                onFrame(Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength))))
            }
        }
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    /// 起動を速くするため、資源だけ先に確保する。**IO は始めない・許可も求めない**
    /// （呼ぶ側がマイク許可済みのときだけ呼ぶ）。実測: 新しい engine は start に 200〜770ms、
    /// prepare 済みなら 77ms、止めた engine の再 start は 47〜170ms。最初のバッファは start の +100ms。
    func prewarm() {
        _ = engine.inputNode
        engine.prepare()
    }
}
