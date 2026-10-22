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
        /// サーバの id（設定で消すときに使う）。古い控えには無い。
        var id: String? = nil
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
        let (base, token, recent) = lock.withLock {
            (self.base, self.token, lastFetch.map { Date().timeIntervalSince($0) < 60 } ?? false)
        }
        guard let base, let token, force || !recent, let url = URL(string: "\(base)/v1/vocabulary") else { return }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let fetched = DictationVocabulary.decode(data) else { return }
        let changed = lock.withLock {
            lastFetch = Date()
            defer { current = fetched }
            return fetched != current
        }
        if changed {
            save(fetched)
            DispatchQueue.main.async { NotificationCenter.default.post(name: Self.changed, object: nil) }
        }
    }

    /// 控えが変わった（設定の一覧を描き直す）。
    static let changed = Notification.Name("genie.dictationVocabulary.changed")

    /// 設定から登録する（同じ聞こえ方は書き方を上書き）。登録できたら控えも取り直す。
    func add(spoken: String, written: String) async -> String? {
        let spoken = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        let written = written.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return "聞こえ方を入れてください。" }
        guard let api = backend else { return "Genie につながっていません。" }
        let result = await api.call("POST", "/v1/vocabulary",
                                    body: ["spoken": spoken, "written": written.isEmpty ? spoken : written])
        switch result?.status {
        case 200, 201: await refresh(force: true); return nil
        case 409: return "辞書がいっぱいです。使わないものを消してから登録してください。"
        default: return "登録できませんでした。"
        }
    }

    func remove(_ entry: DictationVocabulary.Entry) async -> String? {
        guard let id = entry.id, let api = backend else { return "Genie につながっていません。" }
        let result = await api.call("DELETE", "/v1/vocabulary/\(id)")
        guard result?.status == 204 || result?.status == 404 else { return "消せませんでした。" }
        await refresh(force: true)
        return nil
    }

    private var backend: GatewayJSON? {
        lock.withLock { base.flatMap { b in token.map { GatewayJSON(base: b, token: $0) } } }
    }

    private func save(_ vocabulary: DictationVocabulary) {
        guard let data = try? JSONEncoder().encode(vocabulary) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}
