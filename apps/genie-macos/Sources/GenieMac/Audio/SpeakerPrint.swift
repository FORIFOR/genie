import Foundation
import OnnxRuntimeBindings

/// 本人の声（「声を覚える」で録った呼びかけから作る、話者の特徴）。
///
/// 前の `WakeVoicePrint` は「ジーニー」の言い方の形を比べていたので、ほかの人の声でもおおむね通った
/// （ほかの 8 声の呼びかけ 86/192）。こちらは話者を見分けるモデル（ECAPA-TDNN）の 192 次元の特徴で比べる。
/// 測った値（2026-10-20、`tools/speaker`）:
/// - LibriSpeech の 80 人（CC BY 4.0）。2 秒の声・2 回で覚えたとき、しきい値 0.42 で本人 95.6%・他人 0.11%
///   （int8 のこのモデルで。元の PyTorch 版は 95.8%・0.09%）。1 秒の声だと本人は 77〜83% に落ちる
/// - 実際の誤反応の録音（wake/false、48 本）は、本人の声で作った特徴と比べていちばん高くて 0.395
/// 端末の中にだけ置く（`~/Library/Application Support/Genie/wake/speaker.json`、0600）。声そのものは入らない。
struct SpeakerPrint: Codable, Equatable {
    var schema = 1
    /// 覚えた呼びかけの特徴の平均（単位長）。
    let profile: [Float]
    /// 覚えた呼びかけの数。
    let calls: Int
    let createdAt: Date

    static let dimension = 192
    /// これ以上似ていれば本人。上の測定で選んだ（0.38 だと誤反応の録音 1 本が通る）。
    static let threshold: Float = 0.42
    /// これ以上・`threshold` 未満は迷う点。起きて、続けて話した声も合わせて確かめ直す（`confirm`）。
    /// 誤反応の録音（wake/false）は、本人の声の特徴と比べて 0.29 を超えたのが 55 本中 1 本（0.41）。
    static let unsure: Float = 0.30

    enum Confirmation: Equatable { case enrolled(Float), other(Float), notEnoughVoice }

    /// 迷う点で起きたとき: 呼びかけの声と、続けて話した声（いちばん大きいかたまり）を合わせて確かめ直す。
    /// 続けて話していなければ（名前だけ）決めない。合わせると 1 秒を超え、本人の声が似やすくなる
    /// （LibriSpeech、2 回で覚えたとき: 1 秒の声で本人 77〜83% → 2 秒で 97〜98%）。
    func confirm(call: [Float], after: [Float], embed: ([Float]) throws -> [Float]) -> Confirmation {
        guard let more = SpeakerEncoder.voiced(after), let embedding = try? embed(call + more) else {
            return .notEnoughVoice
        }
        let s = similarity(embedding)
        return s >= Self.threshold ? .enrolled(s) : .other(s)
    }

    static var url: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Genie/wake/speaker.json")
    }

    func similarity(_ embedding: [Float]) -> Float {
        guard embedding.count == Self.dimension else { return 0 }
        return zip(profile, WakeVoicePrint.normalized(embedding)).reduce(0) { $0 + $1.0 * $1.1 }
    }

    /// 呼びかけの特徴から作る。1 つも無ければ nil。
    static func make(embeddings: [[Float]], now: Date = Date()) -> SpeakerPrint? {
        let usable = embeddings.filter { $0.count == dimension && $0.allSatisfy(\.isFinite) }.map(WakeVoicePrint.normalized)
        guard !usable.isEmpty else { return nil }
        let sum = usable.reduce([Float](repeating: 0, count: dimension)) { zip($0, $1).map(+) }
        return SpeakerPrint(profile: WakeVoicePrint.normalized(sum), calls: usable.count, createdAt: now)
    }

    static func load(from url: URL = SpeakerPrint.url) -> SpeakerPrint? {
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode(SpeakerPrint.self, from: data),
              value.schema == 1, value.calls >= 1, value.profile.count == dimension,
              value.profile.allSatisfy(\.isFinite) else { return nil }
        return value
    }

    func save(to url: URL = SpeakerPrint.url) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

