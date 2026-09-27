import XCTest
import GenieApproval
import GenieCore
@testable import GenieMac

/// 「声・会話・自動の経路から承認を通せない」を、網を使わずに確かめる。
///
/// `UserApproval` は検査からも作れない（init は GenieApproval モジュールの internal で、
/// ここは `@testable import GenieApproval` しない）。なので「押された」側の経路はここでは通せず、
/// 通せないこと自体が境界の証拠になる。押されなかった・答えが無かった・カードが出なかった側を確かめる。
/// 本物のキーで「押された」側が通ることは `--selftest approval-press` が確かめる。
@MainActor final class ApprovalBoundaryTests: XCTestCase {
    private final class Log {
        var shown: [ActionConfirmation] = []
        var approved: [String] = []
        var rejected: [String] = []
        var followed = 0
    }
    /// 検査の時計。待った分だけ進める（実時間では待たない）。
    private final class Clock {
        var now = Date(timeIntervalSince1970: 0)
        func advance(_ ms: UInt64) { now.addTimeInterval(Double(ms) / 1000) }
    }

    private func approval(_ id: String, risk: String = "EXTERNAL_COMMIT", summary: String = "開始時に対象と送信先を確認します") -> BackendApproval {
        BackendApproval(id: id, summary: summary, risk: risk,
                        details: [.init(label: "goal", value: "メモを整理する")])
    }

    /// 答えの種類（証拠はコピーできないので、名前だけを見る）。
    private func kind(_ answer: consuming ApprovalAnswer) -> String {
        switch consume answer {
        case .approved: return "approved"
        case .declined: return "declined"
        case .unanswered: return "unanswered"
        }
    }

    private func card(_ title: String, risk: ActionRiskLevel = .r2) -> ActionConfirmation {
        ActionConfirmation(title: title, details: [], risk: risk, confirmLabel: "送る")
    }

    /// 同期の `ask`（async の文脈では止まらない版が選ばれるので、同期の関数から呼ぶ）。
    private func syncAsk(_ c: ActionConfirmation) -> Bool { Confirm.ask(c) }

    /// 検査で出したカードを全部引っ込める（ほかの検査の Dock を止めない）。
    private func clearCards() {
        let store = GenieStateStore.shared
        while let shown = store.state.confirmation { store.withdrawConfirmation(shown.id) }
    }

    override func tearDown() async throws {
        clearCards()
        try await super.tearDown()
    }

    // MARK: - risk の写し

    func testBackendRiskMapsToFourLevelsAndUnknownIsTheHeaviest() {
        XCTAssertEqual(ActionRiskLevel(backend: "READ"), .r0)
        XCTAssertEqual(ActionRiskLevel(backend: "REVERSIBLE_WRITE"), .r1)
        XCTAssertEqual(ActionRiskLevel(backend: "EXTERNAL_COMMIT"), .r2)
        XCTAssertEqual(ActionRiskLevel(backend: "DESTRUCTIVE"), .r3)
        XCTAssertEqual(ActionRiskLevel(backend: "REGULATED"), .r3)
        XCTAssertEqual(ActionRiskLevel(backend: "FINANCIAL"), .r3)
        XCTAssertEqual(ActionRiskLevel(backend: ""), .r3, "分からないものを軽く見積もらない")
        XCTAssertEqual(ActionRiskLevel(backend: "external_commit"), .r3)
    }

    func testBackendApprovalCardIsNeverBelowR2SoItIsAlwaysShown() {
        for risk in ["READ", "REVERSIBLE_WRITE", "EXTERNAL_COMMIT", "DESTRUCTIVE", "REGULATED", "FINANCIAL", "?"] {
            let card = ActionConfirmation(backendApproval: approval("a", risk: risk))
            XCTAssertGreaterThanOrEqual(card.risk, .r2, risk)
            XCTAssertTrue(card.risk.needsConfirmation, risk)
        }
        XCTAssertEqual(ActionConfirmation(backendApproval: approval("a", risk: "READ")).risk, .r2)
        XCTAssertEqual(ActionConfirmation(backendApproval: approval("a", risk: "FINANCIAL")).risk, .r3)
    }

