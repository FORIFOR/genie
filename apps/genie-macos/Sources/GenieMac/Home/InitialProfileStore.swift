import GenieCore
import SwiftUI

struct InitialProfileSections: Codable, Equatable {
    var focus: [String]
    var people: [String]
    var priorities: [String]
    var workPattern: [String]
    var openItems: Int
}
struct InitialProfileProgress: Codable, Equatable {
    let source: String
    let status: String
    let artifacts: Int
}
struct InitialProfileAnalysis: Codable, Equatable {
    let version: Int
    let status: String
    let selectedCount: Int
    let analyzedCount: Int
    var coverage: String {
        if status == "unavailable" {
            return "主要メールの本文を分析できませんでした。メールの取得・分析を完了できていないため、もう一度分析してください。"
        }
        if selectedCount == 0 { return "分析対象となる主要なやり取りは見つかりませんでした。確認できた予定の傾向だけを表示しています。" }
        let detail = "主要メール\(selectedCount)件のうち\(analyzedCount)件の本文をこのMacで分析しました。"
        return detail + (status == "partial" ? " 一部は分析できていません。推定内容を確認してください。" : " 推定内容を確認してください。")
    }
}
struct InitialProfileResult: Codable, Equatable {
    let id: String
    let provider: String
    let status: String
    let startedAt: String
    let updatedAt: String
    let outcomes: [InitialProfileProgress]
    let sections: InitialProfileSections?
    var analysis: InitialProfileAnalysis? = nil
    var finished: Bool { status == "confirmed" }
}

@MainActor
final class InitialProfileStore: ObservableObject {
    static let shared = InitialProfileStore()
    @Published private(set) var result: InitialProfileResult?
    @Published private(set) var failure: String?
    @Published private(set) var saving = false
    @Published private(set) var starting = false
    @Published private(set) var deferred = false
    /// 本人が「保存しない」とした推測。分析し直しても同じ項目を戻さない（このMacに保存、語だけ）。
    @Published private(set) var rejected: Set<String> = []
    private var base: String?
    private var token: String?
    private var poll: Task<Void, Never>?
    private var generation = UUID()
    private var requestedProvider: String?
    var visible: Bool { !deferred && ((starting || failure != nil) || (result != nil && result?.finished != true)) }

    func deferUntilRequested() { deferred = true }
    @Published var openRequested = false
    func showExisting(open: Bool = true) { deferred = false; if open { openRequested = true } }

    func configureBackend(base: String, token: String, renewal: Bool = false) {
        // Cancel stale responses when the authenticated session changes.
        if self.base != base || (!renewal && self.token != token) {
            poll?.cancel(); generation = UUID(); result = nil; failure = nil
            starting = false; saving = false; requestedProvider = nil; deferred = false
        }
        self.base = base; self.token = token
        rejected = Set(UserDefaults.standard.stringArray(forKey: Self.rejectedKey(base)) ?? [])
        poll?.cancel()
        poll = Task { await refresh(); schedule() }
    }

    func connected(provider: String) {
        guard ["google", "microsoft"].contains(provider) else { return }
        guard result?.finished != true else { return }
        showExisting(open: false)
        if result?.provider == provider { return }
        requestedProvider = provider
        starting = true; failure = nil
        MainWindowController.shared.showSection(.home)
        Task {
            do {
                let text = try await call("begin", body: ["provider": provider])
                result = try Self.decode(text); starting = false
                schedule()
            } catch is CancellationError { return } catch { starting = false; failure = "初期解析を開始できませんでした。接続先を確認して再試行してください。" }
        }
    }

    func retry() {
        if result == nil, let requestedProvider { connected(provider: requestedProvider); return }
        failure = nil
        Task {
            do { _ = try await call("retry"); await refresh(); schedule() }
            catch is CancellationError { return }
            catch { failure = "再試行できませんでした。通信を確認してください。" }
        }
    }

