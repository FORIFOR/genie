import Foundation

/// 音声入力の履歴。入れた文を**この Mac の中だけ**に残し、設定から見返して写せるようにする。
///
/// - 残すのは欄に入れられた文（置き換えた後）と、置き換える前の文、入れた先のアプリ名、時刻だけ。音声は残さない。
/// - 外へは送らない。ファイルは 0600（`dictation-history.json`）。7 日を過ぎたものと、100 件を超えた古いものは消す。
/// - 設定で止められる。止めたら、それまでの履歴も消す。パスワード欄に入れた文は残さない。
/// - 記録（`dictation.log`）には、これまでどおり文そのものを書かない。
final class DictationHistory: @unchecked Sendable {
    static let shared = DictationHistory()
    static let changed = Notification.Name("genie.dictationHistory.changed")
    static let enabledKey = "genie.dictationHistory.enabled"
    static let maxItems = 100
    static let maxAge: TimeInterval = 7 * 24 * 3600

    struct Item: Codable, Equatable, Identifiable {
        let id: String
        let at: Date
        let text: String
        /// 置き換える前（言い淀みの除去・辞書の前）。同じなら nil。
        let original: String?
        let app: String
    }

    private let lock = NSLock()
    private let fileURL: URL
    private let defaults: UserDefaults
    private let now: () -> Date
    private var items: [Item]

    init(fileURL: URL? = nil, defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.fileURL = fileURL ?? LocalStore.dataRoot.appendingPathComponent("dictation-history.json")
        self.defaults = defaults
        self.now = now
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        items = (try? Data(contentsOf: self.fileURL)).flatMap { try? decoder.decode([Item].self, from: $0) } ?? []
    }

    /// 既定は残す（本人が 2026-10-21 に承認）。
    var enabled: Bool {
        defaults.object(forKey: Self.enabledKey) as? Bool ?? true
    }

    func setEnabled(_ on: Bool) {
        defaults.set(on, forKey: Self.enabledKey)
        if !on { clear() }
    }

    /// 新しい順。
    var recent: [Item] {
        lock.lock(); defer { lock.unlock() }
        return pruned(items).reversed()
    }

    func record(text: String, original: String, app: String, secureField: Bool) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard enabled, !secureField, !text.isEmpty else { return }
        let item = Item(id: UUID().uuidString, at: now(), text: text,
                        original: original == text ? nil : original, app: app)
        lock.lock()
        items = pruned(items + [item])
        let snapshot = items
        lock.unlock()
        save(snapshot)
    }

    func clear() {
        lock.lock(); items = []; lock.unlock()
        try? FileManager.default.removeItem(at: fileURL)
        notify()
    }

    private func pruned(_ list: [Item]) -> [Item] {
        let cutoff = now().addingTimeInterval(-Self.maxAge)
        return Array(list.filter { $0.at >= cutoff }.suffix(Self.maxItems))
    }

    private func save(_ list: [Item]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(list) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        notify()
    }

    private func notify() {
        DispatchQueue.main.async { NotificationCenter.default.post(name: Self.changed, object: nil) }
    }
}