    // MARK: - 証拠は、カードを出さずには作らない

    func testConfirmApproveNeverMintsProofForTheR0R1Shortcut() async {
        let before = GenieStateStore.shared.state.confirmation
        for risk in [ActionRiskLevel.r0, .r1] {
            let c = ActionConfirmation(title: "メモを保存します", details: [], risk: risk, confirmLabel: "保存する")
            XCTAssertTrue(syncAsk(c), "ask は従来どおり聞かずに通す")
            let asked = await Confirm.ask(c)
            XCTAssertTrue(asked, "止まらない ask も同じく聞かずに通す")
            let answer = kind(await Confirm.approve(c))
            XCTAssertEqual(answer, "unanswered", "聞いていないのに承認の証拠を作った（\(risk)）")
        }
        XCTAssertEqual(GenieStateStore.shared.state.confirmation, before, "カードを出していないこと")
    }

    /// 窓を出せない（headless）のは「やめた」ではない。証拠も作らず、答えの知らせも流さない。
    func testHeadlessIsUnansweredNotDeclined() async {
        let headless = WindowCoordinator.headless
        WindowCoordinator.headless = true
        defer { WindowCoordinator.headless = headless }
        var resolved: [Bool] = []
        let token = GenieEventBus.shared.subscribe { e in
            if case .confirmationResolved(_, let approved) = e { resolved.append(approved) }
        }
        defer { GenieEventBus.shared.unsubscribe(token) }
        let answer = kind(await Confirm.approve(card("外へ送ります")))
        XCTAssertEqual(answer, "unanswered")
        XCTAssertTrue(resolved.isEmpty, "答えていないのに「やめた」として流れた")
        XCTAssertNil(GenieStateStore.shared.state.confirmation, "見えないカードを残した")
    }

