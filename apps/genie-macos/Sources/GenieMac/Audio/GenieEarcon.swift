import AVFoundation
import Foundation

/// 会話の始まりと終わりの短い音。その場で合成する（素材ファイル・通信なし）。
/// 1 つの正弦波が滑らかに上がる（始まり）／下がる（終わり）。スイッチを入れる・切る合図で、通知音より控えめにする。
/// 2026-09-30 に本人が 3 案（いまの 2 音 / 低い 2 音 / 1 音のグライド）を実機で聴き比べて選んだ。
/// macOS の「ユーザインターフェイスのサウンドエフェクトを再生」がオフなら鳴らさない。
@MainActor
enum GenieEarcon {
    enum Kind { case start, end }

    static let sampleRate = 44_100.0
    /// 動く範囲（Hz）と長さ（秒）。高さは指数で動かす（耳には等速に聞こえる）。
    static let low = 660.0, high = 990.0
    static let length = 0.18
    static let gain = 0.20

    private static var players: [AVAudioPlayer] = []

    static func play(_ kind: Kind) {
        guard uiSoundsEnabled, let player = try? AVAudioPlayer(data: wav(kind)) else { return }
        players.removeAll { !$0.isPlaying }
        players.append(player)
        player.play()
    }

    /// システム設定の UI サウンド（未設定なら有効）。
    static var uiSoundsEnabled: Bool {
        UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?["com.apple.sound.uiaudio.enabled"] as? Bool ?? true
    }

    /// 16-bit mono PCM の samples（検査で形を確かめる）。
    static func samples(_ kind: Kind) -> [Int16] {
        let (from, to) = kind == .start ? (low, high) : (high, low)
        let n = Int(length * sampleRate)
        var phase = 0.0
        return (0..<n).map { k in
            let t = Double(k) / sampleRate
            phase += 2 * .pi * from * pow(to / from, t / length) / sampleRate
            let attack = min(1, t / 0.008)                // 8ms で立ち上げる（クリック音を出さない）
            let release = min(1, (length - t) / 0.06)     // 最後の 60ms で静かに閉じる
            return Int16(max(-1, min(1, sin(phase) * attack * release * gain)) * Double(Int16.max))
        }
    }

    static func wav(_ kind: Kind) -> Data {
        let pcm = samples(kind)
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(pcm.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes)
        d.append(contentsOf: Array("WAVEfmt ".utf8)); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate) * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(bytes)
        for s in pcm { u16(UInt16(bitPattern: s)) }
        return d
    }
}
