import Foundation

/// 近くの店を探すための Google Maps Platform のキーと、月の上限（検索の回数）。
/// **本人がキーを置き、上限を決めたときだけ**使う。
///
/// キーは本人のもの（Genie は共通のキーを持たない）。macOS のキーチェーンにだけ置き、アプリにもログにも出さない。
/// Places API (New) と Maps Static API を有効にしたキーを使う。1 回の検索 = Places 1 回＋地図 1 枚。
@MainActor
final class PlacesSettings: ObservableObject {
    static let shared = PlacesSettings()
    static let keychainKey = "googleMaps.apiKey"
    private static let limitKey = "genie.places.monthlySearches"
    private static let usedKey = "genie.places.usedSearches"
    private static let monthKey = "genie.places.month"

    @Published private(set) var hasKey: Bool
    @Published private(set) var monthlyLimit: Int
    @Published private(set) var used: Int
    private var month: String
    private let defaults: UserDefaults
    @Published private(set) var checkingKey = false
    @Published private(set) var keyAccessIssue: String?
    private let presenceReader: (@Sendable () throws -> Bool)?
    private var presenceTask: Task<Result<Bool, Error>, Never>?
    private var presenceGeneration = 0

    /// Fixtures can supply key presence without reading the person's Keychain.
    /// Normal construction never synchronously reads secret data on the main actor.
    init(defaults: UserDefaults = .standard, initialHasKey: Bool? = nil,
         presenceReader: (@Sendable () throws -> Bool)? = nil) {
        self.defaults = defaults
        monthlyLimit = defaults.integer(forKey: Self.limitKey)
        used = defaults.integer(forKey: Self.usedKey)
        month = defaults.string(forKey: Self.monthKey) ?? ""
        hasKey = initialHasKey ?? false
        let key = Self.keychainKey
        self.presenceReader = initialHasKey != nil && presenceReader == nil ? nil
            : (presenceReader ?? { try KeychainStore.contains(key) })
        if self.presenceReader != nil {
            checkingKey = true
            Task { [weak self] in await self?.refreshKeyPresence() }
        }
    }

    /// Coalesce settings appearances and explicit use; no key bytes enter this probe.
    func refreshKeyPresence() async {
        guard let read = presenceReader else { return }
        let task: Task<Result<Bool, Error>, Never>
        if let pending = presenceTask { task = pending }
        else {
            checkingKey = true; presenceGeneration += 1
            task = Task.detached { Result { try read() } }
            presenceTask = task
        }
        let generation = presenceGeneration
        let result = await task.value
        guard generation == presenceGeneration, presenceTask != nil else { return }
        presenceTask = nil; checkingKey = false
        switch result {
        case .success(let present): hasKey = present; keyAccessIssue = nil
        case .failure: hasKey = false; keyAccessIssue = KeychainStore.accessMessage
        }
    }

    /// 今月すでに使った回数（月が替わっていれば 0）。
    func usedThisMonth(at date: Date = Date()) -> Int { month == Self.monthLabel(date) ? used : 0 }

    /// 検索してよいか。キーと上限があり、今月の上限に達していないときだけ。
    func canSearch(at date: Date = Date()) -> Bool {
        hasKey && !checkingKey && keyAccessIssue == nil && monthlyLimit > 0 && usedThisMonth(at: date) < monthlyLimit
    }

    func setMonthlyLimit(_ searches: Int) {
        monthlyLimit = max(0, min(searches, 10_000))
        defaults.set(monthlyLimit, forKey: Self.limitKey)
    }

    /// 呼ぶ**前**に数える（呼んだ後に落ちても、上限を超えて呼ばない）。
    func recordSearch(at date: Date = Date()) {
        let label = Self.monthLabel(date)
        used = (month == label ? used : 0) + 1
        month = label
        defaults.set(used, forKey: Self.usedKey)
        defaults.set(month, forKey: Self.monthKey)
    }

    /// キーを置く・消す（空で消す）。成否だけ返す。キーそのものは返さない。
    @discardableResult
    func setKey(_ key: String) -> Bool {
        guard !checkingKey, keyAccessIssue == nil else { return false }
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if trimmed.isEmpty { try KeychainStore.delete(Self.keychainKey) } else { try KeychainStore.set(Self.keychainKey, trimmed) }
            hasKey = !trimmed.isEmpty; keyAccessIssue = nil
            return true
        } catch {
            keyAccessIssue = KeychainStore.accessMessage
            return false
        }
    }

    func apiKey() -> String? {
        do {
            guard let value = try KeychainStore.get(Self.keychainKey) else { return nil }
            guard !value.isEmpty else { throw KeychainStore.KeychainError.invalidData }
            return value
        }
        catch { keyAccessIssue = KeychainStore.accessMessage; return nil }
    }

    private static func monthLabel(_ date: Date) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents(in: .current, from: date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }
}