    /// 答えを待つ間、メインを止めない（以前は run loop を空回しし、人のクリックもメインキューも止まった）。
    /// 期限の前に答えが来れば、その答えで返る。期限が来れば「答えが無い」（nil）で返る。
    func testWaitingForAnAnswerDoesNotBlockTheMainActor() async {
        let store = GenieStateStore.shared
        let c = card("外へ送ります")
        store.requireConfirmation(c)
        var mainRan = false
        Task { @MainActor in mainRan = true }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 50_000_000)
            store.resolveConfirmation(id: c.id, approved: false)
        }
        let answered = await Confirm.waitForAnswer(c.id, timeout: 5)
        XCTAssertEqual(answered, false, "描いたカードへの「やめる」が届かない")
        XCTAssertTrue(mainRan, "待っている間にメインの仕事が進まなかった")
        let started = Date()
        let late = await Confirm.waitForAnswer(UUID(), timeout: 0.2)
        XCTAssertNil(late, "答えていないのに答えが来た")
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
    }

    // MARK: - server の形

    func testPendingApprovalsParseTheServerShapeIntoACardWithoutFakeEdits() throws {
        let json = """
        {"items":[{"id":"ap-1","summary":"開始時に対象と送信先を確認します","risk":"EXTERNAL_COMMIT","expires_at":"2026-09-25T00:00:00.000Z",
          "details":{"items":[{"label":"goal","value":"メモを整理する"},{"label":"successCriteria","value":"メモを整理する"},{"label":"thread_id","value":"t-123"}],
                     "impact":{"primary_action_label":"実行する","affected_count":null,"scope":"external","reversible":false,"recovery_note":null}}},
          {"summary":"id の無いものは承認として扱わない","risk":"READ"},
          {"id":"ap-old","summary":"古い行","risk":"DESTRUCTIVE","details":[{"label":"subject","value":"件名"},{"label":"count","value":3}]}]}
        """
        let items = BackendApproval.parse(json)
        XCTAssertEqual(items.map(\.id), ["ap-1", "ap-old"])
        let first = try XCTUnwrap(items.first)
        XCTAssertEqual(first.impact?.primaryActionLabel, "実行する")
        XCTAssertEqual(first.impact?.external, true)
        XCTAssertNil(first.impact?.affectedCount)
        XCTAssertEqual(items[1].detail("count"), "3")

        let card = ActionConfirmation(backendApproval: first)
        XCTAssertEqual(card.title, "開始時に対象と送信先を確認します", "題は server の summary（receipt に残る文面）そのまま")
        XCTAssertEqual(card.confirmLabel, "実行する")
        XCTAssertTrue(card.params.isEmpty, "直せない値を params に置くと「直す」が出て、直した値が届かない")
        XCTAssertNil(card.preview)
        XCTAssertEqual(card.details.first, "目的: メモを整理する")
        XCTAssertEqual(card.details.filter { $0.contains("メモを整理する") }.count, 1, "同じ値を二度並べない")
        XCTAssertFalse(card.details.joined().contains("t-123"), "内部の識別子は出さない")
        XCTAssertEqual(ActionConfirmation(backendApproval: items[1]).risk, .r3)

        XCTAssertTrue(BackendApproval.parse("not json").isEmpty)
        XCTAssertTrue(BackendApproval.parse(#"{"items":[]}"#).isEmpty)
    }

    /// computer.run の承認は、server が画面向けの語（目的・範囲…）を label に書いてくる。
    /// 引数の名前だけを訳す作りだと、それを全部捨てて題だけのカードになっていた。
    func testServerWrittenLabelsAreShownAndTheCardStaysWithinTheConfirmationCap() throws {
        let long = String(repeating: "あ", count: 200)
        let json = """
        {"items":[{"id":"ap-cu","summary":"対象の窓1つを、1操作ごとの確認なしで最大12操作・5分まで操作します","risk":"EXTERNAL_COMMIT",
          "details":{"items":[{"label":"目的","value":"メモを整理する"},
                              {"label":"範囲","value":"対象の窓1つだけ。開始時に決め、途中でほかの窓やアプリへ移りません"},
                              {"label":"確認","value":"この承認のあとは、1操作ごとには確認しません（最大12操作・5分）"},
                              {"label":"影響","value":"\(long)"},
                              {"label":"画像の送信先","value":"この端末で設定したモデル"},
                              {"label":"message_id","value":"m-1"}],
                     "impact":{"primary_action_label":"画面の操作を始める","affected_count":null,"scope":"external","reversible":false,"recovery_note":null}}}]}
        """
        let card = ActionConfirmation(backendApproval: try XCTUnwrap(BackendApproval.parse(json).first))
        XCTAssertEqual(card.title, "対象の窓1つを、1操作ごとの確認なしで最大12操作・5分まで操作します")
        XCTAssertEqual(card.confirmLabel, "画面の操作を始める")
        XCTAssertEqual(card.risk, .r2)
        XCTAssertEqual(card.details, [
            "目的: メモを整理する",
            "範囲: 対象の窓1つだけ。開始時に決め、途中でほかの窓やアプリへ移りません",
            "確認: この承認のあとは、1操作ごとには確認しません（最大12操作・5分）",
            "画像の送信先: この端末で設定したモデル",
            "実行後は取り消せません。",
        ], "server の行は 4 行まで + 取り消せないことの 1 行。画像の送信先は必ず残し、summary と重なる影響を落とす")
        let long_ = ActionConfirmation(backendApproval: BackendApproval(id: "x", summary: "s", risk: "EXTERNAL_COMMIT",
            details: [.init(label: "影響", value: long)]))
        XCTAssertEqual(long_.details.first?.count, "影響: ".count + 60, "1 行は 60 字まで（面の上限 360pt でボタンを切らない）")
        XCTAssertTrue(long_.details.first?.hasSuffix("…") == true)
        XCTAssertFalse(card.details.joined().contains("m-1"), "英数字だけの label（内部の識別子）は出さない")
        XCTAssertNil(ActionConfirmation.backendDetailLabel("thread_id"))
        XCTAssertNil(ActionConfirmation.backendDetailLabel(" "))
        XCTAssertEqual(ActionConfirmation.backendDetailLabel("subject"), "件名")
        XCTAssertEqual(ActionConfirmation.backendDetailLabel("画像の送信先"), "画像の送信先")
    }

    /// server（services/task の computerRunApproval）が実際に返す並び。完了の条件がある場合も、
    /// 「画像の送信先」はカードから落ちない（以前は先頭 4 行で切り、送信先が必ず落ちていた）。
    func testComputerRunCardAlwaysNamesWhereTheImageGoes() throws {
        let rows: [(String, String)] = [
            ("目的", "カレンダーに会議を入れる"),
            ("完了の条件", "予定が保存されている"),
            ("範囲", "対象の窓1つだけ（開始時に選ぶ。20分以内の続きの依頼では前に選んだ窓のまま）。ほかの窓へ移りません"),
            ("確認", "この承認のあとは、1操作ごとには確認しません（最大12操作・5分）"),
            ("影響", "クリックや入力で、送信・保存などアプリの外に届く結果が起き、取り消せないことがあります"),
            ("画像の送信先", "この端末で設定したモデル。外部のモデルなら、対象の窓の画像がその提供元へ送られます"),
        ]
        for withCriteria in [true, false] {
            let details = rows.filter { withCriteria || $0.0 != "完了の条件" }.map { BackendApproval.Detail(label: $0.0, value: $0.1) }
            let card = ActionConfirmation(backendApproval: BackendApproval(
                id: "ap", summary: "対象の窓1つを、1操作ごとの確認なしで最大12操作・5分まで操作します", risk: "EXTERNAL_COMMIT",
                details: details,
                impact: .init(primaryActionLabel: "画面の操作を始める", affectedCount: nil, external: true, reversible: false, recoveryNote: nil)))
            XCTAssertTrue(card.details.contains { $0.hasPrefix("画像の送信先: この端末で設定したモデル。外部のモデルなら") }, "\(withCriteria) \(card.details)")
            XCTAssertTrue(card.details.contains { $0.hasPrefix("目的: ") } && card.details.contains { $0.hasPrefix("範囲: ") })
            XCTAssertEqual(card.details.count, 5, "4 行 + 取り消せないこと（面の高さは変えない）")
            XCTAssertEqual(card.details.last, "実行後は取り消せません。")
            // 描いて測る（面の高さは上限 360 で切られるので、切られる前の実寸を見る）。
            let height = try XCTUnwrap(DockContentMeasure.height(of: .confirmation(card), width: Metrics.dockConfirmWidth))
            XCTAssertLessThanOrEqual(height, 360, "backend の承認カードが確認の面の上限を超える（ボタンが切れる）\(withCriteria)")
        }
    }

    // MARK: - 確認カードは 1 枚ずつ、描いたカードに答える

    /// 新しいカードが、表示中のカードを上書きしない。答えは id が合うカードにだけ付く。
    func testCardsAreShownOneAtATimeAndAnswersNeedTheShownCardsID() {
        let store = GenieStateStore.shared
        let a = card("A を送ります"), b = card("B を送ります")
        var resolved: [(UUID, Bool)] = []
        let token = GenieEventBus.shared.subscribe { e in
            if case .confirmationResolved(let id, let approved) = e { resolved.append((id, approved)) }
        }
        defer { GenieEventBus.shared.unsubscribe(token) }
        store.requireConfirmation(a)
        store.requireConfirmation(b)
        XCTAssertEqual(store.state.confirmation?.id, a.id, "表示中のカードを差し替えた")
        XCTAssertEqual(store.dock, .confirmation(a))
        store.resolveConfirmation(id: UUID(), approved: true)
        XCTAssertTrue(resolved.isEmpty, "描いていないカードの id で答えが付いた")
        store.resolveConfirmation(id: a.id, approved: false)
        XCTAssertEqual(resolved.map(\.0), [a.id])
        XCTAssertEqual(store.state.confirmation?.id, b.id, "次のカードが出ない")
        store.resolveConfirmation(id: a.id, approved: true)
        XCTAssertEqual(resolved.count, 1, "答え済みのカードにもう一度答えが付いた")
        store.withdrawConfirmation(b.id)
        XCTAssertEqual(resolved.count, 1, "引っ込めたのを「やめた」として流した")
        XCTAssertNil(store.state.confirmation)
    }

    /// カードが出ている間、ほかの表示（Listening・回答など）でカードを隠さない。答えたら戻す。
    func testOtherDockStatesDoNotHideAPendingCard() {
        let store = GenieStateStore.shared
        let voice = VoiceHUDState.shared
        let previous = store.dock
        let c = card("外へ送ります")
        store.requireConfirmation(c)
        var started = 0
        let token = GenieEventBus.shared.subscribe { e in if case .voiceStarted = e { started += 1 } }
        defer { GenieEventBus.shared.unsubscribe(token) }
        voice.beginListening()
        XCTAssertEqual(store.dock, .confirmation(c), "声を始めただけでカードが隠れた")
        XCTAssertEqual(started, 0, "カードの間に聞き始めた")
        voice.mode = .answer("別の依頼の答え")
        XCTAssertEqual(store.dock, .confirmation(c), "回答がカードを隠した")
        store.resolveConfirmation(id: c.id, approved: false)
        XCTAssertEqual(store.dock, .answer("別の依頼の答え"), "カードの間に頼まれた表示へ戻らない")
        voice.mode = previous
    }

    // MARK: - 待ち方（terminal / 承認待ち / まだ動いている）

    func testWaitStateClassification() {
        for s in ["COMPLETED", "FAILED", "CANCELLED"] { XCTAssertEqual(TaskWaitState(status: s), .terminal, s) }
        XCTAssertEqual(TaskWaitState(status: "WAITING_APPROVAL"), .approvalPending)
        for s in ["PENDING", "RUNNING", "PAUSED_HOST_OFFLINE", "CANCELLING", "WAITING_USER", ""] {
            XCTAssertEqual(TaskWaitState(status: s), .running, s)
        }
        let pending = VoiceHUDState.taskReply(status: "WAITING_APPROVAL", artifactID: "") { XCTFail("読まない"); return "" }
        XCTAssertEqual(pending.phase, .waiting)
        XCTAssertFalse(pending.settled)
        XCTAssertTrue(pending.text.contains("まだ実行していません"))
    }

    /// 以前は `min(waitMs, 2000)` で、12 秒待つはずが 2 秒で諦めていた。
    func testWaitKeepsWaitingUntilTheFullDeadlineInShortSlices() {
        let clock = Clock()
        var slices: [UInt64] = []
        let status = VoiceHUDState.waitForTask(waitMs: 12_000, now: { clock.now }) { ms in
            slices.append(ms); clock.advance(ms)
            return TaskStatus(id: "t", status: "RUNNING", resultArtifactId: "")
        }
        XCTAssertEqual(status.status, "RUNNING")
        XCTAssertTrue(slices.allSatisfy { $0 <= 2_000 }, "\(slices)")
        XCTAssertEqual(slices.reduce(0, +), 12_000, "待つ時間の合計を縮めない")
    }

    func testWaitStopsEarlyOnApprovalPendingOrTerminal() {
        for (sequence, expected, calls) in [(["RUNNING", "WAITING_APPROVAL", "RUNNING"], "WAITING_APPROVAL", 2),
                                            (["COMPLETED"], "COMPLETED", 1),
                                            (["RUNNING", "RUNNING", "FAILED"], "FAILED", 3)] {
            let clock = Clock()
            var n = 0
            let status = VoiceHUDState.waitForTask(waitMs: 120_000, now: { clock.now }) { ms in
                defer { n += 1 }
                clock.advance(ms)
                return TaskStatus(id: "t", status: sequence[n], resultArtifactId: "")
            }
            XCTAssertEqual(status.status, expected)
            XCTAssertEqual(n, calls)
        }
    }

    /// `follow` そのものが期限まで待つ（以前は `min(waitMs, 2000)` で 2 秒で諦め、検査は waitForTask しか見ていなかった）。
    func testFollowWaitsTheWholeDeadlineThroughTheReader() throws {
        let clock = Clock()
        var slices: [UInt64] = []
        let reader = TaskReader(
            wait: { ms in slices.append(ms); clock.advance(ms); return TaskStatus(id: "t", status: "RUNNING", resultArtifactId: "") },
            content: { _ in XCTFail("終わっていないのに読んだ"); return "" },
            approvals: { XCTFail("承認待ちでないのに読んだ"); return [] },
            now: { clock.now }, pause: { clock.advance($0) })
        let outcome = TurnOutcome(needsClarification: false, answer: "", taskId: "t", notice: "", replyJson: "")
        let result = try VoiceHUDState.follow(outcome, waitMs: 12_000, reader: reader)
        XCTAssertEqual(result.reply.phase, .working)
        XCTAssertEqual(slices.reduce(0, +), 12_000, "follow が待つ時間の合計を縮めた \(slices)")
        XCTAssertTrue(slices.allSatisfy { $0 <= 2_000 })
    }

    /// 承認を届けた直後は、backend の行はもう APPROVED（PENDING の承認は空）なのに、状態はまだ
    /// WAITING_APPROVAL のことがある（状態を RUNNING に戻すのは後で動く activity）。以前はここで
    /// 「まだ実行していません」と返して追うのをやめ、動いている computer.run の結果が届かなかった。
    func testFollowKeepsWaitingWhenApprovalWasDeliveredButTheTaskHasNotResumed() throws {
        let clock = Clock()
        var n = 0, approvalReads = 0
        let sequence = ["WAITING_APPROVAL", "WAITING_APPROVAL", "RUNNING", "COMPLETED"]
        let reader = TaskReader(
            wait: { ms in defer { n += 1 }; clock.advance(ms); return TaskStatus(id: "t", status: sequence[min(n, sequence.count - 1)], resultArtifactId: n >= 3 ? "art" : "") },
            content: { _ in "整理しました" },
            approvals: { approvalReads += 1; return [] },
            now: { clock.now }, pause: { clock.advance($0) })
        let outcome = TurnOutcome(needsClarification: false, answer: "", taskId: "t", notice: "", replyJson: "")
        let result = try VoiceHUDState.follow(outcome, waitMs: 12_000, reader: reader)
        XCTAssertEqual(result.reply.phase, .complete, "承認を届けた直後の WAITING_APPROVAL で追うのをやめた")
        XCTAssertEqual(result.reply.text, "整理しました")
        XCTAssertEqual(approvalReads, 2)
        XCTAssertTrue(result.pendingApprovals.isEmpty)

        // 期限まで戻らなくても、「まだ実行していません」とは言わない（答えは届いている）。待つ時間も縮めない。
        let stuck = Clock()
        let still = TaskReader(
            wait: { ms in stuck.advance(ms); return TaskStatus(id: "t", status: "WAITING_APPROVAL", resultArtifactId: "") },
            content: { _ in XCTFail("終わっていないのに読んだ"); return "" },
            approvals: { [] },
            now: { stuck.now }, pause: { stuck.advance($0) })
        let late = try VoiceHUDState.follow(outcome, waitMs: 12_000, reader: still)
        XCTAssertEqual(late.reply.phase, .waiting)
        XCTAssertFalse(late.reply.settled, "裏で待ち続けられる")
        XCTAssertFalse(late.reply.text.contains("まだ実行していません"), late.reply.text)
        XCTAssertTrue(late.pendingApprovals.isEmpty)
        XCTAssertGreaterThanOrEqual(stuck.now.timeIntervalSince1970, 12, "期限の前に諦めた")
        XCTAssertLessThan(stuck.now.timeIntervalSince1970, 14)

        // 答えていない承認が残っているときは、これまでどおりすぐ返してカードに出す。
        let fresh = Clock()
        let pendingReader = TaskReader(
            wait: { ms in fresh.advance(ms); return TaskStatus(id: "t", status: "WAITING_APPROVAL", resultArtifactId: "") },
            content: { _ in XCTFail("読まない"); return "" },
            approvals: { [self.approval("ap-2")] },
            now: { fresh.now }, pause: { fresh.advance($0) })
        let asked = try VoiceHUDState.follow(outcome, waitMs: 12_000, reader: pendingReader)
        XCTAssertEqual(asked.pendingApprovals.map(\.id), ["ap-2"])
        XCTAssertTrue(asked.reply.text.contains("まだ実行していません"))
        XCTAssertLessThanOrEqual(fresh.now.timeIntervalSince1970, 2)
    }

    /// 区切りの終わりの一時的な失敗（通信・502/503/504）で諦めない。続けて 3 回、または認証などは諦める。
    func testWaitSurvivesTransientErrorsButNotRepeatedOrPermanentOnes() throws {
        func run(_ script: [Result<String, ApiError>]) -> (Result<String, Error>, Int) {
            let clock = Clock()
            var n = 0
            let r = Result<String, Error> {
                try VoiceHUDState.waitForTask(waitMs: 120_000, now: { clock.now }, pause: { clock.advance($0) }) { ms in
                    defer { n += 1 }
                    clock.advance(ms)
                    return TaskStatus(id: "t", status: try script[min(n, script.count - 1)].get(), resultArtifactId: "")
                }.status
            }
            return (r, n)
        }
        let net = ApiError.Network(message: "reset"), bad = ApiError.Server(status: 502, message: "")
        let (ok, calls) = run([.failure(net), .success("RUNNING"), .failure(bad), .failure(net), .success("COMPLETED")])
        XCTAssertEqual(try ok.get(), "COMPLETED", "一時的な失敗 1〜2 回で諦めた")
        XCTAssertEqual(calls, 5)
        let (three, _) = run([.failure(net), .failure(bad), .failure(net), .success("COMPLETED")])
        XCTAssertThrowsError(try three.get(), "続けて 3 回失敗しても読み続けた")
        let (auth, authCalls) = run([.failure(.Server(status: 401, message: "")), .success("COMPLETED")])
        XCTAssertThrowsError(try auth.get())
        XCTAssertEqual(authCalls, 1, "認証の失敗を読み直した")
        let (limited, limitedCalls) = run([.failure(.Server(status: 429, message: "")), .success("COMPLETED")])
        XCTAssertThrowsError(try limited.get())
        XCTAssertEqual(limitedCalls, 1, "429 を読み直した（core と同じ線引き）")
    }

    // MARK: - 承認待ちを、カードを通さずに進めない

    func testDeclinedCardRejectsExactlyThatApprovalAndNeverApproves() async throws {
        let log = Log()
        let first = TaskFollowUp(reply: TaskReply(text: "", phase: .waiting),
                                 pendingApprovals: [approval("ap-1"), approval("ap-2", risk: "DESTRUCTIVE")])
        let result = try await VoiceHUDState.settleApprovals(first, waitMs: 12_000,
            ask: { log.shown.append($0); return .declined },
            approve: { id, _ in log.approved.append(id) },
            reject: { log.rejected.append($0) },
            follow: { _ in log.followed += 1; return first })
        XCTAssertEqual(log.shown.count, 1, "1 件ずつ聞く")
        XCTAssertEqual(log.shown.first?.title, "開始時に対象と送信先を確認します")
        XCTAssertEqual(log.rejected, ["ap-1"], "見せた承認だけに答える")
        XCTAssertTrue(log.approved.isEmpty)
        XCTAssertEqual(log.followed, 0, "やめたのに待ち続けない")
        XCTAssertEqual(result.reply.phase, .cancelled)
        XCTAssertTrue(result.reply.text.contains("実行していません"))
    }

    func testRejectThatCannotBeDeliveredStaysHonestAndRefreshable() async throws {
        let log = Log()
        struct Offline: Error {}
        let result = try await VoiceHUDState.settleApprovals(
            TaskFollowUp(reply: TaskReply(text: "", phase: .waiting), pendingApprovals: [approval("ap-1")]), waitMs: 1,
            ask: { log.shown.append($0); return .declined },
            approve: { id, _ in log.approved.append(id) },
            reject: { _ in throw Offline() },
            follow: { _ in XCTFail("待たない"); return TaskFollowUp(reply: TaskReply(text: "", phase: .working)) })
        XCTAssertTrue(log.approved.isEmpty)
        XCTAssertEqual(result.reply.phase, .unknown)
        XCTAssertTrue(result.reply.settled, "同じカードを自動で出し直さない")
        XCTAssertTrue(result.reply.text.contains("実行していません"))
        var record = TaskRequestRecord(request: "依頼", base: "test")
        record.backendTaskID = "job"; record.phase = result.reply.phase
        XCTAssertTrue(record.canRefresh, "「状況を確認」で確かめ直せる")
    }

    func testNothingPendingShowsNoCardAndAnswersNothing() async throws {
        let log = Log()
        let first = TaskFollowUp(reply: TaskReply(text: "作成を続けています。", phase: .working))
        let result = try await VoiceHUDState.settleApprovals(first, waitMs: 1,
            ask: { log.shown.append($0); return .unanswered },
            approve: { id, _ in log.approved.append(id) },
            reject: { log.rejected.append($0) },
            follow: { _ in log.followed += 1; return first })
        XCTAssertTrue(log.shown.isEmpty && log.approved.isEmpty && log.rejected.isEmpty)
        XCTAssertEqual(log.followed, 0)
        XCTAssertEqual(result.reply.phase, .working)
    }

    /// 答えが無い（時間切れ・カードが隠れた・headless）のは「やめた」ではない。REJECTED を送らない
    /// （送ると backend が仕事を CANCELLED にする）。承認は PENDING のまま、「状況を確認」で出し直せる。
    func testUnansweredCardSendsNothingAndLeavesTheApprovalPending() async throws {
        let log = Log()
        let first = TaskFollowUp(reply: TaskReply(text: "", phase: .waiting), pendingApprovals: [approval("ap-1")])
        let result = try await VoiceHUDState.settleApprovals(first, waitMs: 12_000,
            ask: { log.shown.append($0); return .unanswered },
            approve: { id, _ in log.approved.append(id) },
            reject: { log.rejected.append($0) },
            follow: { _ in log.followed += 1; return first })
        XCTAssertEqual(log.shown.count, 1)
        XCTAssertTrue(log.rejected.isEmpty, "答えが無いだけで REJECTED を送った（仕事が取り消される）")
        XCTAssertTrue(log.approved.isEmpty)
        XCTAssertEqual(log.followed, 0)
        XCTAssertTrue(result.leftPending, "裏で待ち続けて同じカードを出し直す")
        XCTAssertEqual(result.reply.phase, .waiting)
        XCTAssertFalse(result.reply.settled)
        XCTAssertTrue(result.reply.text.contains("まだ実行していません") && result.reply.text.contains("状況を確認"))
        var record = TaskRequestRecord(request: "依頼", base: "test")
        record.backendTaskID = "job"; record.phase = result.reply.phase
        XCTAssertTrue(record.canRefresh, "「状況を確認」で確認カードを出し直せる")
    }

    // MARK: - 返信: 見せた下書きの承認だけに答える

    func testReplyApprovalMustMatchTheShownDraft() throws {
        let meta = #"{"target":{"subject":"見積","external_id":"m1","source":"gmail","to":{"name":"佐藤","email":"sato@example.com"}}}"#
        let draft = try XCTUnwrap(ReplyFlow.draft(replyJson: meta, body: "ご連絡ありがとうございます。"))
        // 組んだだけの下書きは承認を持たない —— 送る経路（sender / sendThroughCloud）は証拠を
        // 別の引数で要求するので、証拠の無い下書きは型の上で送れない（検査からも呼べない）。
        func a(_ details: [(String, String)], tool: String? = nil) -> BackendApproval {
            BackendApproval(id: "x", summary: "sato@example.com に返信を送ります", risk: "EXTERNAL_COMMIT",
                            details: details.map { .init(label: $0.0, value: $0.1) }, toolID: tool)
        }
        XCTAssertTrue(ReplyFlow.approvalMatches(a([("subject", draft.subject), ("body", draft.body), ("count", "1")]), draft: draft))
        XCTAssertTrue(ReplyFlow.approvalMatches(a([("subject", draft.subject), ("comment", draft.body)], tool: "outlook.mail.reply"), draft: draft))
        XCTAssertFalse(ReplyFlow.approvalMatches(a([("subject", draft.subject), ("body", "別の本文")]), draft: draft))
        XCTAssertFalse(ReplyFlow.approvalMatches(a([("subject", "別の件名"), ("body", draft.body)]), draft: draft))
        XCTAssertFalse(ReplyFlow.approvalMatches(a([("subject", draft.subject)], tool: "computer.run"), draft: draft))
    }
}

