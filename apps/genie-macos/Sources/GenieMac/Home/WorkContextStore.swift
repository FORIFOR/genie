import Foundation
import SwiftUI

// MARK: - 契約（@genie/contracts work.ts の写し。正本は TypeScript 側の zod）

/// 出所。**すべての推論が最低 1 つ持つ。**excerpt は抜粋であって全文ではない。
struct WorkProvenance: Codable, Hashable, Identifiable {
    var id: String { source + ":" + externalId }
    let source: String
    let externalId: String
    let label: String
    let observedAt: String
    var url: String?
    var excerpt: String?
}

struct WorkPressureFactor: Codable, Hashable {
    let name: String
    let value: Double
    let weight: Double
    let contribution: Double
    let reason: String
}

struct WorkPriority: Codable, Identifiable, Hashable {
    let id: String
    let project: String
    let title: String
    /// 0..1。決定的な式（Work Pressure）の値で、LLM は関わらない。
    let score: Double
    var dueAt: String?
    var waitingOn: String?
    let lines: [String]
    let counts: [String: Int]
    let factors: [WorkPressureFactor]
    let sources: [WorkProvenance]
    /// 本人が「自分の TODO」と確認した。nil / false はメール等からの推測（候補）。古い gateway は送らない。
    var confirmed: Bool?
}

struct WorkWaitingItem: Codable, Identifiable, Hashable {
    let id: String
    let who: String
    let what: String
    let sinceDays: Double
    var project: String?
    let sources: [WorkProvenance]
}

struct WorkOwedItem: Codable, Identifiable, Hashable {
    let id: String
    let to: String
    let what: String
    var dueAt: String?
    var project: String?
    let sources: [WorkProvenance]
    /// 本人が「自分の TODO」と確認した。nil / false はメール等からの推測（候補）。
    var confirmed: Bool?
}

struct WorkWeekLoad: Codable, Hashable {
    let meetingHours: Double
    let deadlines: Int
    let unanswered: Int
    let waiting: Int
}

struct WorkContext: Codable {
    let generatedAt: String
    /// false なら priorities / waiting / owed は空で、注入も止まっている。
    let inferenceEnabled: Bool
    var priorities: [WorkPriority]
    var waitingOn: [WorkWaitingItem]
    var owed: [WorkOwedItem]
    let week: WorkWeekLoad
    let sources: [String: Int]

    var isEmpty: Bool { priorities.isEmpty && waitingOn.isEmpty && owed.isEmpty }
}

/// 推測を事実として固定しない: 観測 → 推測 → 本人が確認、の 3 段。
enum TraitStatus: String, Codable { case observed, inferred, confirmed
    var label: String {
        switch self {
        case .observed: return "観測"
        case .inferred: return "推測"
        case .confirmed: return "確認済み"
        }
    }
}

enum TraitValue: Codable, Hashable {
    case number(Double), text(String), list([String])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .text(s); return }
        self = .list(try c.decode([String].self))
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .number(let n): try c.encode(n)
        case .text(let s): try c.encode(s)
        case .list(let l): try c.encode(l)
        }
    }
    var display: String {
        switch self {
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(format: "%.1f", n)
        case .text(let s): return s
        case .list(let l): return l.joined(separator: "、")
        }
    }
}

struct PersonalizationTrait: Codable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    let label: String
    let value: TraitValue
    var status: TraitStatus
    var enabled: Bool
    let sources: [WorkProvenance]
}

struct PersonalizationProfile: Codable {
    var workingStyle: [PersonalizationTrait]
    var workPatterns: [PersonalizationTrait]
    var frequentEntities: [PersonalizationTrait]
    var inferenceEnabled: Bool
    let updatedAt: String

    var all: [PersonalizationTrait] { workingStyle + workPatterns + frequentEntities }
}

struct BriefFact: Codable, Hashable, Identifiable {
    var id: String { text }
    let text: String
    let sources: [WorkProvenance]
}

struct SuggestedQuestion: Codable, Hashable, Identifiable {
    var id: String { question }
    let question: String
    let reason: String
    let sources: [WorkProvenance]
    let extractedBy: String
}

/// 会議前の brief（MEETING_BRIEF）。事実は出所つき、質問は理由と出所つき。
struct MeetingBrief: Codable {
    let eventId: String
    let title: String
    let startsAt: String
    let project: String?
    let previous: [BriefFact]
    let sinceLastMeeting: [BriefFact]
    let openItems: [BriefFact]
    let suggestedQuestions: [SuggestedQuestion]
    let provenance: [WorkProvenance]
    let generatedAt: String
}

// MARK: - Store

