import SwiftUI

/// §17 Confirmation Engine。AI の文章で「よろしいですか？」とは聞かない。
///
/// 見出しは**何が起きるか**を結果の文で書き、ボタンにも結果を書く。
/// どの操作でこれを出すかは呼び出し側の気分ではなく `ActionRiskLevel`（§16）が決める。
struct ConfirmationCardView: View {
    let confirmation: ActionConfirmation
    var onResolve: (Bool) -> Void
    /// 面が出た時刻。出た直後の「実行する」は受け付けない（Dock の確認面と同じ）。
    @State private var shownAt = Date()
    @ObservedObject private var authorizations = TransactionAuthorizationState.shared
    private var delegation: TransactionAuthorizationState.Draft? { authorizations.drafts[confirmation.id] }

    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }

    private var riskTint: Color {
        confirmation.risk == .r3 ? Palette.danger(dark) : Palette.warning(dark)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: confirmation.risk == .r3 ? "exclamationmark.octagon.fill" : "arrow.up.forward.app.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(riskTint)
                Text(confirmation.risk.label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(riskTint)
                Spacer(minLength: 0)
            }

            Text(confirmation.title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.text(dark))
                .fixedSize(horizontal: false, vertical: true)

            if confirmation.transactionAuthorization != nil { TransactionAuthorizationChoice(id: confirmation.id) }
            if delegation?.recurring == true { TransactionAuthorizationEditor(id: confirmation.id) }
            else if let preview = confirmation.preview, !preview.isEmpty {
                ScrollView {
                    Text(preview)
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted(dark))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: confirmation.previewHeight())
                .accessibilityIdentifier("cardPreview")
            }

            if delegation?.recurring != true, !confirmation.details.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(confirmation.details, id: \.self) { d in
                        Text(d)
                            .font(.system(size: 11))
                            .foregroundStyle(Palette.muted(dark))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                // 検査から押す口。Dock の確認面（confirmCancel / confirmProceed）と
                // 別の id にする —— 同じ id で登録すると後勝ちで、どちらを押したか分からない。
                // 高さと余白はラベルの中に置く（外に付けると押せる範囲が文字だけになる）。
                ProbeButton(id: "cardCancel", action: { onResolve(false) }) {
                    Text(delegation?.frozenBody == nil ? Facts.confirmationCancel : "閉じる")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.muted(dark))
                        .frame(height: 28).padding(.horizontal, 12)
                        .contentShape(Rectangle())
                }
                    .buttonStyle(GenieControlStyle(radius: 8, base: 0.0))
                    .disabled(delegation?.sending == true)
                ProbeButton(id: "cardProceed", action: {
                    guard Date().timeIntervalSince(shownAt) >= ActionConfirmation.proceedArmDelay else { return }
                    if delegation?.recurring == true {
                        Task { if await authorizations.submit(confirmation.id) { onResolve(true) } }
                    } else { onResolve(true) }
                }) {
                    Text(delegation?.recurring == true
                         ? (delegation?.sending == true ? "確認中…" : (delegation?.frozenBody == nil ? "この条件で任せて注文" : "同じ内容で再確認"))
                         : confirmation.confirmLabel)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(riskTint)
                        .frame(height: 28).padding(.horizontal, 14)
                        .contentShape(Rectangle())
                }
                    .buttonStyle(GenieControlStyle(radius: 8, base: 0.06))
                    .disabled(delegation?.sending == true || (delegation?.recurring == true && delegation?.frozenBody == nil && delegation?.spec() == nil))
            }
        }
        .padding(16)
        .frame(width: 320)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.cardSurface(dark))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.hairline(dark)))
                .shadow(color: .black.opacity(dark ? 0.5 : 0.2), radius: 24, y: 10)
        )
        .accessibilityIdentifier("confirmationCard")
    }
}
