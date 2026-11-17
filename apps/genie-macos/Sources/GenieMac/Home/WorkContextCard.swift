import SwiftUI

/// Home の「今日、気にした方がいいこと」。Work Context 仕様 §Home、UI/UX §8.1。
///
/// **大きな札を並べない。**気にすることは最大 3 行、待ち・返すものはその下に 1 行ずつ。
/// どの行も出所を持ち、[出所を見る] でその場に開く。訂正は 1 操作（押したら消える）。
/// 数字は理由（factor.reason）と一緒にだけ出す — 点数だけ見せても、何をすればよいか分からない。
struct WorkContextCard: View {
    @ObservedObject private var store = WorkContextStore.shared
    @ObservedObject private var nav = MainNav.shared
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }

    var body: some View {
        if let ctx = store.context {
            VStack(alignment: .leading, spacing: 6) {
                header(Facts.workContextTitle, trailing: ctx.inferenceEnabled ? coverage(ctx) : "推測を止めています")
                    .accessibilityIdentifier("workContextTitle")
                if !ctx.inferenceEnabled {
                    note("推測を止めているので、気にすることは出しません。今週の事実だけ残しています。")
                } else if ctx.isEmpty {
                    note(ctx.sources.isEmpty
                         ? "まだ何も読んでいません。Apps でメールや予定をつなぐと、ここに集まります。"
                         : "いま急ぐものはありません。")
                } else {
                    ForEach(ctx.priorities.prefix(3)) { p in priorityRow(p) }
                    if !ctx.waitingOn.isEmpty {
                        header(Facts.workWaitingTitle, trailing: nil).padding(.top, 4)
                        ForEach(ctx.waitingOn.prefix(4)) { w in
                            lineRow(id: w.id, icon: "hourglass",
                                    lead: w.who, text: w.what,
                                    meta: w.sinceDays >= 1 ? "\(Int(w.sinceDays)) 日" : "今日",
                                    project: w.project, sources: w.sources, correction: "dismiss")
                        }
                    }
                    if !ctx.owed.isEmpty {
                        header(Facts.workOwedTitle, trailing: nil).padding(.top, 4)
                        ForEach(ctx.owed.prefix(4)) { o in
                            lineRow(id: o.id, icon: "arrowshape.turn.up.left",
                                    lead: o.to, text: o.what,
                                    meta: WorkFormat.due(o.dueAt), project: o.project,
                                    sources: o.sources, correction: "done",
                                    candidate: o.confirmed == true ? .registered : .candidate)
                        }
                    }
                }
                if ctx.week.meetingHours > 0 || ctx.week.deadlines > 0 || ctx.week.unanswered > 0 || ctx.week.waiting > 0 {
                    WorkPressureView(week: ctx.week).padding(.top, 4)
                }
                personalizationRow
                if let failure = store.failure {
                    Text(failure)
                        .font(.system(size: S.type(TypeScale.microSize)))
                        .foregroundStyle(Palette.warning(dark))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("workContextCard")
        }
    }

    // MARK: 気にすること 1 件

    private func priorityRow(_ p: WorkPriority) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                // 点数は**縦の線の濃さ**でだけ見せる。数字を大きく出すと、それを競う画面になる。
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Palette.accent(dark).opacity(0.25 + 0.75 * p.score))
                    .frame(width: 3, height: 18)
                    .offset(y: 2)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        // 件名から作った案件名は題と同じ文になる。同じ文を 2 度読ませない。
                        if !WorkFormat.repeats(p.project, in: p.title) {
                            Text(p.project)
                                .font(.system(size: S.type(TypeScale.microSize), weight: .semibold))
                                .foregroundStyle(Palette.muted(dark))
                                .tracking(0.3)
                        }
                        // 点数は言葉で（高 / 中 / 低）。式は見せない。
                        Text(WorkFormat.level(p.score))
                            .font(.system(size: S.type(TypeScale.captionSize), weight: .semibold))
                            .foregroundStyle(p.score >= 0.5 ? Palette.warning(dark) : Palette.muted(dark))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().stroke(Color.hairline(dark)))
                            .accessibilityIdentifier("workLevel-\(p.id)")
                        if let due = WorkFormat.due(p.dueAt) {
                            Text(due)
                                .font(.system(size: S.type(TypeScale.microSize), weight: .medium))
                                .foregroundStyle(dueTint(p.dueAt))
                        }
                    }
                    Text(p.title)
                        .font(.system(size: S.type(TypeScale.bodySize), weight: .medium))
                        .foregroundStyle(Palette.text(dark))
                        .lineLimit(2)
                    // 状況は 1 行に寄せる（· で繋ぐ）。1 件が 3〜4 行の札になると、3 件で 1 面が埋まる。
                    if !p.lines.isEmpty {
                        Text(p.lines.prefix(3).joined(separator: " · "))
                            .font(.system(size: S.type(TypeScale.secondarySize)))
                            .foregroundStyle(Palette.muted(dark))
                            // 右 Panel を開いて幅が縮んだときに「…」で切らない（盲検 a752c92）。広いときは 1 行のまま。
                            .lineLimit(2)
                    }
                    HStack(spacing: 10) {
                        Text(WorkFormat.counts(p.counts))
                            .font(.system(size: S.type(TypeScale.captionSize)))
                            .foregroundStyle(Palette.muted(dark))
                        // 状況の行に同じ言葉（「今日が期限」など）があれば繰り返さない。
                        if let top = p.factors.max(by: { $0.contribution < $1.contribution }), !top.reason.isEmpty,
                           !p.lines.prefix(3).contains(where: { $0.contains(top.reason) }) {
                            Text(top.reason)
                                .font(.system(size: S.type(TypeScale.captionSize)))
                                .foregroundStyle(Palette.muted(dark))
                                .lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 12)
                actions(id: p.id, sources: p.sources, correction: "not_priority", label: Facts.workNotPriority, why: true)
            }
            if store.evidenceOpen.contains(p.id) {
                why(p).padding(.leading, 13)
            }
        }
        .padding(.horizontal, S.metric(Space.cardPadding))
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.cardSurface(dark))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.hairline(dark))))
        .accessibilityIdentifier("workPriority-\(p.id)")
    }

    // MARK: 待ち / 返すもの 1 行

    /// メール等から推測した TODO か、本人が確かめた TODO か。推測は確かめるまで TODO にしない。
    enum TodoState { case candidate, registered }

    private func lineRow(id: String, icon: String, lead: String, text: String, meta: String?,
                         project: String?, sources: [WorkProvenance], correction: String,
                         candidate: TodoState? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.muted(dark))
                    .frame(width: 14)
                Text(lead)
                    .font(.system(size: S.type(TypeScale.secondarySize), weight: .medium))
                    .foregroundStyle(Palette.text(dark))
                    .lineLimit(1)
                Text(text)
                    .font(.system(size: S.type(TypeScale.secondarySize)))
                    .foregroundStyle(Palette.text(dark))
                    .lineLimit(1)
                if let project {
                    Text(project)
                        .font(.system(size: S.type(TypeScale.captionSize)))
                        .foregroundStyle(Palette.muted(dark))
                }
                if let candidate { todoTag(candidate, id: id) }
                Spacer(minLength: 12)
                if let meta {
                    Text(meta)
                        .font(.system(size: S.type(TypeScale.microSize)))
                        .foregroundStyle(Palette.muted(dark))
                }
                if let candidate {
                    todoActions(id: id, sources: sources, state: candidate)
                } else {
                    actions(id: id, sources: sources, correction: correction,
                            label: correction == "done" ? Facts.workDone : Facts.workDismiss)
                }
            }
            if store.evidenceOpen.contains(id) {
                evidence(sources).padding(.leading, 24)
            }
        }
        .padding(.horizontal, S.metric(Space.cardPadding))
        .frame(minHeight: 28)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("workItem-\(id)")
    }

    /// 「なぜ重要？」: 理由（要因の言葉、寄与の大きい順に最大 4 行）と出所。数式は見せない。1 回押すだけ。
    private func why(_ p: WorkPriority) -> some View {
        let reasons = WorkFormat.reasons(p)
        return VStack(alignment: .leading, spacing: 4) {
            Text(Facts.workWhy)
                .font(.system(size: S.type(TypeScale.captionSize), weight: .semibold))
                .foregroundStyle(Palette.muted(dark))
                .padding(.top, 4)
            ForEach(Array(reasons.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.system(size: S.type(TypeScale.secondarySize)))
                    .foregroundStyle(Palette.text(dark))
            }
            Text(Facts.sourceLabel)
                .font(.system(size: S.type(TypeScale.captionSize), weight: .semibold))
                .foregroundStyle(Palette.muted(dark))
                .padding(.top, 4)
            evidence(p.sources)
        }
        .accessibilityIdentifier("workWhy-\(p.id)")
    }

    /// [出所を見る]（案件は [なぜ重要？]）と訂正。どちらも 1 回押すだけ。
    private func actions(id: String, sources: [WorkProvenance], correction: String, label: String, why: Bool = false) -> some View {
        HStack(spacing: 4) {
            Button {
                if store.evidenceOpen.contains(id) { store.evidenceOpen.remove(id) } else { store.evidenceOpen.insert(id) }
            } label: {
                // 開いている間は「閉じる」。同じ字のままだと、どこを押せば畳めるか分からない（盲検 6ebeaf3）
                Text(store.evidenceOpen.contains(id) ? Facts.workClose : (why ? Facts.workWhy : Facts.workEvidence))
                    .font(.system(size: S.type(TypeScale.microSize), weight: .medium))
                    .foregroundStyle(Palette.accent(dark))
                    .frame(height: 26).padding(.horizontal, 8)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
            .accessibilityIdentifier("workEvidence-\(id)")
            Button {
                store.correct(id, action: correction)
            } label: {
                Text(label)
                    .font(.system(size: S.type(TypeScale.microSize)))
                    .foregroundStyle(Palette.muted(dark))
                    .frame(height: 26).padding(.horizontal, 8)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
            .accessibilityIdentifier("workCorrect-\(id)")
        }
    }

    /// 「メール由来・候補」か「登録済み」か。色は使わず、枠と語で分ける（accent は 1 列だけ）。
    private func todoTag(_ state: TodoState, id: String) -> some View {
        Text(state == .registered ? Facts.workRegistered : Facts.workCandidate)
            .font(.system(size: S.type(TypeScale.captionSize), weight: .semibold))
            .foregroundStyle(state == .registered ? Palette.text(dark) : Palette.muted(dark))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().stroke(Color.hairline(dark)))
            .fixedSize()
            .accessibilityIdentifier("workTodoState-\(id)")
    }

    /// 候補: [出所を見る] [TODOに追加] [自分の担当ではない] [対応済み]。登録済み: [出所を見る] [対応済み]。
    /// どれも 1 回押すだけ。「担当ではない」は dismiss（理由を note に残す）。
    private func todoActions(id: String, sources: [WorkProvenance], state: TodoState) -> some View {
        HStack(spacing: 4) {
            Button {
                if store.evidenceOpen.contains(id) { store.evidenceOpen.remove(id) } else { store.evidenceOpen.insert(id) }
            } label: {
                Text(store.evidenceOpen.contains(id) ? Facts.workClose : Facts.workEvidence)
                    .font(.system(size: S.type(TypeScale.microSize), weight: .medium))
                    .foregroundStyle(Palette.accent(dark))
                    .fixedSize()
                    .frame(height: 26).padding(.horizontal, 8)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
            .accessibilityIdentifier("workEvidence-\(id)")
            if state == .candidate {
                todoButton(Facts.workConfirm, id: "workConfirm-\(id)") { store.correct(id, action: "confirm") }
                todoButton(Facts.workNotMine, id: "workNotMine-\(id)", spoken: Facts.workNotMineSpoken) {
                    store.correct(id, action: "dismiss", note: "not_mine")
                }
            }
            todoButton(Facts.workHandled, id: "workHandled-\(id)") { store.correct(id, action: "done") }
        }
        // 出所と操作は削らない。幅が足りなければ件名の方を「…」にする。
        .fixedSize()
        .layoutPriority(1)
    }

    private func todoButton(_ label: String, id: String, spoken: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: S.type(TypeScale.microSize)))
                .foregroundStyle(Palette.muted(dark))
                .fixedSize()
                .frame(height: 26).padding(.horizontal, 8)
        }
        .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
        .accessibilityLabel(spoken ?? label)
        .accessibilityIdentifier(id)
    }

    /// 出所の一覧。**抜粋だけ。**本文はここにも無い。
    private func evidence(_ sources: [WorkProvenance]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(sources.prefix(6)) { s in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(WorkFormat.sourceName(s.source))
                        .font(.system(size: S.type(TypeScale.captionSize), weight: .semibold))
                        .foregroundStyle(Palette.muted(dark))
                        .frame(width: 44, alignment: .leading)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(s.label)
                            .font(.system(size: S.type(TypeScale.captionSize)))
                            .foregroundStyle(Palette.text(dark))
                            .lineLimit(1)
                        if let excerpt = s.excerpt, !excerpt.isEmpty {
                            Text(excerpt)
                                .font(.system(size: S.type(TypeScale.captionSize)))
                                .foregroundStyle(Palette.muted(dark))
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                    if let url = s.url, let link = URL(string: url) {
                        Button { NSWorkspace.shared.open(link) } label: {
                            Image(systemName: "arrow.up.right.square")
                                .font(.system(size: 10))
                                .foregroundStyle(Palette.muted(dark))
                                .frame(width: 22, height: 22)
                        }
                        .buttonStyle(GenieControlStyle(radius: 6, base: 0.0))
                    }
                }
            }
        }
        .padding(.top, 4)
        .accessibilityIdentifier("workEvidenceList")
    }

    /// Genie が使っている本人の情報への入口。**Home に隠さない。**
    private var personalizationRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "person.crop.circle")
                .font(.system(size: 11))
                .foregroundStyle(Palette.muted(dark))
            Text(Facts.personalizationTitle)
                .font(.system(size: S.type(TypeScale.microSize)))
                .foregroundStyle(Palette.muted(dark))
            if let p = store.profile {
                Text(p.inferenceEnabled ? "\(p.all.filter(\.enabled).count) 件を使っています" : "推測を止めています")
                    .font(.system(size: S.type(TypeScale.microSize)))
                    .foregroundStyle(Palette.muted(dark))
            }
            Spacer(minLength: 8)
            Button { nav.personalizationOpen = true } label: {
                Text(Facts.personalizationEdit)
                    .font(.system(size: S.type(TypeScale.microSize), weight: .medium))
                    .foregroundStyle(Palette.accent(dark))
                    .frame(height: 26).padding(.horizontal, 8)
            }
            .buttonStyle(GenieControlStyle(radius: 7, base: 0.0))
            .accessibilityIdentifier("openPersonalization")
        }
        .padding(.horizontal, S.metric(Space.cardPadding))
    }

    /// どこから整理しているか（事実）。「全部把握している」と誤解させない。
    private func coverage(_ ctx: WorkContext) -> String? {
        let names = ctx.sources.keys
            .filter { !["astra_task", "meeting", "screenshot", "file", "browser"].contains($0) }
            .map(WorkFormat.sourceName)
        let uniq = Array(Set(names)).sorted()
        guard !uniq.isEmpty else { return nil }
        // 今日の整理でなければ、いつの整理かを書く（期限の言葉「今日が期限」はその日の値）。
        if let at = WorkFormat.parse(ctx.generatedAt), !Calendar.current.isDateInToday(at) {
            let day = DateFormatter(); day.dateFormat = "M/d"
            return uniq.joined(separator: " · ") + " から \(day.string(from: at)) 時点で整理"
        }
        return uniq.joined(separator: " · ") + " から整理しています"
    }

    private func header(_ title: String, trailing: String?) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.system(size: S.type(TypeScale.microSize), weight: .semibold))
                .foregroundStyle(Palette.muted(dark))
                .tracking(0.4)
            if let trailing {
                Text(trailing)
                    .font(.system(size: S.type(TypeScale.captionSize)))
                    .foregroundStyle(Palette.muted(dark))
            }
        }
        .padding(.top, 6)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.system(size: S.type(TypeScale.secondarySize)))
            .foregroundStyle(Palette.muted(dark))
            .padding(.horizontal, S.metric(Space.cardPadding))
            .accessibilityIdentifier("workContextNote")
    }

    private func dueTint(_ iso: String?) -> Color {
        guard let iso, let date = WorkFormat.parse(iso) else { return Palette.muted(dark) }
        return date.timeIntervalSinceNow < 36 * 3600 ? Palette.warning(dark) : Palette.muted(dark)
    }
}
