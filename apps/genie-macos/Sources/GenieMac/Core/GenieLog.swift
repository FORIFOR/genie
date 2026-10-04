import Foundation
import OSLog

/// 声の会話の出来事を、端末の中のファイルに残す（呼びかけ・会話の始まりと終わり・送った依頼・返事）。
/// 「呼んでも続かない」「返事が無い」を後から確かめるため。外へは送らない。
///
/// 置き場所: `~/Library/Logs/Genie/genie.log`（本人だけが読める 0600）。
/// 1 MB を超えたら `genie.log.1` へ回し、それより古いものは残さない。
enum GenieLog {
    static let url: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Genie/genie.log")
    private static let limit = 1_000_000
    private static let queue = DispatchQueue(label: "genie.log")
    private static let os = Logger(subsystem: "com.astra.mac", category: "voice")
    private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// 発話の中身は先頭だけ残す（調べには足り、長い本文は残さない）。
    static func clip(_ text: String, _ count: Int = 40) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        return flat.count > count ? "\(flat.prefix(count))…" : flat
    }

    static func write(_ category: String, _ message: String) {
        os.info("\(category, privacy: .public) \(message, privacy: .private)")
        // 検査（--selftest・XCTest）の出来事は本人の記録に混ぜない。
        if ProcessInfo.processInfo.arguments.contains("--selftest") || NSClassFromString("XCTestCase") != nil { return }
        let line = "\(stamp.string(from: Date())) [\(category)] \(message)\n"
        queue.async { append(line) }
    }

    private static func append(_ line: String) {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > limit {
            let old = url.appendingPathExtension("1")
            try? fm.removeItem(at: old)
            try? fm.moveItem(at: url, to: old)
        }
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(line.utf8))
    }
}
