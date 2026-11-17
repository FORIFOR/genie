import Foundation
import LiveKitWakeWord

/// 「声を覚える」で録った呼びかけの形（分類器が見る `16 × 96` の embedding）。
///
/// 待ち受けは、分類器が起きると決めた窓をこれと比べ、似ていなければ起きない。周りの会話やテレビの声は
/// 分類器だけだと 0.98〜1.00 が出ることがあり、誤って起きていた（genie.log 2026-10-18〜19、32 回起きて
/// 本人が呼んだのは 6 回ほど）。比べるのは主に「ジーニー」の言い方なので、ほかの人の声でもおおむね通る。
/// 測った値（2026-10-19、合成音 Kyoko の 8 回で覚え、`--selftest wakemodel` に流した。覚えないとき → 覚えたとき）:
/// 本人の呼びかけ 24/24 → 24/24、ほかの 8 声の呼びかけ 93/192 → 86/192、ふつうの文 7/200 → 1/200、
/// 実際の誤反応の録音（wake/false）21/41 → 1/41。20 回で覚えても同じだった。
/// 端末の中にだけ置く（`~/Library/Application Support/Genie/wake/voiceprint.json`、0600）。声そのものは入らない。
struct WakeVoicePrint: Codable, Equatable {
    var schema = 1
    /// 単位長にした embedding（1 回の呼びかけにつき 1 つ）。
    let templates: [[Float]]
    /// これ以上似ていれば通す。録った呼びかけどうしの似かたから決める（`make`）。
    let threshold: Float
    let createdAt: Date

    static let dimension = 16 * 96
    /// 覚えるのに要る呼びかけの数（8 回のうち、合図に合わせて言えたもの）。
    static let minimumCalls = 5
    /// しきい値の上限と下限。上限は合成音と実際の誤反応の録音で選んだ値（上の割合）。
    static let ceiling: Float = 0.83
    static let floor: Float = 0.78
    /// 録った呼びかけどうしの似かた（下から 4 分の 1）から引く余裕。後日・別の距離で呼んだときの揺れの分。
    static let margin: Float = 0.02

    static var url: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Genie/wake/voiceprint.json")
    }

    /// いちばん似ている呼びかけとの似かた（cosine）。形が違えば 0。
    func similarity(_ embedding: [Float]) -> Float {
        guard embedding.count == Self.dimension else { return 0 }
        let unit = Self.normalized(embedding)
        return templates.reduce(Float(0)) { best, t in max(best, zip(t, unit).reduce(0) { $0 + $1.0 * $1.1 }) }
    }

    /// 呼びかけの embedding から作る。数が足りなければ nil。
    static func make(embeddings: [[Float]], now: Date = Date()) -> WakeVoicePrint? {
        let templates = embeddings.filter { $0.count == dimension }.map(normalized)
        guard templates.count >= minimumCalls else { return nil }
        // 1 つずつ外して、残りとの最大の似かたを見る（後日の呼びかけが、覚えた呼びかけにどれだけ似るかの見積り）。
        let others = templates.indices.map { i in
            templates.indices.filter { $0 != i }.map { j in zip(templates[i], templates[j]).reduce(Float(0)) { $0 + $1.0 * $1.1 } }.max() ?? 0
        }.sorted()
        // 下から 1 割だと、8 回のときは最も外れた 1 回で決まり、下限まで緩んだ（ふつうの文 6/200、誤反応 4/41）
        let low = others[others.count / 4]
        return WakeVoicePrint(templates: templates, threshold: min(ceiling, max(floor, low - margin)), createdAt: now)
    }

    static func normalized(_ v: [Float]) -> [Float] {
        let n = sqrt(v.reduce(0) { $0 + $1 * $1 })
        return n > 0 ? v.map { $0 / n } : v
    }

    static func load(from url: URL = WakeVoicePrint.url) -> WakeVoicePrint? {
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode(WakeVoicePrint.self, from: data),
              value.schema == 1, value.templates.count >= minimumCalls,
              value.templates.allSatisfy({ $0.count == dimension && $0.allSatisfy(\.isFinite) }),
              (floor...ceiling).contains(value.threshold) else { return nil }
        return value
    }

    func save(to url: URL = WakeVoicePrint.url) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// 録音（合図の 1 秒後から `interval` 秒ごと）を 1 回ずつに切る。合図音の 0.25 秒は使わない。
    /// tools/wakeword/train.py の `enrollment_clips` と同じ切り方。
    static func calls(in audio: [Float], count: Int, first: Double = 1.0, interval: Double) -> [[Float]] {
        let rate = 16_000.0, frame = 160
        return (0..<count).compactMap { k in
            let s0 = Int((first + interval * Double(k) + 0.25) * rate), s1 = Int((first + interval * Double(k + 1)) * rate)
            guard s1 <= audio.count, s1 - s0 >= Int(rate) else { return nil }
            let seg = Array(audio[s0..<s1])
            let energy = stride(from: 0, to: seg.count - frame, by: frame).map { i in
                sqrt(seg[i..<i + frame].reduce(0) { $0 + $1 * $1 } / Float(frame))
            }
            guard let top = energy.max(), top >= 0.01 else { return nil }
            let loud = energy.indices.filter { energy[$0] > max(0.008, top * 0.15) }
            guard let a = loud.first, let b = loud.last else { return nil }
            return Array(seg[(a * frame)..<min(seg.count, (b + 1) * frame)])
        }
    }

    /// 1 回の呼びかけを前後に無音を足して流し、言い終えてから 1 秒以内の窓で分類器の点がいちばん高いものの
    /// embedding を返す。点が `minimumScore` に届かなければ覚えない: 分類器が「ジーニー」と聞かない窓を覚えると、
    /// 言葉ではなく声色で似てしまう（合成音 Reed で試したとき、ふつうの文 200 本のうち 13 本で起きた）。
    /// 待ち受けと同じ 2 秒・0.2 秒ずつで見る。
    static func embedding(of call: [Float], model: WakeWordModel, name: String) -> [Float]? {
        let window = LiveKitWakeDetector.windowSamples, step = LiveKitWakeDetector.stride
        let pad = [Float](repeating: 0, count: window)
        let audio = (pad + call + [Float](repeating: 0, count: 16_000)).map { Int16(max(-1, min(1, $0)) * Float(Int16.max)) }
        let ended = window + call.count
        var best: (score: Float, embedding: [Float])?
        for end in stride(from: ended, through: min(audio.count, ended + 16_000), by: step) {
            guard let out = try? model.predictDetailed(Array(audio[(end - window)..<end])),
                  let score = out.scores[name], out.embeddings.count == dimension else { continue }
            if score > (best?.score ?? -1) { best = (score, out.embeddings) }
        }
        guard let best, best.score >= minimumScore else { return nil }
        return best.embedding
    }

    static let minimumScore: Float = 0.5
}
