import SwiftUI

@MainActor
final class TransactionAuthorizationState: ObservableObject {
    static let shared = TransactionAuthorizationState()
    struct Draft {
        let context: TransactionAuthorizationContext
        let approvalID: String
        var recurring = false
        var perOrder: String
        var total: String
        var orders = "3"
        var hours = 24
        var expiresAt: Date
        var sending = false
        var message = ""
        var frozenBody: Data?
        var frozenSpec: TransactionAuthorizationSpec?
        var created: TransactionAuthorizationRecord?
        init(context: TransactionAuthorizationContext, approvalID: String, now: Date = Date()) {
            self.context = context; self.approvalID = approvalID
            perOrder = TransactionMoney.input(context.maxPerOrderMinor, currency: context.scope.currency)
            total = TransactionMoney.input(min(context.maxPerOrderMinor, TransactionMoney.safeMaximum / 3) * 3, currency: context.scope.currency)
            expiresAt = now.addingTimeInterval(24 * 3600)
        }
        func spec(now: Date = Date()) -> TransactionAuthorizationSpec? {
            let currency = context.scope.currency
            guard let per = TransactionMoney.parse(perOrder, currency: currency),
                  let total = TransactionMoney.parse(total, currency: currency), per >= context.maxPerOrderMinor, total >= per,
                  let count = Int(orders), (1...1000).contains(count),
                  expiresAt > now, expiresAt.timeIntervalSince(now) <= 30 * 24 * 3600,
                  context.quoteExpiresAt > now else { return nil }
            return TransactionAuthorizationSpec(scope: context.scope, maxPerOrderMinor: per, maxTotalMinor: total,
                maxOrders: count, expiresAt: ISO8601DateFormatter().string(from: expiresAt))
        }
    }
    @Published private(set) var drafts: [UUID: Draft] = [:]
    @Published private(set) var records: [TransactionAuthorizationRecord] = []
    @Published private(set) var loading = false
    @Published private(set) var message = ""
    @Published private(set) var connected = false
    @Published private(set) var revoking: Set<String> = []
    private var api: TransactionAuthorizationAPI?
    private var clients: [UUID: TransactionAuthorizationAPI] = [:]
    init(api: TransactionAuthorizationAPI? = nil) { self.api = api; connected = api != nil }

    func configure(base: String, token: String) {
        if api?.base != base || api?.token != token { records = []; message = "" }
        let client = TransactionAuthorizationAPI(base: base, token: token)
        api = client; connected = true
        for (id, old) in clients where old.base == base { clients[id] = client }
    }

    func prepare(_ card: ActionConfirmation, approval: BackendApproval, api: TransactionAuthorizationAPI) async -> ActionConfirmation {
        guard approval.risk == "FINANCIAL", let context = try? await api.context(approvalID: approval.id) else { return card }
        var result = card
        result.transactionAuthorization = context
        drafts[card.id] = Draft(context: context, approvalID: approval.id)
        clients[card.id] = api
        return result
    }
    func update(_ id: UUID, _ mutate: (inout Draft) -> Void) {
        guard var draft = drafts[id], draft.frozenBody == nil else { return }
        mutate(&draft); draft.message = ""; drafts[id] = draft
        DockContentMeasure.invalidate()
        WindowCoordinator.shared.syncDockPanels()
        ConfirmationPresenter.resizeVisible()
    }
    /// Called only from the displayed confirmation's button. A retry reuses exactly the saved request.
    func submit(_ id: UUID, now: Date = Date()) async -> Bool {
        guard var draft = drafts[id], draft.recurring, !draft.sending, let client = clients[id] else { return false }
        if draft.frozenBody == nil {
            guard let spec = draft.spec(now: now),
                  let body = try? draft.context.body(requestID: UUID(), approvalID: draft.approvalID, spec: spec) else {
                draft.message = "上限・回数・期限を確認してください。見積もりの期限が過ぎた場合は、注文の状況を確認してください。"
                drafts[id] = draft; return false
            }
            draft.frozenBody = body; draft.frozenSpec = spec
        }
        guard let body = draft.frozenBody, let spec = draft.frozenSpec else { return false }
        draft.sending = true; draft.message = "許可と今回の注文を確認しています…"; drafts[id] = draft
        do {
            let result = try await client.create(body)
            guard result.approvalId == draft.approvalID, result.authorization.spec == spec,
                  UUID(uuidString: result.authorization.id) != nil else { throw TransactionAuthorizationAPI.Failure.invalidResponse }
            draft.created = result.authorization; draft.sending = false
            draft.message = "設定と今回の注文を確認しました。注文の状態は結果で確認できます。"
            guard drafts[id] != nil else { return false }
            drafts[id] = draft
            return true
        } catch {
            draft.sending = false
            draft.message = "許可と注文の結果は未確認です。同じ内容で再確認できます。設定の「任せている注文」でも確認できます。"
            if drafts[id] != nil { drafts[id] = draft }
            return false
        }
    }
    func remove(_ id: UUID) { drafts.removeValue(forKey: id); clients.removeValue(forKey: id) }

    func load() async {
        guard !loading else { return }
        guard let api else { message = "接続してから、任せている注文を確認できます。"; return }
        loading = true; defer { loading = false }
        do {
            let result = try await api.list()
            guard self.api?.base == api.base, self.api?.token == api.token else { return }
            records = result; message = ""
        } catch {
            if self.api?.base == api.base, self.api?.token == api.token { message = "一覧を確認できませんでした。接続を確認して再読込してください。" }
        }
    }
    func revoke(_ id: String) async {
        guard let api, !revoking.contains(id) else { return }
        revoking.insert(id); defer { revoking.remove(id) }
        do {
            let result = try await api.revoke(id)
            guard self.api?.base == api.base, self.api?.token == api.token else { return }
            guard result.id == id, result.status == "REVOKED" else { throw TransactionAuthorizationAPI.Failure.invalidResponse }
            if let index = records.firstIndex(where: { $0.id == id }) { records[index] = result }
            message = "許可を取り消しました。すでに送信された注文の取消とは異なります。"
        } catch {
            if self.api?.base == api.base, self.api?.token == api.token { message = "取消の結果は未確認です。一覧を再読込して現在の状態を確認してください。" }
        }
    }
}
