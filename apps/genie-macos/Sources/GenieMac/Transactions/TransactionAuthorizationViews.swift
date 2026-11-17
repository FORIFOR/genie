import SwiftUI

struct TransactionAuthorizationChoice: View {
    let id: UUID
    @ObservedObject private var state = TransactionAuthorizationState.shared
    var body: some View {
        if let draft = state.drafts[id] {
            Picker("今回の許可", selection: Binding(get: { draft.recurring }, set: { value in state.update(id) { $0.recurring = value } })) {
                Text("今回だけ").tag(false)
                Text("同じ条件で任せる").tag(true)
            }
            .pickerStyle(.segmented)
            .disabled(draft.frozenBody != nil)
            .accessibilityIdentifier("transactionAuthorizationChoice")
        }
    }
}

/// The existing confirmation surface keeps its buttons outside this bounded scroll region.
struct TransactionAuthorizationEditor: View {
    let id: UUID
    @ObservedObject private var state = TransactionAuthorizationState.shared
    var body: some View {
        if let draft = state.drafts[id] {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.base) {
                    Text("今回を含む上限です。条件を満たす依頼だけ、次回から確認を省きます。")
                    HStack(alignment: .top, spacing: Space.base) {
                        field("1回の上限（\(TransactionMoney.unit(draft.context.scope.currency))）", value: draft.perOrder, key: "transactionPerOrder") { $0.perOrder = $1 }
                        field("累計の上限（\(TransactionMoney.unit(draft.context.scope.currency))）", value: draft.total, key: "transactionTotal") { $0.total = $1 }
                    }
                    HStack(alignment: .top, spacing: Space.base) {
                        field("回数（今回を含む）", value: draft.orders, key: "transactionOrderCount") { $0.orders = $1 }
                        VStack(alignment: .leading, spacing: Space.compact) {
                            Text("期限")
                            Picker("期限", selection: Binding(get: { draft.hours }, set: { hours in
                                state.update(id) { $0.hours = hours; $0.expiresAt = Date().addingTimeInterval(Double(hours) * 3600) }
                            })) {
                                Text("1時間").tag(1); Text("24時間").tag(24)
                                Text("7日間").tag(168); Text("30日間").tag(720)
                            }
                            .labelsHidden().accessibilityIdentifier("transactionExpiry")
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text("有効期限: \(draft.expiresAt.formatted(date: .abbreviated, time: .shortened))")
                    Text(draft.context.scope.review).textSelection(.enabled)
                    Text("金額や回数は結果未確認でも使用済みとして確保します。残りの確認・取消は設定の「任せている注文」から行えます。実サービスは未対応です。")
                    if !draft.message.isEmpty {
                        Text(draft.message).foregroundStyle(draft.created == nil ? .orange : .secondary)
                            .accessibilityIdentifier("transactionAuthorizationMessage")
                    } else if draft.spec() == nil {
                        Text("1回の上限は依頼の上限以上、累計は1回の上限以上、回数は1〜1000で入力してください。見積もり期限後は作成できません。")
                            .foregroundStyle(.orange)
                    }
                }
                .font(.system(size: S.type(Metrics.dockMetaSize)))
                .frame(maxWidth: .infinity, alignment: .leading)
                .disabled(draft.frozenBody != nil)
            }
            .frame(height: S.metric(Metrics.dockAuthorizationBodyMaxHeight))
            .accessibilityIdentifier("transactionAuthorizationEditor")
        }
    }
    private func field(_ label: String, value: String, key: String,
                       change: @escaping (inout TransactionAuthorizationState.Draft, String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: Space.compact) {
            Text(label)
            TextField(label, text: Binding(get: { value }, set: { value in state.update(id) { change(&$0, value) } }))
                .textFieldStyle(.roundedBorder).accessibilityIdentifier(key)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct TransactionAuthorizationListView: View {
    @ObservedObject private var state: TransactionAuthorizationState
    init(state: TransactionAuthorizationState? = nil) { _state = ObservedObject(wrappedValue: state ?? .shared) }
    @Environment(\.dismiss) private var dismiss
    @State private var expanded: Set<String> = []
    var body: some View {
        VStack(alignment: .leading, spacing: Space.base) {
            HStack {
                Text("任せている注文").font(.system(size: TypeScale.sectionTitleSize, weight: .semibold))
                Spacer()
                Button("閉じる") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text("シミュレーションのみ。実サービスは未対応です。取消後も、すでに送信された注文は取り消されません。")
                .font(.system(size: TypeScale.secondarySize))
            HStack {
                Button(state.loading ? "確認中…" : "再読込") { Task { await state.load() } }.disabled(state.loading)
                    .accessibilityIdentifier("transactionAuthorizationsRefresh")
                if !state.message.isEmpty { Text(state.message).textSelection(.enabled) }
            }.font(.system(size: TypeScale.microSize))
            ScrollView {
                VStack(alignment: .leading, spacing: Space.cardPadding) {
                    if state.records.isEmpty, !state.loading { Text(state.message.isEmpty ? "任せている注文はありません。注文の確認カードから、範囲を決めて任せられます。" : "一覧は未確認です。") }
                    ForEach(state.records) { record in
                        VStack(alignment: .leading, spacing: Space.base) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(record.spec.scope.items.map(\.label).joined(separator: "、"))
                                    .font(.system(size: TypeScale.cardTitleSize, weight: .medium))
                                Spacer()
                                Text(record.status == "REVOKED" ? "取消済み" : (record.isActive() ? "有効" : "期限切れ"))
                            }
                            Text("残り \(record.remainingOrders)回 / \(TransactionMoney.display(record.remainingMinor, currency: record.spec.scope.currency))")
                            Text("1回の上限 \(TransactionMoney.display(record.spec.maxPerOrderMinor, currency: record.spec.scope.currency)) · 今回を含め最大\(record.spec.maxOrders)回")
                            Text("期限: \(TransactionAuthorizationContext.date(record.spec.expiresAt)?.formatted(date: .abbreviated, time: .shortened) ?? record.spec.expiresAt)")
                            DisclosureGroup("固定した条件", isExpanded: Binding(get: { expanded.contains(record.id) }, set: { value in
                                if value { expanded.insert(record.id) } else { expanded.remove(record.id) }
                            })) { Text(record.spec.scope.review).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            Text("予約済み \(record.usedOrders)回 / \(TransactionMoney.display(record.usedTotalMinor, currency: record.spec.scope.currency))（結果未確認でも戻りません）")
                                .font(.system(size: TypeScale.microSize)).foregroundStyle(.secondary)
                            if record.isActive() {
                                Button(state.revoking.contains(record.id) ? "取り消しています…" : "この許可を取り消す") { Task { await state.revoke(record.id) } }
                                    .disabled(state.revoking.contains(record.id))
                                    .accessibilityIdentifier("transactionAuthorizationRevoke-\(record.id)")
                            }
                        }
                        Divider()
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .font(.system(size: TypeScale.secondarySize))
        .padding(Space.largePadding)
        .frame(width: Metrics.dockConfirmWidth, height: Metrics.dockMeetingExpandedHeight)
        .accessibilityIdentifier("transactionAuthorizations")
        .task { await state.load() }
    }
}
