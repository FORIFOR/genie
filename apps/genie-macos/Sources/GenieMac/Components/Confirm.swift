import AppKit
import GenieApproval

/// `Confirm.approve` の答え。**「やめた」と「答えが無い」を分ける。**
///
/// backend に REJECTED を送る（backend はその仕事を CANCELLED にする）のは `.declined` だけ。
/// 以前は時間切れ・見えないカード・headless も「やめた」と同じに扱っていたので、
/// 承認カードの間に話し始める（Listening がカードを隠す）だけで、2 分後に仕事が取り消されていた。
/// 証拠（`UserApproval`）はコピーできないので、この答えもコピーできない。
enum ApprovalAnswer: ~Copyable {
    /// 人がカードで「実行する」を押した。証拠を持って帰る。
    case approved(UserApproval)
    /// 人が「やめる」または Escape を押した。
    case declined
    /// 答えが無い（時間切れ・カードを出せない・headless）。承認は PENDING のまま残す。
    case unanswered
}

/// 戻せない操作の前に一度だけ聞く。
///
/// これまでアプリ全体に確認が **1 つも無かった**。録音中に「Genie を終了」を押すと
/// 会議が黙って消え、Apps の「切断」は一度の誤クリックで繋ぎ直しになった。
/// 文言は「何が起きるか」を先に書き、既定のボタンは**安全な方**にする。
enum Confirm {
    /// §16/§17 の正式な入口。**確認の要否は risk が決める**（呼び出し側では決めない）。
    /// R0/R1 は聞かずに true を返す。R2/R3 はカードを出して答えを待つ。
    @MainActor
    static func ask(_ confirmation: ActionConfirmation) -> Bool {
        guard confirmation.risk.needsConfirmation else { return true }
        return present(confirmation)
    }

    /// `ask` の止まらない版。async の文脈（ReplyFlow など）からはこちらが選ばれる。
    /// 同期の `ask` を async の中（メインキューの仕事の中）で待つと、メインキューが止まり、
    /// Dock の中身を戻す処理も検査の自動操作も進まない。
    @MainActor
    static func ask(_ confirmation: ActionConfirmation) async -> Bool {
        guard confirmation.risk.needsConfirmation else { return true }
        return await answer(confirmation, timeout: 120) == true
    }

    /// 承認を外へ渡す入口。**カードを出し、人が「実行する」を押したときだけ**証拠を返す。
    ///
    /// `ask` と違い、R0/R1 でも通さない（`.unanswered`）。カードを出さずに証拠は作らない。
    /// backend の承認は `ActionConfirmation(backendApproval:)` が R2 以上に上げてから渡す。
    ///
    /// **待つ間、メインスレッドを回し続けない（suspend する）。**以前は CFRunLoopRunInMode を
    /// 空回ししていたので、人のクリックやキーがボタンまで届かず（NSApp.sendEvent を通らない）、
    /// `await MainActor.run` の中ではメインキューも止まり、120 秒後に必ず「承認しない」になっていた。
    @MainActor
    static func approve(_ confirmation: ActionConfirmation, timeout: TimeInterval = 120) async -> ApprovalAnswer {
        guard confirmation.risk.needsConfirmation else { return .unanswered }
        switch await answer(confirmation, timeout: timeout) {
        case true?: return .approved(ApprovalLedger.issue(forPressedCard: confirmation.id))
        case false?: return .declined
        case nil: return .unanswered
        }
    }

    /// カードを出し、答え（true = 実行する / false = やめる / nil = 答えが無い）を待つ。
    /// 答えたのが人であることは、Dock のボタン / 鍵か確認の面（`ConfirmationPresenter`）から、
    /// **描いたカードの id 付きで**来た答えであることで保つ。
    @MainActor
    private static func answer(_ confirmation: ActionConfirmation, timeout: TimeInterval) async -> Bool? {
        let store = GenieStateStore.shared
        // Dock が出ているなら、聞く面は Dock の 1 枚だけ。出ていなければ確認の面を 1 枚出す。
        var panel: NSPanel?
        if !WindowCoordinator.shared.isVoiceHUDVisible {
            guard let shown = ConfirmationPresenter.show(confirmation) else { return nil }   // headless: 聞けない＝答えは無い
            panel = shown
        }
        store.requireConfirmation(confirmation)
        let answer = await waitForAnswer(confirmation.id, timeout: timeout)
        panel?.orderOut(nil)
        if answer == nil { store.withdrawConfirmation(confirmation.id) }
        return answer
    }

