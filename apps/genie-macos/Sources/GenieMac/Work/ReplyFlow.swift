import AppKit
import Combine
import Foundation
import GenieApproval

/// 「これ返して」の端末側。REPLY_IN_CONTEXT_GATE。
///
///   返信案（cloud の成果物）→ 既存の確認カード（Dock）に 宛先・件名・本文・出所 → [直す] [送る]
///   → 送る = 別の task（承認つき）→ 送る接続が無ければ理由を見せて接続を求め、**接続後は確認へ戻る（自動では送らない）**
///
/// 「Work Graph を使いました」とは言わない。何を踏まえたか（basis）と出所だけを見せる。
@MainActor
final class ReplyFlow: ObservableObject {
    static let shared = ReplyFlow()

    struct Draft: Equatable {
        let toName: String
        let toEmail: String?
        let subject: String
        var body: String
        let basis: String
        let sources: [(source: String, label: String)]
        let inReplyTo: String
        let threadId: String?
        let source: String

        static func == (a: Draft, b: Draft) -> Bool {
            a.subject == b.subject && a.body == b.body && a.inReplyTo == b.inReplyTo
        }
    }

    enum Outcome: Equatable {
        case cancelled
        case sent(taskId: String)
        case needsConnection(pluginId: String, connectorId: String)
        case failed(String)
    }

    /// 送る経路。検査では差し替える（本物は cloud の task + 承認）。
    /// **本人がこの下書きのカードで「送る」を押した証拠**（`UserApproval`）と一緒でないと呼べない。
    /// 証拠はコピーできないので、1 回の「送る」で送れるのは 1 回だけ。
    var sender: (Draft, consuming UserApproval) -> Outcome = { draft, approval in
        ReplyFlow.sendThroughCloud(draft, approval: approval)
    }
    /// 接続を始める経路。検査では差し替える。
    var connector: (String, String) -> Bool = { pluginId, connectorId in
        ConnectorState.shared.connectActions(pluginId: pluginId, connectorId: connectorId)
    }

    /// 送る接続を待っている下書き。接続できたら**確認へ戻す**（送らない）。
    @Published private(set) var pendingDraft: Draft?
    /// 検査で数える。
    private(set) var sendCalls = 0
    private(set) var presentedCount = 0
    private var cancellables: Set<AnyCancellable> = []
    private var base: String?
    private var token: String?

    init() {
        // 送る接続ができた瞬間に、待っていた下書きを確認カードへ戻す。自動では送らない。
        ConnectorState.shared.$status
            .receive(on: RunLoop.main)
            .sink { [weak self] status in
                guard let self, let draft = self.pendingDraft else { return }
                let (pluginId, connectorId) = Self.actionsConnection(for: draft.source)
                if status["\(pluginId)#\(connectorId)"] == .connected {
                    self.pendingDraft = nil
                    Task { @MainActor in await self.present(draft) }
                }
            }
            .store(in: &cancellables)
    }

    func configureBackend(base: String, token: String) { self.base = base; self.token = token }

    /// 送り元ごとの「送る接続」。Gmail は gmail-actions、Outlook は outlook-actions（Mail.Send だけ）。
    static func actionsConnection(for source: String) -> (pluginId: String, connectorId: String) {
        source == "outlook_mail" ? ("com.astra.outlook", "outlook-actions") : ("com.astra.gmail", "gmail-actions")
    }

    static func providerLabel(for source: String) -> String { source == "outlook_mail" ? "Outlook" : "Gmail" }