/// Home の Work Context と Personalization。gateway から読み、本人の訂正を 1 操作で返す。
///
/// **見えないものは使わない。**ここに無い推測を LLM に注入することは無い（注入は gateway の
/// `injectionText` で、同じ `/v1/work/context` から作る）。
@MainActor
final class WorkContextStore: ObservableObject {
    static let shared = WorkContextStore()

    @Published private(set) var context: WorkContext?
    @Published private(set) var profile: PersonalizationProfile?
    /// 次の会議の brief。無ければ nil（架空の会議を作らない）。
    @Published private(set) var brief: MeetingBrief?
    @Published var briefOpen = false
    /// 出所を開いている item。
    @Published var evidenceOpen: Set<String> = []
    /// 最後の失敗。黙って空にしない。
    @Published private(set) var failure: String?

    private var base: String?
    private var token: String?

    /// 撮影・検査用の差し込み。**gateway から実データが読めればそちらが勝つ。**
    nonisolated(unsafe) static var preview: WorkContext?
    nonisolated(unsafe) static var previewProfile: PersonalizationProfile?
    nonisolated(unsafe) static var previewBrief: MeetingBrief?

    static let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return d
    }()
    static let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.keyEncodingStrategy = .convertToSnakeCase; return e
    }()

    func configureBackend(base: String, token: String) {
        self.base = base; self.token = token
    }

    /// 読み直す。gateway が無ければ差し込み（あれば）を使う。
    func load() {
        if let base, let token {
            Task.detached { [base, token] in
                let ctx = (try? GenieCoreBridge.workContext(base, accessToken: token))
                    .flatMap { try? WorkContextStore.decoder.decode(WorkContext.self, from: Data($0.utf8)) }
                let prof = (try? GenieCoreBridge.personalization(base, accessToken: token))
                    .flatMap { try? WorkContextStore.decoder.decode(PersonalizationProfile.self, from: Data($0.utf8)) }
                let briefText = (try? GenieCoreBridge.workBriefNext(base, accessToken: token)) ?? ""
                let brief = briefText.isEmpty ? nil
                    : try? WorkContextStore.decoder.decode(MeetingBrief.self, from: Data(briefText.utf8))
                await MainActor.run {
                    self.brief = brief ?? (self.brief ?? WorkContextStore.previewBrief)
                    if let ctx { self.context = ctx; self.failure = nil }
                    else if self.context == nil { self.context = WorkContextStore.preview; self.failure = "仕事の文脈を読めませんでした" }
                    if let prof { self.profile = prof } else if self.profile == nil { self.profile = WorkContextStore.previewProfile }
                }
            }
        } else {
            // gateway が無い。差し込みがあればそれ、無ければ**今あるものを消さない**
            // （検査が install したものを onAppear の load が空にしていた）。
            if let p = WorkContextStore.preview { context = p }
            if let pp = WorkContextStore.previewProfile { profile = pp }
            if let pb = WorkContextStore.previewBrief { brief = pb }
        }
    }

    /// 検査用: brief を直に入れる。
    func installBrief(_ b: MeetingBrief?) { brief = b; briefOpen = false }

    /// 検査用: gateway 無しで差し込みを直に入れる。
    func install(_ ctx: WorkContext?, profile: PersonalizationProfile?) {
        context = ctx; self.profile = profile; evidenceOpen = []
    }

    /// 本人の訂正。**1 操作。**その場で消し、gateway にも残す（以後の推論に効く）。
    /// `confirm` だけは消さず、その場で「登録済み」にする。
    func correct(_ itemId: String, action: String, note: String? = nil) {
        guard var ctx = context else { return }
        if action == "confirm" {
            for i in ctx.priorities.indices where ctx.priorities[i].id == itemId { ctx.priorities[i].confirmed = true }
            for i in ctx.owed.indices where ctx.owed[i].id == itemId { ctx.owed[i].confirmed = true }
        } else {
            ctx.priorities.removeAll { $0.id == itemId }
            ctx.waitingOn.removeAll { $0.id == itemId }
            ctx.owed.removeAll { $0.id == itemId }
        }
        context = ctx
        evidenceOpen.remove(itemId)
        if let base, let token {
            Task.detached {
                do { try GenieCoreBridge.workCorrect(base, accessToken: token, itemId: itemId, action: action, note: note ?? "") }
                catch { await MainActor.run { self.failure = "訂正を保存できませんでした" } }
            }
        }
    }

    /// 推測の全体を止める / 戻す。**1 操作。**
    func setInference(_ enabled: Bool) {
        update(["inference_enabled": enabled])
        if var p = profile { p.inferenceEnabled = enabled; profile = p }
        if !enabled, var ctx = context {
            ctx.priorities = []; ctx.waitingOn = []; ctx.owed = []
            context = WorkContext(generatedAt: ctx.generatedAt, inferenceEnabled: false, priorities: [], waitingOn: [], owed: [],
                                  week: ctx.week, sources: ctx.sources)
        } else if enabled {
            load()
        }
    }

    /// 1 つの推測を確認する / 使わない。**1 操作。**
    func setTrait(_ key: String, status: TraitStatus? = nil, enabled: Bool? = nil) {
        guard var p = profile else { return }
        func patch(_ list: inout [PersonalizationTrait]) {
            for i in list.indices where list[i].key == key {
                if let status { list[i].status = status }
                if let enabled { list[i].enabled = enabled }
            }
        }
        patch(&p.workingStyle); patch(&p.workPatterns); patch(&p.frequentEntities)
        profile = p
        var trait: [String: Any] = ["key": key]
        if let status { trait["status"] = status.rawValue }
        if let enabled { trait["enabled"] = enabled }
        update(["traits": [trait]])
    }

    private func update(_ body: [String: Any]) {
        guard let base, let token,
              let data = try? JSONSerialization.data(withJSONObject: body),
              let json = String(data: data, encoding: .utf8) else { return }
        Task.detached {
            if let text = try? GenieCoreBridge.personalizationUpdate(base, accessToken: token, updateJson: json),
               let prof = try? WorkContextStore.decoder.decode(PersonalizationProfile.self, from: Data(text.utf8)) {
                await MainActor.run { self.profile = prof }
            } else {
                await MainActor.run { self.failure = "設定を保存できませんでした" }
            }
        }
    }
}

