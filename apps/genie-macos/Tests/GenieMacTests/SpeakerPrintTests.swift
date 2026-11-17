import XCTest
@testable import GenieMac

final class SpeakerPrintTests: XCTestCase {
    static let model = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Resources/wake/speaker_ecapa_int8.onnx")

    func chirp(_ base: Float, seconds: Double = 0.8) -> [Float] {
        (0..<Int(seconds * 16_000)).map { i in let t = Float(i) / 16_000; return 0.2 * sin(2 * .pi * (base + 300 * t) * t) }
    }

    func testProfileIsTheNormalizedMeanAndRoundTripsPrivately() throws {
        var a = [Float](repeating: 0, count: 192); a[0] = 2
        var b = [Float](repeating: 0, count: 192); b[1] = 3
        let print = try XCTUnwrap(SpeakerPrint.make(embeddings: [a, b, [1, 2]]))
        XCTAssertEqual(print.calls, 2)   // 次元の違うものは数えない
        XCTAssertEqual(print.profile[0], 0.7071, accuracy: 1e-3)
        XCTAssertEqual(print.similarity(a), 0.7071, accuracy: 1e-3)
        XCTAssertEqual(print.similarity([1, 2]), 0)
        XCTAssertNil(SpeakerPrint.make(embeddings: []))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("speaker-\(UUID()).json")
        try print.save(to: url)
        XCTAssertEqual(SpeakerPrint.load(from: url), print)
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
    }

    func testVoicedCutKeepsTheLastFrameSoCuttingTwiceChangesNothing() throws {
        let call = chirp(220)
        let audio = [Float](repeating: 0, count: 8_000) + call + [Float](repeating: 0, count: 8_000)
        let once = try XCTUnwrap(SpeakerEncoder.voiced(audio))
        XCTAssertEqual(SpeakerEncoder.voiced(once), once)
        XCTAssertNil(SpeakerEncoder.voiced([Float](repeating: 0, count: 32_000)))   // 声が無い
        // 声の 0.7 秒後の物音は入れない（本人の録音で、入ると 2.5 秒に伸びて 2 回の呼びかけが似なくなった）
        let bump = (0..<1_600).map { i in 0.03 * sin(Float(i) * 0.3) }
        let noisy = [Float](repeating: 0, count: 8_000) + call + [Float](repeating: 0, count: 11_200) + bump + [Float](repeating: 0, count: 8_000)
        XCTAssertEqual(SpeakerEncoder.voiced(noisy)?.count, once.count)
        XCTAssertNil(SpeakerEncoder.voiced(Array(call.prefix(3_000))))             // 短すぎる
    }

    func testEncoderGivesUnitLengthFeaturesAndEnrollmentLearnsTheCalls() throws {
        let encoder = try SpeakerEncoder(modelURL: Self.model)
        let v = try encoder.embed(chirp(220, seconds: 2))
        XCTAssertEqual(v.count, SpeakerPrint.dimension)
        XCTAssertEqual(sqrt(v.reduce(0) { $0 + $1 * $1 }), 1, accuracy: 1e-3)
        // 「声を覚える」と同じ並び: 1 秒の後、3 秒ごとに 1 回（合図の 0.3 秒後に言う）
        func slot(_ call: [Float]) -> [Float] { [Float](repeating: 0, count: 4_800) + call + [Float](repeating: 0, count: 48_000 - 4_800 - call.count) }
        let audio = [Float](repeating: 0, count: 16_000) + slot(chirp(220)) + slot(chirp(230))
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("speaker-\(UUID()).json")
        let learned = try XCTUnwrap(WakeEnrollment.learnSpeaker(audio, count: 2, encoder: encoder, saveTo: out))
        XCTAssertEqual(learned.calls, 2)
        XCTAssertEqual(SpeakerPrint.load(from: out), learned)
        // 待ち受けの窓（2 秒、前に無音）から同じ呼びかけを切り出して比べると、よく似る
        let window = [Float](repeating: 0, count: 32_000 - 12_800) + chirp(220)
        XCTAssertGreaterThan(learned.similarity(try XCTUnwrap(encoder.embedding(of: window))), SpeakerPrint.threshold)
    }

    func testUnsureCallIsConfirmedWithWhatFollows() throws {
        XCTAssertLessThan(SpeakerPrint.unsure, SpeakerPrint.threshold)
        // 特徴は差し替える（見分ける力は LibriSpeech と本人の録音で測った。ここは渡し方だけを確かめる）
        var me = [Float](repeating: 0, count: 192); me[0] = 1
        var other = [Float](repeating: 0, count: 192); other[1] = 1
        let print = try XCTUnwrap(SpeakerPrint.make(embeddings: [me]))
        let call = chirp(220)
        var seen: [Int] = []
        let embed: ([Float]) throws -> [Float] = { audio in
            seen.append(audio.count)
            return audio.last! > 0.15 ? me : other   // 続けて話した声の終わりで「誰か」を決める偽物
        }
        let silence = [Float](repeating: 0, count: 48_000)
        // 続けて話していない（名前だけ）なら決めない
        XCTAssertEqual(print.confirm(call: call, after: silence, embed: embed), .notEnoughVoice)
        XCTAssertEqual(seen, [])
        // 呼びかけの声と、続けて話した声のかたまりを合わせて確かめる
        let mine = [Float](repeating: 0, count: 8_000) + [Float](repeating: 0.2, count: 16_000) + [Float](repeating: 0, count: 8_000)
        XCTAssertEqual(print.confirm(call: call, after: mine, embed: embed), .enrolled(1))
        XCTAssertEqual(seen.last, call.count + 16_000)
        let theirs = [Float](repeating: 0, count: 8_000) + [Float](repeating: -0.2, count: 16_000) + [Float](repeating: 0, count: 8_000)
        XCTAssertEqual(print.confirm(call: call, after: theirs, embed: embed), .other(0))
    }
}