    /// cloud の返事（ReplyDraftMeta の JSON）と成果物の本文から下書きを組む。
    static func draft(replyJson: String, body: String) -> Draft? {
        guard let data = replyJson.data(using: .utf8),
              let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let target = meta["target"] as? [String: Any],
              let subject = target["subject"] as? String,
              let externalId = target["external_id"] as? String else { return nil }
        let to = target["to"] as? [String: Any]
        let sources = ((meta["sources"] as? [[String: Any]]) ?? []).compactMap { s -> (String, String)? in
            guard let src = s["source"] as? String, let label = s["label"] as? String else { return nil }
            return (src, label)
        }
        let cleaned = body.replacingOccurrences(of: "\n\n---\n\n※ 下書きです。送信はしていません。", with: "")
        return Draft(
            toName: (to?["name"] as? String) ?? "相手",
            toEmail: to?["email"] as? String,
            subject: subject.hasPrefix("Re:") ? subject : "Re: \(subject)",
            body: cleaned.trimmingCharacters(in: .whitespacesAndNewlines),
            basis: (meta["basis"] as? String) ?? "このスレッドを踏まえて作りました。",
            sources: sources.map { (source: $0.0, label: $0.1) },
            inReplyTo: externalId,
            threadId: target["thread_id"] as? String,
            source: (target["source"] as? String) ?? "gmail"
        )
    }

