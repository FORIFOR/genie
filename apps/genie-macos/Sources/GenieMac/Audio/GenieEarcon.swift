import AVFoundation
import Foundation

/// 会話の始まりと終わりの短い音。その場で合成する（素材ファイル・通信なし）。
/// 始まりは 2 音の上行（A5 → E6）、終わりは同じ 2 音の下行。柔らかい立ち上がりと減衰で、通知音より控えめにする。
/// macOS の「ユーザインターフェイスのサウンドエフェクトを再生」がオフなら鳴らさない。
@MainActor
enum GenieEarcon {
    enum Kind { case start, end }

    static let sampleRate = 44_100.0
    /// 2 音の高さ（Hz）と、2 音目の遅れ（秒）。
    static let low = 880.0, high = 1318.5
    static let stagger = 0.075
    static let noteLength = 0.20
    static let gain = 0.22

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
        let notes = kind == .start ? [low, high] : [high, low]
        let total = Int((stagger + noteLength) * sampleRate)
        var out = [Double](repeating: 0, count: total)
        for (i, f) in notes.enumerated() {
            let start = Int(Double(i) * stagger * sampleRate)
            let n = Int(noteLength * sampleRate)
            for k in 0..<n where start + k < total {
                let t = Double(k) / sampleRate
                let attack = min(1, t / 0.006)            // 6ms で立ち上げる（クリック音を出さない）
                let decay = exp(-t * 18)                  // 余韻は短く
                let tone = sin(2 * .pi * f * t) + 0.18 * sin(4 * .pi * f * t)
                out[start + k] += tone * attack * decay
            }
        }
        // 最後の 4ms を 0 へ閉じる。
        let tail = Int(0.004 * sampleRate)
        for k in 0..<tail { out[total - 1 - k] *= Double(k) / Double(tail) }
        return out.map { Int16(max(-1, min(1, $0 * gain)) * Double(Int16.max)) }
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