    /// カード（id）への答えを**止まらずに**待つ。true = 実行する / false = やめる / nil = 期限までに答えが無い。
    @MainActor
    static func waitForAnswer(_ id: UUID, timeout: TimeInterval) async -> Bool? {
        await ConfirmationWaiter.wait(for: id, timeout: timeout)
    }

    /// `ask` の同期の待ち。答えは bus で受け取る。120 秒待って答えが無ければ取消（黙って実行しない）。
    ///
    /// 同期で待つ呼び出し（終了・切断などの `ask`）が残っているので、ここでは待つ間も
    /// **NSEvent を取り出して配る**（CFRunLoopRunInMode の空回しでは人のクリックがボタンへ届かない）。
    @MainActor
    private static func present(_ confirmation: ActionConfirmation) -> Bool {
        let store = GenieStateStore.shared
        var panel: NSPanel?
        if !WindowCoordinator.shared.isVoiceHUDVisible {
            guard let shown = ConfirmationPresenter.show(confirmation) else { return false }
            panel = shown
        }
        store.requireConfirmation(confirmation)
        var answer: Bool?
        let bus = GenieEventBus.shared
        let token = bus.subscribe { event in
            if case .confirmationResolved(let id, let approved) = event, id == confirmation.id {
                answer = approved
            }
        }
        defer { bus.unsubscribe(token) }
        let deadline = Date().addingTimeInterval(120)
        while answer == nil, Date() < deadline {
            if let event = NSApp.nextEvent(matching: .any, until: Date().addingTimeInterval(0.05),
                                           inMode: .default, dequeue: true) {
                NSApp.sendEvent(event)
            }
        }
        panel?.orderOut(nil)
        if answer == nil { store.withdrawConfirmation(confirmation.id) }
        return answer ?? false
    }

    /// 旧入口。risk を持たない呼び出しが残っている間の橋渡しで、R3 として扱う。
    /// destructive を選んだら true。ボタンの並びは macOS の作法（右が既定＝安全側）。
    @MainActor
    static func destructive(_ title: String, detail: String, confirm: String, cancel: String = Facts.confirmationCancel) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: cancel)   // 先に足した方が既定になる
        alert.addButton(withTitle: confirm)
        return alert.runModal() == .alertSecondButtonReturn
    }
}

/// カードの答えを**止まらずに**待つ。答えは bus の `.confirmationResolved` で届き、
/// 期限は Task.sleep との競争で作る。待っている間も通常のイベントループが回るので、
/// 人のクリック・鍵・メインキューの仕事（Dock の中身を戻す asyncAfter など）はそのまま進む。
@MainActor
private final class ConfirmationWaiter {
    private var continuation: CheckedContinuation<Bool?, Never>?
    private var token: UUID?
    private var timer: Task<Void, Never>?

    static func wait(for id: UUID, timeout: TimeInterval) async -> Bool? {
        let waiter = ConfirmationWaiter()
        // 購読と期限のどちらもが waiter を強く持つ（finish が両方を外すまで生きている）。
        // 弱く持つと、最適化で待っている最中に waiter が消え、答えが永久に届かない。
        return await withCheckedContinuation { continuation in
            waiter.continuation = continuation
            waiter.token = GenieEventBus.shared.subscribe { event in
                if case .confirmationResolved(let resolved, let approved) = event, resolved == id {
                    waiter.finish(approved)
                }
            }
            waiter.timer = Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                waiter.finish(nil)
            }
        }
    }

    private func finish(_ answer: Bool?) {
        guard let continuation else { return }
        self.continuation = nil
        if let token { GenieEventBus.shared.unsubscribe(token) }
        token = nil
        timer?.cancel()
        timer = nil
        continuation.resume(returning: answer)
    }
}