    /// 出所の 1 行（「Gmail 2件 · 会議 1件」）。
    static func sourceLine(_ sources: [(source: String, label: String)]) -> String {
        var counts: [String: Int] = [:]
        for s in sources { counts[WorkFormat.sourceName(s.source), default: 0] += 1 }
        return counts.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)件" }.joined(separator: " · ")
    }

    /// 確認カードを出して答えを待つ（止まらずに待つ）。**送るのは押されたときだけ。**
    @discardableResult
    func present(_ draft: Draft) async -> Outcome {
        presentedCount += 1
        let confirmation = ActionConfirmation(
            app: Self.providerLabel(for: draft.source), appIcon: nil,
            title: "\(draft.toName)\(Facts.replyTitleSuffix)",
            params: [
                .init(label: "宛先", value: draft.toEmail ?? draft.toName, editable: false),
                .init(label: "件名", value: draft.subject, editable: false),
            ],
            preview: draft.body,
            source: draft.sources.first.map { ActionConfirmation.Source(title: $0.label, speaker: WorkFormat.sourceName($0.source), time: nil) },
            details: [draft.basis, "\(Facts.sourceLabel): \(Self.sourceLine(draft.sources))"],
            risk: .r2,
            confirmLabel: Facts.replySend)
        let answer = await Confirm.approve(confirmation)
        switch consume answer {
        case .approved(let approval):
            var final = draft
            let edits = GenieStateStore.shared.takeConfirmationEdits(confirmation.id)
            if let editedBody = edits["__preview"], !editedBody.trimmingCharacters(in: .whitespaces).isEmpty {
                final.body = editedBody
            }
            return await deliver(final, approval: approval)
        case .declined:
            return .cancelled
        case .unanswered:
            // 答えが無かっただけでも送らない（下書きは Work に残る）。
            return .cancelled
        }
    }

    /// 送る。送る接続が無ければ、理由を見せて接続を求め、**接続後は確認へ戻る。**
    private func deliver(_ draft: Draft, approval: consuming UserApproval) async -> Outcome {
        sendCalls += 1
        let outcome = sender(draft, approval)
        switch outcome {
        case .needsConnection(let pluginId, let connectorId):
            // 接続後は確認へ戻す。前の「送る」の証拠は sender が使い切っている（もう一度押されたときだけ送る）。
            pendingDraft = draft
            let source = ConnectorState.shared.actionsSource(pluginId: pluginId, connectorId: connectorId)
            let purpose = source?.purpose ?? "確認した返信を送信するため"
            let label = source.map { "\($0.name)（送る）" } ?? Self.providerLabel(for: draft.source)
            let ask = ActionConfirmation(
                app: Self.providerLabel(for: draft.source), appIcon: nil,
                title: "送るには「\(label)」の接続が要ります",
                params: [], preview: nil, source: nil,
                details: [purpose, "同意画面で許可すると、この確認に戻ります。自動では送りません。"],
                risk: .r2, confirmLabel: Facts.replyConnect)
            if await Confirm.ask(ask) {
                _ = connector(pluginId, connectorId)
            } else {
                pendingDraft = nil
            }
            return outcome
        case .failed(let why):
            GenieStateStore.shared.setDock(.result(AgentResult(title: "送れませんでした", actions: [.retry], detail: why, failed: true)))
            return outcome
        case .sent:
            GenieStateStore.shared.setDock(.result(AgentResult(title: "\(draft.toName) に送りました", actions: [.copy], sourceCount: draft.sources.count)))
            return outcome
        case .cancelled:
            return outcome
        }
    }

    /// 本物: cloud に task を起こし、承認に答え、端末の worker が送る。
    ///
    /// 承認に写すのは、本人がこの下書きのカードで押した 1 回（`approval`）だけ。
    /// 中継する承認は、この送信の中身（件名・本文）と一致するものに限る（items の先頭を黙って選ばない）。
    static func sendThroughCloud(_ draft: Draft, approval: consuming UserApproval) -> Outcome {
        guard let base = shared.base, let token = shared.token else { return .failed("サインインすると送れます。") }
        let body: [String: Any] = [
            "source": draft.source,
            "to": [draft.toEmail ?? ""].filter { !$0.isEmpty },
            "subject": draft.subject,
            "body": draft.body,
            "in_reply_to": draft.inReplyTo,
            "thread_id": draft.threadId ?? NSNull(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body), let json = String(data: data, encoding: .utf8) else {
            return .failed("送る内容を組めませんでした。")
        }
        do {
            let taskId = try GenieCoreBridge.workReplySend(base, accessToken: token, sendJson: json)
            // 承認: 本人がいま「送る」を押した。その 1 回だけを、この下書きの承認に写す。
            var matched: String?
            for _ in 0..<40 {
                let pending = try GenieCoreBridge.pendingApprovals(base, accessToken: token, taskId: taskId)
                if let match = pending.first(where: { approvalMatches($0, draft: draft) }) {
                    matched = match.id
                    break
                }
                if !pending.isEmpty {
                    // この送信のために起こした仕事なのに、見せた下書きと違う承認が来た。答えずに止める。
                    for other in pending { try? GenieCoreBridge.taskReject(base, accessToken: token, taskId: taskId, approvalId: other.id) }
                    return .failed("確認した内容と送る内容が一致しなかったため、送っていません。")
                }
                let st = try GenieCoreBridge.waitTask(base, accessToken: token, taskId: taskId, timeoutMs: 500)
                if st.status == "FAILED" || st.status == "COMPLETED" || st.status == "CANCELLED" { break }
            }
            // 証拠は 1 件の承認にだけ使える（コピーできない）。
            if let matched {
                try GenieCoreBridge.taskApprove(base, accessToken: token, taskId: taskId, approvalId: matched, approval: approval)
            }
            let approved = matched != nil
            let done = try GenieCoreBridge.waitTask(base, accessToken: token, taskId: taskId, timeoutMs: 60_000)
            switch done.status {
            case "COMPLETED": return .sent(taskId: taskId)
            case "FAILED":
                let task = try? GenieCoreBridge.taskGet(base, accessToken: token, taskId: taskId)
                if let task, task.contains("connector.not_connected") {
                    let c = Self.actionsConnection(for: draft.source)
                    return .needsConnection(pluginId: c.pluginId, connectorId: c.connectorId)
                }
                return .failed(approved ? "端末で送れませんでした。" : "承認を受け取れませんでした。")
            default: return .failed("送信の結果を確かめられませんでした。")
            }
        } catch {
            return .failed("送れませんでした: \(error)")
        }
    }

    /// backend の承認が、この下書きを送るためのものか。JSON にある項目は**すべて一致**を求める
    /// （tool が返れば送る tool であること、件名・本文が返ればカードで見せた値と同じこと）。
    nonisolated static func approvalMatches(_ a: BackendApproval, draft: Draft) -> Bool {
        if let tool = a.toolID, tool != "mail.send", tool != "outlook.mail.reply" { return false }
        if let subject = a.detail("subject"), subject != draft.subject { return false }
        if let body = a.detail("body") ?? a.detail("comment"), body != draft.body { return false }
        return true
    }

    /// 検査用。
    func resetForTest() { pendingDraft = nil; sendCalls = 0; presentedCount = 0 }
}