/// 声から話者の特徴（192 次元・単位長）を出す。モデルは `speaker_ecapa_int8.onnx`
/// （speechbrain/spkrec-ecapa-voxceleb、Apache-2.0。16 kHz の波形を受け、Fbank・正規化もモデルの中。
/// 作り方は `tools/speaker/export_onnx.py`）。2 秒の声で 27 ms（2 スレッド、M 系）。
final class SpeakerEncoder {
    static let modelName = "speaker_ecapa_int8"
    /// これより短い声からは特徴を出さない（短すぎると本人でも似なくなる）。
    static let minimumSamples = 4_800   // 0.3 秒

    private let env: ORTEnv
    private let session: ORTSession

    init(modelURL: URL) throws {
        env = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        try options.setIntraOpNumThreads(2)
        session = try ORTSession(env: env, modelPath: modelURL.path, sessionOptions: options)
    }

    /// アプリ同梱のモデル。
    static func modelURL() -> URL? { Bundle.main.url(forResource: modelName, withExtension: "onnx") }

    /// 声のある部分だけを切り出してから特徴を出す。声が短すぎれば nil。
    func embedding(of samples: [Float]) -> [Float]? {
        guard let voiced = Self.voiced(samples) else { return nil }
        return try? embed(voiced)
    }

    /// そのまま特徴を出す（切り出さない）。
    func embed(_ samples: [Float]) throws -> [Float] {
        let data = NSMutableData(length: samples.count * MemoryLayout<Float>.size)!
        samples.withUnsafeBufferPointer {
            data.mutableBytes.assumingMemoryBound(to: Float.self).update(from: $0.baseAddress!, count: samples.count)
        }
        let input = try ORTValue(tensorData: data, elementType: .float, shape: [1, NSNumber(value: samples.count)])
        let outputs = try session.run(withInputs: ["wav": input], outputNames: ["embedding"], runOptions: nil)
        guard let out = try outputs["embedding"]?.tensorData() else { return [] }
        let count = out.length / MemoryLayout<Float>.size
        return Array(UnsafeBufferPointer(start: out.bytes.assumingMemoryBound(to: Float.self), count: count))
    }

    /// 呼びかけの声のかたまりを切り出す。10 ms ごとの大きさで、いちばん大きい所から前後へ、声の大きさが続く所まで
    /// （`gapFrames` までの切れ目はつなぐ）。離れた物音は入れない: 「最初から最後まで」だと、声の 0.7 秒後の物音まで
    /// 入って 2.5 秒になり、同じ人の 2 回の呼びかけが 0.49 しか似なかった（本人の録音、2026-10-20）。
    /// 声の大きさの目安は、いちばん大きい所の 15% か、部屋の静かな所（下から 2 割）の 2.5 倍の大きい方。
    static func voiced(_ samples: [Float]) -> [Float]? {
        let frame = 160
        guard samples.count >= minimumSamples else { return nil }
        let energy = stride(from: 0, through: samples.count - frame, by: frame).map { i in
            sqrt(samples[i..<i + frame].reduce(0) { $0 + $1 * $1 } / Float(frame))
        }
        guard let top = energy.max(), top >= 0.01, let peak = energy.firstIndex(of: top) else { return nil }
        let floor = energy.sorted()[energy.count / 5]
        // 静かな所が無い（ずっと声）ときに目安が声を超えないよう、部屋の分はいちばん大きい所の半分まで
        let level = max(0.008, top * 0.15, min(floor * 2.5, top * 0.5))
        var a = peak, b = peak, gap = 0
        var i = peak - 1
        while i >= 0 {
            if energy[i] > level { a = i; gap = 0 } else { gap += 1; if gap > gapFrames { break } }
            i -= 1
        }
        gap = 0; i = peak + 1
        while i < energy.count {
            if energy[i] > level { b = i; gap = 0 } else { gap += 1; if gap > gapFrames { break } }
            i += 1
        }
        let cut = Array(samples[(a * frame)..<min(samples.count, (b + 1) * frame)])
        return cut.count >= minimumSamples ? cut : nil
    }

    /// 1 回の呼びかけの中の切れ目として許す長さ（「ねえ、ジーニー」の読点）。
    static let gapFrames = 25   // 0.25 秒
}