    static func valid(_ s: InitialProfileSections) -> Bool {
        let groups = [(s.focus, 5), (s.people, 12), (s.priorities, 5), (s.workPattern, 3)]
        return (0...5000).contains(s.openItems) && groups.allSatisfy { values, limit in
            values.count <= limit && values.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count <= 200 }
        }
    }

    /// Explicit fixtures only; never used by the connection or restore paths.
    func installForTesting(_ value: InitialProfileResult?, rejected: Set<String> = []) {
        poll?.cancel(); result = value; failure = nil; starting = false; deferred = false; self.rejected = rejected
    }

    /// 比べるための形（前後の空白・全角半角・大文字小文字をそろえる）。
    static func rejectionKey(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .widthInsensitive], locale: Locale(identifier: "ja_JP"))
    }
    private static func rejectedKey(_ base: String) -> String { "genie.initialProfile.rejected." + base }

    /// 1 項目を「保存しない」。その場で消え、以後の分析結果からも除く。
    func reject(_ value: String) {
        rejected.insert(Self.rejectionKey(value))
        if let base { UserDefaults.standard.set(Array(rejected).sorted(), forKey: Self.rejectedKey(base)) }
    }

    /// 「保存しない」とした項目を除いた、画面と確定に使う内容。
    func visible(_ sections: InitialProfileSections) -> InitialProfileSections {
        let keep = { (values: [String]) in values.filter { !self.rejected.contains(Self.rejectionKey($0)) } }
        return InitialProfileSections(focus: keep(sections.focus), people: keep(sections.people),
                                      priorities: keep(sections.priorities), workPattern: keep(sections.workPattern),
                                      openItems: sections.openItems)
    }

    /// `edited`: 本人が書いた内容。そこに書き戻した項目は「保存しない」から外す（本人の記入が勝つ）。
    func confirm(_ proposed: InitialProfileSections, edited: Bool = false) {
        if edited {
            for value in proposed.focus + proposed.people + proposed.priorities + proposed.workPattern {
                rejected.remove(Self.rejectionKey(value))
            }
            if let base { UserDefaults.standard.set(Array(rejected).sorted(), forKey: Self.rejectedKey(base)) }
        }
        let sections = edited ? proposed : visible(proposed)
        guard Self.valid(sections) else { failure = "項目数の上限を確認してください。1項目は200文字以内で入力できます。"; return }
        guard !saving else { return }; saving = true; failure = nil
        let current = generation
        Task {
            defer { if current == generation { saving = false } }
            do {
                let encoder = JSONEncoder(); encoder.keyEncodingStrategy = .convertToSnakeCase
                let body = String(decoding: try encoder.encode(sections), as: UTF8.self)
                _ = try await call("confirm", json: body)
                await refresh(); WorkContextStore.shared.load()
            } catch is CancellationError { return }
            catch { failure = "確認結果を保存できませんでした。もう一度お試しください。" }
        }
    }

    private func schedule() {
        poll?.cancel()
        guard let result, !result.finished, result.status != "ready", result.status != "failed" else { return }
        poll = Task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await refresh()
                if ["ready", "confirmed", "failed"].contains(self.result?.status ?? "") { return }
            }
        }
    }

    private func refresh() async {
        do { result = try Self.decode(try await call("get")); failure = nil }
        catch is CancellationError { return }
        catch { if visible { failure = "解析状況を取得できません。通信が戻ると再開します。" } }
    }

    private func call(_ operation: String, body: [String: String] = [:], json: String? = nil) async throws -> String {
        guard let base, let token else { throw URLError(.userAuthenticationRequired) }
        let current = generation
        let payload = try json ?? String(decoding: JSONEncoder().encode(body), as: UTF8.self)
        let text: String
        do {
            text = try await Task.detached {
                try apiInitialProfile(baseUrl: base, accessToken: token, operation: operation, bodyJson: payload)
            }.value
        } catch {
            guard current == generation else { throw CancellationError() }
            throw error
        }
        guard current == generation else { throw CancellationError() }
        return text
    }

    static func decode(_ text: String) throws -> InitialProfileResult? {
        struct Response: Decodable { let profile: InitialProfileResult? }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let result = try decoder.decode(Response.self, from: Data(text.utf8)).profile
        if let result {
            guard ["queued", "analysing", "ready", "confirmed", "failed"].contains(result.status),
                  !["ready", "confirmed"].contains(result.status) || result.sections != nil,
                  result.outcomes.allSatisfy({ $0.artifacts >= 0 }),
                  result.sections.map(Self.valid) ?? true else { throw URLError(.cannotParseResponse) }
            if let analysis = result.analysis {
                guard analysis.version == 2, ["complete", "partial", "unavailable"].contains(analysis.status),
                      (0...100).contains(analysis.selectedCount), (0...analysis.selectedCount).contains(analysis.analyzedCount)
                else { throw URLError(.cannotParseResponse) }
            }
        }
        return result
    }
}
