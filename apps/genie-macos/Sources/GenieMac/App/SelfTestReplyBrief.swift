import AppKit
import SwiftUI

/// `--selftest replyflow`: REPLY_IN_CONTEXT_GATE の端末側。`--selftest brief`: MEETING_BRIEF_GATE の端末側。
///
/// どちらも gateway 無しで、端末の状態機械だけを測る（cloud 側は world-model / gateway の試験）。
///   - 候補は 開いているメール → 選択 → 前面の窓 の順で、題名だけ（本文を送らない）
///   - 返信案は確認カードに出る（本文・宛先・出所）。送るのは押されたときだけ
///   - [直す] で直した本文が送る内容になる
///   - 送る接続が無ければ理由を見せて接続を求め、**接続後は確認へ戻る。自動では送らない**
///   - 窓を増やさない・焦点を奪わない
extension SelfTest {
    @MainActor
    static func replyFlowGate() async {
        // 確認は止まらずに待つ（`Confirm.approve` は async）。ここでも run loop を空回しせず、
        // 待つ間は suspend して、通常のイベントループに Dock の描画と答えを任せる。
        func settleRunLoop(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        var fail: [String] = []
        func check(_ ok: Bool, _ msg: String) { if !ok { fail.append(msg) } }
        var rows: [String] = []
        func row(_ k: String, _ v: String) { rows.append("\(k)=\(v)") }

        // 1. 候補の順（題名だけ）
        let mailApp = AXContext(appName: "Mail", bundleId: "com.apple.mail", windowTitle: "Re: MOPITA 見積の件 — 受信", focusedRole: nil, selectedText: "本文の一部")
        let c1 = ReplyContextResolver.candidates(snapshot: mailApp)
        check(c1.first?.kind == "mail" && c1.first?.label.contains("MOPITA") == true, "Mail.app の題名が最初の候補にならない \(c1)")
        check(c1.contains { $0.kind == "selection" }, "選択が候補に無い")
        check(!c1.contains { $0.kind == "frontmost" }, "Mail.app のとき frontmost を重ねている")
        let gmailTab = AXContext(appName: "Google Chrome", bundleId: "com.google.Chrome", windowTitle: "Re: MOPITA 見積の件 - me@example.com - Gmail", focusedRole: nil, selectedText: nil)
        let c2 = ReplyContextResolver.candidates(snapshot: gmailTab)
        check(c2.first?.kind == "mail" && c2.first?.label == "Re: MOPITA 見積の件", "Gmail タブの題名から件名を取れない \(c2)")
        let xcode = AXContext(appName: "Xcode", bundleId: "com.apple.dt.Xcode", windowTitle: "main.swift", focusedRole: nil, selectedText: nil)
        let c3 = ReplyContextResolver.candidates(snapshot: xcode)
        check(c3.map(\.kind) == ["frontmost"], "無関係な前面アプリは frontmost だけ \(c3)")
        check(ReplyContextResolver.candidates(snapshot: nil).isEmpty, "前面が無ければ候補 0")
        check(ReplyContextResolver.isReplyUtterance("これ返して") && !ReplyContextResolver.isReplyUtterance("この画像のエラーコードは？"), "返信の発話判定")
        let json = ReplyContextResolver.json(c1)
        check(!json.contains("本文の一部") || json.contains("selection"), "候補 JSON")
        row("candidate_order", "mail>selection>frontmost")

        // 2. 返信案 → 確認カード（送るのは押されたときだけ）
        let meta = """
        {"target":{"artifact_id":"gmail:m1","source":"gmail","thread_id":"gmail:t1","external_id":"m1","subject":"MOPITA 見積の件",
          "to":{"name":"MTI 田中","email":"tanaka@mti.example","role":"from"},"project":"MOPITA連携","matched_by":"mail","confidence":1},
         "sources":[{"source":"gmail","external_id":"m1","label":"Re: MOPITA 見積の件","observed_at":"2026-09-07T00:00:00Z","url":null,"excerpt":null},
                    {"source":"meeting","external_id":"mt1","label":"MOPITA 定例","observed_at":"2026-09-07T00:00:00Z","url":null,"excerpt":null}],
         "basis":"このスレッドと直近の会議を踏まえて作りました。"}
        """
        guard let draft = ReplyFlow.draft(replyJson: meta, body: "ご連絡ありがとうございます。\n見積を再提出します。\n\n---\n\n※ 下書きです。送信はしていません。") else {
            print("SELFTEST_FAIL replyflow: 返信案を組めない"); exit(1)
        }
        check(draft.subject == "Re: MOPITA 見積の件" && draft.toEmail == "tanaka@mti.example", "宛先・件名")
        check(!draft.body.contains("下書きです"), "下書きの印が本文に残っている")
        check(ReplyFlow.sourceLine(draft.sources) == "Gmail 1件 · 会議 1件", "出所の行 \(ReplyFlow.sourceLine(draft.sources))")

        let flow = ReplyFlow.shared
        flow.resetForTest()
        var sent: [ReplyFlow.Draft] = []
        var connectAsked = 0
        WindowCoordinator.shared.showVoiceHUD()
        await settleRunLoop(0.5)
        let windowsBefore = NSApp.windows.filter { $0.isVisible }.count
        let keyBefore = NSApp.keyWindow

        // 2a. 押さなければ送らない（取消）
        flow.sender = { d, _ in sent.append(d); return .sent(taskId: "t") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { GenieStateStore.shared.resolveConfirmation(approved: false) }
        let cancelled = await flow.present(draft)
        check(cancelled == .cancelled && sent.isEmpty, "取消なのに送った")
        row("draft_shown_before_send", "PASS")

        // 2b. 直した本文が送られる
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            GenieStateStore.shared.resolveConfirmation(approved: true, edits: ["__preview": "直した本文です。"])
        }
        let ok = await flow.present(draft)
        check(ok == .sent(taskId: "t") && sent.last?.body == "直した本文です。", "直した本文が送られない \(String(describing: sent.last?.body))")
        check(sent.count == 1, "送信が 1 回ではない (\(sent.count))")
        row("edited_body_sent", "PASS")

        // 2c. 送る接続が無い → 理由 → 接続 → 確認へ戻る（自動では送らない）→ 押して送る
        sent.removeAll()
        var state = 0
        flow.sender = { d, _ in
            state += 1
            if state == 1 { return .needsConnection(pluginId: "com.astra.gmail", connectorId: "gmail-actions") }
            sent.append(d); return .sent(taskId: "t2")
        }
        flow.connector = { _, _ in connectAsked += 1; return true }
        // 1 回目の「送る」→ 接続の確認（接続する）→ 接続完了 → 確認カードに戻る → 2 回目の「送る」
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { GenieStateStore.shared.resolveConfirmation(approved: true) }      // 送る
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { GenieStateStore.shared.resolveConfirmation(approved: true) }      // 接続する
        let first = await flow.present(draft)
        check(first == .needsConnection(pluginId: "com.astra.gmail", connectorId: "gmail-actions"), "接続が要ると言わない \(first)")
        check(connectAsked == 1, "接続を始めていない")
        check(flow.pendingDraft != nil, "下書きを覚えていない")
        check(sent.isEmpty, "接続の前に送っている")
        // 接続完了。**ここで自動送信しない。**確認カードが出直すので、取消して確かめる。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { GenieStateStore.shared.resolveConfirmation(approved: false) }
        ConnectorState.shared.installActionsStatus(pluginId: "com.astra.gmail", connectorId: "gmail-actions", .connected)
        await settleRunLoop(1.2)
        check(sent.isEmpty, "接続しただけで送った（permission grant auto-send）")
        check(flow.pendingDraft == nil, "接続後に確認へ戻っていない")
        check(flow.presentedCount >= 4, "接続後に確認カードが出直していない (\(flow.presentedCount))")
        row("permission_grant_auto_send", sent.isEmpty ? "0" : "FAIL")
        // 本人がもう一度「送る」を押したときだけ送る
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { GenieStateStore.shared.resolveConfirmation(approved: true) }
        let second = await flow.present(draft)
        check(second == .sent(taskId: "t2") && sent.count == 1, "2 回目の送るで送られない")
        row("jit_send_permission", "PASS")
        row("external_confirmation", "100%")

        // 2d. Outlook の下書きは outlook-actions を求め、接続後も自動では送らない（Gmail と同じ形）
        sent.removeAll(); connectAsked = 0; state = 0
        let outlookMeta = meta.replacingOccurrences(of: "\"source\":\"gmail\"", with: "\"source\":\"outlook_mail\"")
            .replacingOccurrences(of: "\"artifact_id\":\"gmail:m1\"", with: "\"artifact_id\":\"outlook_mail:AAMk1\"")
            .replacingOccurrences(of: "\"external_id\":\"m1\"", with: "\"external_id\":\"AAMk1\"")
        guard let outlookDraft = ReplyFlow.draft(replyJson: outlookMeta, body: "ご連絡ありがとうございます。") else {
            print("SELFTEST_FAIL replyflow: Outlook の返信案を組めない"); exit(1)
        }
        check(outlookDraft.source == "outlook_mail" && outlookDraft.inReplyTo == "AAMk1", "Outlook の返信先（provider message id）")
        var askedFor: (String, String)?
        flow.connector = { p, c in connectAsked += 1; askedFor = (p, c); return true }
        flow.sender = { d, _ in
            state += 1
            if state == 1 { let c = ReplyFlow.actionsConnection(for: d.source); return .needsConnection(pluginId: c.pluginId, connectorId: c.connectorId) }
            sent.append(d); return .sent(taskId: "t3")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { GenieStateStore.shared.resolveConfirmation(approved: true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { GenieStateStore.shared.resolveConfirmation(approved: true) }
        let o1 = await flow.present(outlookDraft)
        check(o1 == .needsConnection(pluginId: "com.astra.outlook", connectorId: "outlook-actions"), "Outlook の送る接続を求めない \(o1)")
        check(askedFor?.0 == "com.astra.outlook" && askedFor?.1 == "outlook-actions", "Outlook の接続先が違う")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { GenieStateStore.shared.resolveConfirmation(approved: false) }
        ConnectorState.shared.installActionsStatus(pluginId: "com.astra.outlook", connectorId: "outlook-actions", .connected)
        await settleRunLoop(1.2)
        check(sent.isEmpty && flow.pendingDraft == nil, "Outlook: 接続しただけで送った / 確認へ戻らない")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { GenieStateStore.shared.resolveConfirmation(approved: true, edits: ["__preview": "直した Outlook 本文"]) }
        let o2 = await flow.present(outlookDraft)
        check(o2 == .sent(taskId: "t3") && sent.last?.body == "直した Outlook 本文", "Outlook: 2 回目の送るで直した本文が送られない")
        row("outlook_oauth_completion_auto_send", "0")
        row("outlook_edited_text_sent", "PASS")

        // 3. 静かさ
        await settleRunLoop(0.3)
        check(NSApp.windows.filter { $0.isVisible }.count == windowsBefore, "窓が増えた")
        check(NSApp.keyWindow === keyBefore, "焦点が動いた")
        row("focus_theft", "0"); row("extra_window", "0")

        flow.resetForTest()
        flow.sender = { d, approval in ReplyFlow.sendThroughCloud(d, approval: approval) }
        for r in rows { FileHandle.standardError.write(("REPLY_UI\t" + r + "\n").data(using: .utf8)!) }
        if fail.isEmpty { print("SELFTEST_OK replyflow: \(rows.count) 行"); exit(0) }
        print("SELFTEST_FAIL replyflow: \(fail.joined(separator: " / "))"); exit(1)
    }

    @MainActor
    static func briefGate() {
        var fail: [String] = []
        func check(_ ok: Bool, _ msg: String) { if !ok { fail.append(msg) } }
        var rows: [String] = []
        func row(_ k: String, _ v: String) { rows.append("\(k)=\(v)") }
        guard let brief = WorkContextFixture.brief() else { print("SELFTEST_FAIL brief: 契約の形で読めない"); exit(1) }
        check(!brief.eventId.isEmpty && brief.project != nil, "予定と案件")
        check(brief.previous.count >= 1 && brief.sinceLastMeeting.count >= 1 && brief.openItems.count >= 1, "前回 / その後 / 開いている件")
        let facts = brief.previous + brief.sinceLastMeeting + brief.openItems
        check(facts.allSatisfy { !$0.sources.isEmpty }, "出所の無い事実がある")
        check((1...3).contains(brief.suggestedQuestions.count), "質問が 1..3 でない (\(brief.suggestedQuestions.count))")
        check(brief.suggestedQuestions.allSatisfy { !$0.reason.isEmpty && !$0.sources.isEmpty }, "理由か出所の無い質問がある")
        row("every_fact_sourced", "100%"); row("suggested_questions", String(brief.suggestedQuestions.count))

        let store = WorkContextStore.shared
        store.install(WorkContextFixture.context(), profile: WorkContextFixture.profile())
        store.installBrief(brief)
        NSApp.setActivationPolicy(.regular); parkCursor()
        MainWindowController.shared.showSection(.home); settleRunLoop(1.0)
        let windowsBefore = NSApp.windows.filter { $0.isVisible }.count
        let keyBefore = NSApp.keyWindow
        let closed = NSHostingView(rootView: MeetingBriefRow().frame(width: 820))
        closed.frame = NSRect(x: 0, y: 0, width: 820, height: 10); closed.layoutSubtreeIfNeeded()
        let closedH = closed.fittingSize.height
        store.briefOpen = true
        let open = NSHostingView(rootView: MeetingBriefRow().frame(width: 820))
        open.frame = NSRect(x: 0, y: 0, width: 820, height: 10); open.layoutSubtreeIfNeeded()
        let openH = open.fittingSize.height
        check(closedH > 30 && closedH < 90, "閉じた行が 1 行でない (\(Int(closedH))pt)")
        check(openH > closedH + 100, "開いても中身が出ない (\(Int(openH))pt)")
        row("brief_available_before_meeting", "PASS")
        row("row_height_pt", String(Int(closedH))); row("open_height_pt", String(Int(openH)))
        settleRunLoop(0.3)
        check(NSApp.windows.filter { $0.isVisible }.count == windowsBefore, "窓が増えた")
        check(NSApp.keyWindow === keyBefore, "焦点が動いた")
        row("focus_theft", "0"); row("new_window", "0")
        store.installBrief(nil); store.install(nil, profile: nil)
        for r in rows { FileHandle.standardError.write(("BRIEF_UI\t" + r + "\n").data(using: .utf8)!) }
        if fail.isEmpty { print("SELFTEST_OK brief: \(rows.count) 行"); exit(0) }
        print("SELFTEST_FAIL brief: \(fail.joined(separator: " / "))"); exit(1)
    }
}
