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

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        monthlyLimit = defaults.integer(forKey: Self.limitKey)
        used = defaults.integer(forKey: Self.usedKey)
        month = defaults.string(forKey: Self.monthKey) ?? ""
        hasKey = ((try? KeychainStore.get(Self.keychainKey)) ?? nil)?.isEmpty == false
    }

    /// 今月すでに使った回数（月が替わっていれば 0）。
    func usedThisMonth(at date: Date = Date()) -> Int { month == Self.monthLabel(date) ? used : 0 }

    /// 検索してよいか。キーと上限があり、今月の上限に達していないときだけ。
    func canSearch(at date: Date = Date()) -> Bool {
        hasKey && monthlyLimit > 0 && usedThisMonth(at: date) < monthlyLimit
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
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if trimmed.isEmpty { try KeychainStore.delete(Self.keychainKey) } else { try KeychainStore.set(Self.keychainKey, trimmed) }
            hasKey = !trimmed.isEmpty
            return true
        } catch {
            return false
        }
    }

    func apiKey() -> String? { (try? KeychainStore.get(Self.keychainKey)) ?? nil }

    private static func monthLabel(_ date: Date) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents(in: .current, from: date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }
}
