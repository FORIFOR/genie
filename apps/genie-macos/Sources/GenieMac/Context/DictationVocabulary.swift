import Foundation

/// 個人の辞書（「こう聞こえたら、こう書く」）。音声入力で入れる前に置き換え、認識の手がかりにも渡す。
///
/// 正本はサーバ（`GET /v1/vocabulary`。会話で「辞書に登録: ジーニーは Genie」と登録する）。
/// ここは取りに行って手元に控える（0600）。つながっていない間も、控えで置き換える。
/// **モデルは通さない。**決まった文字列を決まった文字列へ置き換えるだけ（`DictationCleanup` と同じ考え）。
struct DictationVocabulary: Equatable, Codable {
    struct Entry: Equatable, Codable {
        let spoken: String
        let written: String
    }

    var entries: [Entry] = []

    /// 置き換える。長い聞こえ方から順に、置き換えた結果をもう一度置き換えない（サーバの applyVocabulary と同じ規則）。
    func apply(_ text: String) -> String {
        let rules = entries.filter { !$0.spoken.isEmpty && $0.spoken != $0.written }
            .sorted { $0.spoken.count > $1.spoken.count }
        guard !rules.isEmpty else { return text }
        let pattern = rules.map { NSRegularExpression.escapedPattern(for: $0.spoken) }.joined(separator: "|")
        guard let re = try? NSRegularExpression(pattern: pattern) else { return text }
        let lookup = Dictionary(rules.map { ($0.spoken, $0.written) }, uniquingKeysWith: { first, _ in first })
        let ns = text as NSString
        var out = ""
        var cursor = 0
        for match in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let found = ns.substring(with: match.range)
            out += lookup[found] ?? found
            cursor = match.range.location + match.range.length
        }
        out += ns.substring(from: cursor)
        return out
    }

    /// 認識の手がかり（`SFSpeechRecognitionRequest.contextualStrings`）。聞こえ方を渡す
    /// （置き換えはそのあとで行うので、認識器には「こう聞き取ってほしい」語を渡す）。URL のような長い文は渡さない。
    var hints: [String] {
        var seen = Set<String>()
        return entries.map(\.spoken).filter { $0.count <= 30 && seen.insert($0).inserted }.prefix(100).map { $0 }
    }

    static func decode(_ data: Data) -> DictationVocabulary? {
        struct Response: Decodable { let items: [Entry] }
        guard let items = try? JSONDecoder().decode(Response.self, from: data).items else { return nil }
        return DictationVocabulary(entries: items)
    }
}

/// 辞書の控え。音声認識のスレッドからも読むので、読み書きは鍵で守る。
final class DictationVocabularyStore: @unchecked Sendable {
    static let shared = DictationVocabularyStore()

    private let lock = NSLock()
    private var current: DictationVocabulary
    private let fileURL: URL
    private var base: String?
    private var token: String?
    private var lastFetch: Date?

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? LocalStore.dataRoot.appendingPathComponent("dictation-vocabulary.json")
        if let data = try? Data(contentsOf: self.fileURL),
           let saved = try? JSONDecoder().decode(DictationVocabulary.self, from: data) {
            current = saved
        } else {
            current = DictationVocabulary()
        }
    }

    var vocabulary: DictationVocabulary {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    func apply(_ text: String) -> String { vocabulary.apply(text) }
    var hints: [String] { vocabulary.hints }

    func configureBackend(base: String, token: String) {
        lock.lock(); self.base = base; self.token = token; lock.unlock()
        Task { await refresh(force: true) }
    }

    /// 取りに行く（1 分に 1 回まで。会話で登録した直後に効かせたいときは `force`）。
    func refresh(force: Bool = false) async {
        lock.lock()
        let base = self.base, token = self.token
        let recent = lastFetch.map { Date().timeIntervalSince($0) < 60 } ?? false
        lock.unlock()
        guard let base, let token, force || !recent, let url = URL(string: "\(base)/v1/vocabulary") else { return }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let fetched = DictationVocabulary.decode(data) else { return }
        lock.lock()
        lastFetch = Date()
        let changed = fetched != current
        current = fetched
        lock.unlock()
        if changed { save(fetched) }
    }

    private func save(_ vocabulary: DictationVocabulary) {
        guard let data = try? JSONEncoder().encode(vocabulary) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}
