import SwiftUI

/// Connection → measured progress → five reviewed groups. The Home window is reused.
struct InitialProfileView: View {
    @ObservedObject private var store = InitialProfileStore.shared
    @Environment(\.colorScheme) private var scheme
    @State private var editing = false
    @State private var draft: InitialProfileSections?
    private var dark: Bool { scheme == .dark }
    private var ready: Bool { store.result?.status == "ready" }
    private var legacy: Bool { ready && store.result?.analysis == nil }
    private var analysisUnavailable: Bool { store.result?.analysis?.status == "unavailable" }
    private var failed: Bool { store.result?.status == "failed" || (store.result == nil && store.failure != nil) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.largePadding) {
                Text(ready ? (legacy || analysisUnavailable ? "プロフィールを見直せます" : "メールから整理したプロフィール") : (failed ? "プロフィールの作成を再開できます" : "プロフィールを整理しています"))
                    .font(.system(size: S.type(TypeScale.pageTitleSize), weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                Text(ready ? (store.result?.analysis?.coverage ?? "この結果は件名や送信者だけで作られています。主要なやり取りの本文から分析し直せます。") : (failed ? "接続を確認して再試行できます。プロフィールはあとから作成することもできます。" : "送信・返信のあるやり取りや重要メールを優先し、仕事、よく関わる人、対応事項を整理しています。"))
                    .font(.system(size: S.type(TypeScale.bodySize)))
                    .fixedSize(horizontal: false, vertical: true)
                if let failure = store.failure {
                    Text(failure).foregroundStyle(Palette.danger(dark)).accessibilityIdentifier("initialProfileFailure")
                }
                if ready, let saved = store.result?.sections {
                    let sections = store.visible(saved)
                    if !legacy {
                        if editing, draft != nil { editFields }
                        else {
                            Text("推測です。「この内容を使う」を押すまで使いません。外した項目は戻りません。")
                                .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(dark))
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("initialProfileGuessNote")
                            group("現在の仕事・活動", sections.focus, removable: true)
                            group("よくやり取りする相手", sections.people, removable: true)
                            group("対応が必要そうなこと", sections.priorities, removable: true)
                            group("確認できた予定の傾向", sections.workPattern, removable: true)
                            group("未解決として確認できた項目", analysisUnavailable ? ["本文の分析後に確認できます"] : ["\(sections.openItems)件（分析した範囲）"])
                        }
                    }
                    HStack {
                        if !legacy {
                        ProbeButton(id: "initialProfileConfirm", action: { store.confirm(draft ?? sections, edited: draft != nil) }) { Text(editing ? "保存してHomeへ" : "この内容を使う") }
                            .buttonStyle(.borderedProminent).disabled(store.saving || (analysisUnavailable && !editing))
                            .accessibilityIdentifier("initialProfileConfirm")
                        ProbeButton(id: "initialProfileEdit", action: {
                            if editing { draft = nil; editing = false } else { draft = sections; editing = true }
                        }) { Text(editing ? "編集をやめる" : "内容を修正") }.buttonStyle(.borderless).disabled(store.saving)
                            .accessibilityIdentifier("initialProfileEdit")
                        }
                        Button("主要なメールから分析し直す") { draft = nil; editing = false; store.retry() }
                            .buttonStyle(.borderless).disabled(store.saving)
                            .accessibilityIdentifier("initialProfileReanalyse")
                    }
                } else {
                    progress("Calendar", sources: ["google_calendar", "outlook_calendar"], unit: "件の予定を確認")
                    progress("Mail", sources: ["gmail", "outlook_mail"], unit: "件のメールを確認")
                    progress("People", sources: [], unit: "")
                    progress("Projects", sources: [], unit: "")
                    progress("Priorities", sources: [], unit: "")
                    if let found = store.result?.sections {
                        Divider()
                        Text("ここまでに整理できたこと").accessibilityAddTraits(.isHeader)
                        Text("仕事 \(found.focus.count)件 · よく関わる人 \(found.people.count)人 · 未完了 \(found.openItems)件")
                    }
                    Text("予定は過去90日〜今後45日。メールは直近90日から主要なやり取りを最大100件選び、本文の必要な部分をこのMacで分析します。添付ファイルは読みません。")
                        .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(dark))
                    if failed {
                        Text("データを取得できませんでした。macOSのキーチェーン確認が表示された場合は許可し、接続と読み取り権限を確認してから再試行してください。")
                        Button("再試行") { store.retry() }.buttonStyle(.bordered)
                    } else {
                        Text("件数や通信状況によって時間がかかる場合があります。この画面を離れても続きから確認できます。")
                            .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(dark))
                    }
                }
                if !ready {
                    ProbeButton(id: "initialProfileLater", action: { store.deferUntilRequested() }) { Text("あとでHomeへ") }
                        .buttonStyle(.borderless).accessibilityIdentifier("initialProfileLater")
                    Text("Apps → Connectionsの「Profileを確認」から戻れます。")
                        .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(dark))
                }
                if ready, store.result?.outcomes.contains(where: { $0.status != "synced" }) == true {
                    Text("未接続・未許可・取得に失敗したデータは含まれていません。取得できた範囲だけで整理しています。")
                        .font(.system(size: S.type(TypeScale.microSize))).foregroundStyle(Palette.muted(dark))
                }
            }
            .font(.system(size: S.type(TypeScale.secondarySize)))
            .foregroundStyle(Palette.text(dark))
            .padding(Space.largePadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Palette.canvas(dark))
        .accessibilityIdentifier("initialProfile")
    }

    private func group(_ title: String, _ values: [String], removable: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: Space.compact) {
            Text(title).font(.system(size: S.type(TypeScale.microSize), weight: .semibold)).foregroundStyle(Palette.muted(dark))
            if values.isEmpty || !removable {
                Text(values.isEmpty ? "まだ判断できる情報がありません" : values.joined(separator: "\n"))
                    .font(.system(size: S.type(TypeScale.bodySize))).fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(values, id: \.self) { value in
                    HStack(alignment: .firstTextBaseline, spacing: Space.base) {
                        Text(value).font(.system(size: S.type(TypeScale.bodySize))).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: Space.base)
                        Button("保存しない") { store.reject(value) }
                            .buttonStyle(.borderless).foregroundStyle(Palette.muted(dark))
                            .disabled(store.saving)
                            .accessibilityLabel("「\(value)」を保存しない")
                            .accessibilityIdentifier("initialProfileReject")
                    }
                }
            }
        }
    }

    private func progress(_ label: String, sources: [String], unit: String) -> some View {
        let outcome = store.result?.outcomes.first { sources.contains($0.source) }
        return HStack {
            Image(systemName: outcome?.status == "synced" ? "checkmark.circle" : "circle")
                .accessibilityHidden(true)
            Text(label).frame(maxWidth: .infinity, alignment: .leading)
            Text(outcome.map { value in
                switch value.status {
                case "reading": return "確認しています…"
                case "synced": return "\(value.artifacts)\(unit)"
                case "not_connected": return "未接続"
                case "not_granted": return "読む許可がありません"
                default: return "取得できませんでした"
                }
            } ?? (sources.isEmpty ? "データを確認後に整理" : "取得を待っています"))
                .foregroundStyle(Palette.muted(dark))
        }.accessibilityElement(children: .combine)
    }

    private func listBinding(_ key: WritableKeyPath<InitialProfileSections, [String]>) -> Binding<String> {
        Binding(get: { draft?[keyPath: key].joined(separator: "\n") ?? "" }, set: { text in
            draft?[keyPath: key] = text.split(separator: "\n").map(String.init)
        })
    }
    private var editFields: some View {
        VStack(alignment: .leading, spacing: Space.cardPadding) {
            edit("現在の仕事（5件まで）", \.focus)
            edit("よく関わる人（12人まで）", \.people)
            edit("直近の優先事項（5件まで）", \.priorities)
            edit("仕事の傾向（3件まで）", \.workPattern)
            Stepper("未完了の項目: \(draft?.openItems ?? 0)件", value: Binding(get: { draft?.openItems ?? 0 }, set: { draft?.openItems = $0 }), in: 0...5000)
        }
    }
    private func edit(_ label: String, _ key: WritableKeyPath<InitialProfileSections, [String]>) -> some View {
        VStack(alignment: .leading) {
            Text(label)
            TextField("1行に1項目", text: listBinding(key), axis: .vertical)
                .textFieldStyle(.roundedBorder).accessibilityLabel(label)
        }
    }
}
