import AVFoundation
import Foundation

/// マイク取り込み（AVAudioEngine）。tap の f32 サンプルを 16 kHz mono へ変換して渡す。
///
/// **注意**: ライブ取り込みは署名済み .app + マイク許可(TCC)が要る。SwiftPM の裸実行では
/// 許可プロンプトが出ないため headless では動かない。ここは実装であり、実許可の検証は .app 側で。
final class MicCapture {
    private let engine = AVAudioEngine()
    private let targetRate: Double = 16_000
    /// 直近の start でエコー除去（voice processing）が実際に効いたか。頼んだかではなく、効いたか。
    private(set) var voiceProcessingActive = false

    /// 16 kHz mono の f32 フレームを繰り返し渡す。
    ///
    /// `echoCancellation`: 会話で Genie の声を自分のマイクに入れないためのエコー除去。
    /// 有効にできなければ**従来の取り込みに戻す**（失敗で音声を止めない）。会議の録音では使わない
    /// （相手の声を消す処理を録音に挟まない）。
    func start(echoCancellation: Bool = false, onFrame: @escaping ([Float]) -> Void) throws {
        let input = engine.inputNode
        voiceProcessingActive = false
        if input.isVoiceProcessingEnabled != echoCancellation {
            // 切り替えは止めて初期化を解いた engine でしか効かない（prepare 済みだと -10849 で断られる）。
            engine.stop()
            engine.reset()
            do {
                try input.setVoiceProcessingEnabled(echoCancellation)
            } catch {
                NSLog("mic: voice processing \(echoCancellation ? "on" : "off") failed: \(error)")
                if input.isVoiceProcessingEnabled { try? input.setVoiceProcessingEnabled(false) }
            }
        }
        voiceProcessingActive = input.isVoiceProcessingEnabled
        // 有効にすると入力の形式が変わる。形式は切り替えの後に読む。
        let inFormat = input.outputFormat(forBus: 0)
        guard
            let outFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: targetRate, channels: 1, interleaved: false)
        else { throw NSError(domain: "MicCapture", code: 1) }
        guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
            throw NSError(domain: "MicCapture", code: 2)
        }

        // 前の取り込みの tap が残っていたら外す（同じ bus に二重に付けると例外で落ちる）。
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
            guard let self else { return }
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