// MARK: - 表示の小物

enum WorkFormat {
    /// 期限を短く。今日 / 明日 / 9/9 / 9/9 15:00。
    static func due(_ iso: String?, now: Date = Date()) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let cal = Calendar.current
        let time = DateFormatter(); time.dateFormat = "H:mm"
        let hasTime = !(cal.component(.hour, from: date) == 18 && cal.component(.minute, from: date) == 0)
        if cal.isDate(date, inSameDayAs: now) { return hasTime ? "今日 " + time.string(from: date) : "今日" }
        if let tomorrow = cal.date(byAdding: .day, value: 1, to: now), cal.isDate(date, inSameDayAs: tomorrow) {
            return hasTime ? "明日 " + time.string(from: date) : "明日"
        }
        let day = DateFormatter(); day.dateFormat = "M/d"
        return hasTime ? day.string(from: date) + " " + time.string(from: date) : day.string(from: date)
    }

    static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    /// 案件名が題と同じ文か（空白・全角半角の違いを除く）。件名から作った案件名は題と重なる。
    static func repeats(_ project: String, in title: String) -> Bool {
        let fold = { (s: String) in
            s.applyingTransform(.fullwidthToHalfwidth, reverse: false)?.lowercased()
                .filter { !$0.isWhitespace } ?? s
        }
        let p = fold(project), t = fold(title)
        return !p.isEmpty && (p == t || t.contains(p) || p.contains(t))
    }

    /// 「Gmail 4 · 会議 2 · Task 1」。
    static func counts(_ counts: [String: Int]) -> String {
        let names: [String: String] = [
            "gmail": "Gmail", "outlook_mail": "Outlook", "google_calendar": "予定", "outlook_calendar": "予定",
            "microsoft_todo": "To Do", "meeting": "会議", "astra_task": "頼みごと", "screenshot": "画面", "file": "ファイル",
        ]
        return counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .map { "\(names[$0.key] ?? $0.key) \($0.value)" }
            .joined(separator: " · ")
    }

    /// 点数 → 言葉。閾値は決定的（>= 0.5 高、>= 0.25 中）。
    static func level(_ score: Double) -> String {
        score >= 0.5 ? Facts.workLevelHigh : score >= 0.25 ? Facts.workLevelMid : Facts.workLevelLow
    }

    /// 「なぜ重要？」の行。寄与の大きい要因の理由を、多い順に最大 4 つ。理由の無い要因は出さない。
    static func reasons(_ p: WorkPriority) -> [String] {
        let lines = p.factors
            .filter { $0.contribution > 0 && !$0.reason.isEmpty }
            .sorted { $0.contribution == $1.contribution ? $0.name < $1.name : $0.contribution > $1.contribution }
            .prefix(4)
            .map(\.reason)
        return lines.isEmpty ? ["理由を出せる要因がありません"] : Array(lines)
    }

    static func sourceName(_ source: String) -> String {
        switch source {
        case "gmail": return "Gmail"
        case "outlook_mail": return "Outlook"
        case "google_calendar", "outlook_calendar": return "予定"
        case "microsoft_todo": return "To Do"
        case "meeting": return "会議"
        case "astra_task": return "頼みごと"
        default: return source
        }
    }
}