// MARK: - backend の承認 → 確認カード

extension ActionConfirmation {
    /// カードが出てから「実行する」/ ⌘Return を受け付けるまでの間（秒）。
    /// 面の入れ替え（Dock の縮み 180ms + 中身を戻す 55ms）より長くする。中身が見えない間の押下を実行にしない。
    static let proceedArmDelay: TimeInterval = 0.3

    /// backend が止めて待っている承認（`GET /v1/tasks/:id/approvals` の 1 件）を、既存の確認カードにする。
    ///
    /// 題は server の summary をそのまま使う（receipt に「承認したときに読んだ文面」として残るのはこれ）。
    /// **risk は R2 未満にしない。** backend が承認を求めた時点で、聞かずに通す段ではない。
    /// 値は直せない（editable_fields は空）ので、params / preview は使わず details の行だけにする
    /// —— params を置くと「直す」が出て、直した値が実行に届かない（宣言だけの編集）になる。
    /// 行は 4 行・1 行 60 字まで。確認の面は上限 360pt で、超えるとボタンが切れる。
    /// 4 行を超えるときは server の順で先頭から残すが、**`backendDetailKeep` の行は必ず残す**
    /// （先頭 4 行で切っていたので、computer.run の「画像の送信先」が常に落ちていた。
    /// 外へ画像が出ることを、唯一の人の関門で一度も見せないことになる）。
    init(backendApproval a: BackendApproval) {
        var rows: [(label: String, line: String)] = []
        var seen: Set<String> = []
        for d in a.details {
            guard let label = Self.backendDetailLabel(d.label) else { continue }
            let value = d.value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, seen.insert(value).inserted else { continue }
            rows.append((label, "\(label): \(value.count > 60 ? String(value.prefix(59)) + "…" : value)"))
        }
        let kept = rows.filter { Self.backendDetailKeep.contains($0.label) }.count
        var room = max(0, 4 - kept)
        var lines: [String] = []
        for row in rows {
            if Self.backendDetailKeep.contains(row.label) { lines.append(row.line) }
            else if room > 0 { lines.append(row.line); room -= 1 }
        }
        if let impact = a.impact {
            if let count = impact.affectedCount { lines.append("対象: \(count)件") }
            if !impact.reversible { lines.append(impact.recoveryNote ?? "実行後は取り消せません。") }
            else if let note = impact.recoveryNote { lines.append(note) }
        }
        self.init(app: nil, appIcon: nil,
                  title: a.summary.isEmpty ? "この操作を実行します" : a.summary,
                  details: lines,
                  risk: max(ActionRiskLevel(backend: a.risk), .r2),
                  confirmLabel: a.impact?.primaryActionLabel ?? "実行する")
    }

    /// server の details の label は 2 通りある。引数の名前（`goal` 等。一般の段）と、
    /// server が画面向けに書いた語（`目的` 等。computer.run の段）。
    /// 引数の名前は**画面に出してよいものだけ**を訳し、ここに無いもの（thread_id / message_id などの
    /// 内部の識別子）は出さない。英数字だけでない label は server が画面向けに書いたものとしてそのまま出す。
    static let backendDetailLabels: [String: String] = [
        "goal": "目的", "successCriteria": "完了の条件",
        "subject": "件名", "body": "本文", "comment": "本文",
    ]

    /// 4 行に収めるときも落とさない行。外へ何が出るか（画像の送信先）は、題（summary）にも
    /// 他の行にも書かれていない。落ちるのは summary と重なる行（「確認」「影響」）の方にする。
    static let backendDetailKeep: Set<String> = ["画像の送信先"]

    static func backendDetailLabel(_ raw: String) -> String? {
        if let known = backendDetailLabels[raw] { return known }
        let written = raw.trimmingCharacters(in: .whitespaces)
        guard !written.isEmpty, !written.unicodeScalars.allSatisfy(\.isASCII) else { return nil }
        return written
    }
}
