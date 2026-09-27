import Foundation
import GenieApproval
import GenieCore

/// SwiftUI/ViewModel と genie-core(UniFFI) の間の薄い層。
/// View から FFI を直接呼ばず、ここを通す（SwiftUI → GenieCoreBridge → UniFFI → Rust）。
enum GenieCoreBridge {
    /// 疎通確認にも使う core のバージョン。
    static var coreVersion: String { genieCoreVersion() }

    /// 録音の生の状態 → 表示（経過ラベル・状態文・オフライン表示）。派生の実装は Rust に一本化。
    static func snapshot(
        elapsedMs: UInt64, isPaused: Bool, link: LinkState, pendingMs: UInt64
    ) -> RecordingSnapshot {
        recordingSnapshot(input: RecordingInput(
            elapsedMs: elapsedMs, isPaused: isPaused, link: link, pendingMs: pendingMs))
    }

    /// 前回落ちたまま残っている録音。
    static func recoverable(root: String, active: String?) -> [RecoverableMeeting] {
        scanRecoverable(root: root, active: active)
    }
    /// gateway へ送り終えた会議を「アップロード済み」に印す（二重回復を防ぐ）。
    @discardableResult
    static func markUploaded(root: String, meetingId: String) -> Bool {
        markMeetingUploaded(root: root, meetingId: meetingId)
    }

    // gateway（実バックエンド）を core 経由で叩く。Tauri を介さない。
    static func reachable(_ baseUrl: String) -> Bool { apiReachable(baseUrl: baseUrl) }
    static func devSignIn(_ baseUrl: String, email: String, displayName: String) throws -> Tokens {
        try apiDevSignIn(baseUrl: baseUrl, email: email, displayName: displayName)
    }
    static func me(_ baseUrl: String, accessToken: String) throws -> Me {
        try apiMe(baseUrl: baseUrl, accessToken: accessToken)
    }
    static func createMeeting(_ baseUrl: String, accessToken: String, title: String, language: String) throws -> String {
        try apiCreateMeeting(baseUrl: baseUrl, accessToken: accessToken, title: title, language: language)
    }
    static func finishMeeting(_ baseUrl: String, accessToken: String, meetingId: String) throws -> String {
        try apiFinishMeeting(baseUrl: baseUrl, accessToken: accessToken, meetingId: meetingId)
    }
    static func uploadMeetingAudio(_ baseUrl: String, accessToken: String, meetingId: String, journalRoot: String) throws -> UInt64 {
        try apiUploadMeetingAudio(baseUrl: baseUrl, accessToken: accessToken, meetingId: meetingId, journalRoot: journalRoot)
    }
    static func startConversation(_ baseUrl: String, accessToken: String) throws -> String {
        try apiStartConversation(baseUrl: baseUrl, accessToken: accessToken)
    }
    /// 依頼を送る。`attachments` は端末内の画像の id とラベルだけ（画素は端末に残る）。
    static func sendTurn(_ baseUrl: String, accessToken: String, conversationId: String, text: String,
                         attachments: [TurnAttachment] = []) throws -> TurnOutcome {
        attachments.isEmpty
            ? try apiSendTurn(baseUrl: baseUrl, accessToken: accessToken, conversationId: conversationId, text: text)
            : try apiSendTurnWithAttachments(baseUrl: baseUrl, accessToken: accessToken, conversationId: conversationId,
                                             text: text, attachments: attachments)
    }
    static func sendRecoverableTurn(_ baseUrl: String, accessToken: String, conversationId: String,
                                    requestId: String, text: String, attachments: [TurnAttachment], replyCandidatesJson: String) throws -> TurnOutcome {
        try apiSendRecoverableTurn(baseUrl: baseUrl, accessToken: accessToken, conversationId: conversationId,
                                  requestId: requestId, text: text, attachments: attachments, replyCandidatesJson: replyCandidatesJson)
    }
    static func recoverTurn(_ baseUrl: String, accessToken: String, conversationId: String, requestId: String) throws -> TurnOutcome? {
        try apiRecoverTurn(baseUrl: baseUrl, accessToken: accessToken, conversationId: conversationId, requestId: requestId)
    }
    static func pluginCatalog(_ baseUrl: String, accessToken: String) throws -> [String] {
        try apiPluginCatalog(baseUrl: baseUrl, accessToken: accessToken)
    }
    static func createTask(_ baseUrl: String, accessToken: String, kind: String, inputJson: String) throws -> String {
        try apiCreateTask(baseUrl: baseUrl, accessToken: accessToken, kind: kind, inputJson: inputJson)
    }
    static func waitTask(_ baseUrl: String, accessToken: String, taskId: String, timeoutMs: UInt64) throws -> TaskStatus {
        try apiWaitTask(baseUrl: baseUrl, accessToken: accessToken, taskId: taskId, timeoutMs: timeoutMs)
    }
    static func artifactContent(_ baseUrl: String, accessToken: String, artifactId: String) throws -> String {
        try apiArtifactContent(baseUrl: baseUrl, accessToken: accessToken, artifactId: artifactId)
    }
    // connector（外部サービス連携）の契約層。authorize URL 組み立て・PKCE は core が正本。
    // live なトークン交換は提供者ごとの外部処理で、ここには持たない。
    static func pkceChallenge(_ verifier: String) -> String { connectorPkceChallenge(verifier: verifier) }
    static func authorizeUrl(provider: String, clientId: String, redirectUri: String,
                             scopes: [String], state: String, codeChallenge: String) -> String? {
        connectorAuthorizeUrl(providerId: provider, clientId: clientId, redirectUri: redirectUri,
                              scopes: scopes, state: state, codeChallenge: codeChallenge)
    }
    static func configuredProviders(_ clientIds: [String: String]) -> [String] {
        connectorConfiguredProviderIds(clientIds: clientIds)
    }
    static func tokenUrl(provider: String) -> String? { connectorTokenUrl(providerId: provider) }
    /// 認可コードをトークンへ（PKCE）。失敗は空文字。
    static func exchangeCode(tokenUrl: String, provider: String, clientId: String, redirectUri: String,
                             code: String, verifier: String) -> String {
        connectorExchangeCode(tokenUrl: tokenUrl, providerId: provider, clientId: clientId, redirectUri: redirectUri,
                              code: code, codeVerifier: verifier, nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
    }
    static func pluginConnections(_ baseUrl: String, accessToken: String, pluginId: String) throws -> String {
        try apiPluginConnections(baseUrl: baseUrl, accessToken: accessToken, pluginId: pluginId)
    }
    static func pluginConnect(_ baseUrl: String, accessToken: String, pluginId: String, connectJson: String) throws -> String {
        try apiPluginConnect(baseUrl: baseUrl, accessToken: accessToken, pluginId: pluginId, connectJson: connectJson)
    }
    static func pluginDisconnect(_ baseUrl: String, accessToken: String, pluginId: String, connectorId: String) throws {
        try apiPluginDisconnect(baseUrl: baseUrl, accessToken: accessToken, pluginId: pluginId, connectorId: connectorId)
    }

    /// RAG コンテキストの並べ替え（決定的）。ランキングは core に一本化する。
    /// 語彙一致・新しさ・プロジェクト一致 × source 重みで採点し、上位を返す。
    static func rankContext(terms: [String], limit: UInt32, candidates: [ContextCandidate]) -> [ContextResult] {
        GenieCore.rankContext(query: ContextQuery(terms: terms, limit: limit), candidates: candidates)
    }

    static func library(_ baseUrl: String, accessToken: String) throws -> [String] {
        try apiLibrary(baseUrl: baseUrl, accessToken: accessToken)
    }

    // Work Context / Personalization。形は契約（@genie/contracts work.ts）が正本なので JSON のまま運ぶ。
    static func workContext(_ baseUrl: String, accessToken: String) throws -> String {
        try apiWorkContext(baseUrl: baseUrl, accessToken: accessToken)
    }
    static func workEvidence(_ baseUrl: String, accessToken: String, itemId: String) throws -> String {
        try apiWorkEvidence(baseUrl: baseUrl, accessToken: accessToken, itemId: itemId)
    }
    static func workCorrect(_ baseUrl: String, accessToken: String, itemId: String, action: String, note: String) throws {
        try apiWorkCorrect(baseUrl: baseUrl, accessToken: accessToken, itemId: itemId, action: action, note: note)
    }
    static func personalization(_ baseUrl: String, accessToken: String) throws -> String {
        try apiPersonalization(baseUrl: baseUrl, accessToken: accessToken)
    }
    // 「これ返して」/ 会議前 brief / 承認
    static func sendTurn(_ baseUrl: String, accessToken: String, conversationId: String, text: String,
                         attachments: [TurnAttachment], replyCandidatesJson: String) throws -> TurnOutcome {
        try apiSendTurnWithReplyCandidates(baseUrl: baseUrl, accessToken: accessToken, conversationId: conversationId,
                                           text: text, attachments: attachments, replyCandidatesJson: replyCandidatesJson)
    }
    static func workReplySend(_ baseUrl: String, accessToken: String, sendJson: String) throws -> String {
        try apiWorkReplySend(baseUrl: baseUrl, accessToken: accessToken, sendJson: sendJson)
    }
    static func workBriefNext(_ baseUrl: String, accessToken: String) throws -> String {
        try apiWorkBriefNext(baseUrl: baseUrl, accessToken: accessToken)
    }
    /// 動いている仕事へ追加指示を渡す。返すのは状態（RECEIVED）。受け取った ≠ 反映した。
    static func addTaskInstruction(_ baseUrl: String, accessToken: String, taskId: String,
                                   requestId: String, text: String) throws -> String {
        try apiAddTaskInstruction(baseUrl: baseUrl, accessToken: accessToken, taskId: taskId,
                                  requestId: requestId, text: text)
    }
    static func taskApprovals(_ baseUrl: String, accessToken: String, taskId: String) throws -> String {
        try apiTaskApprovals(baseUrl: baseUrl, accessToken: accessToken, taskId: taskId)
    }
    /// いま答えを待っている承認を、カードに出せる形で読む。読むだけで答えない。
    static func pendingApprovals(_ baseUrl: String, accessToken: String, taskId: String) throws -> [BackendApproval] {
        BackendApproval.parse(try taskApprovals(baseUrl, accessToken: accessToken, taskId: taskId))
    }
    /// 承認を中継する。**`UserApproval`（人がカードで押した証拠）が無いと呼べない。**
    /// 証拠はコピーできず、ここで使い切る（1 回の「実行する」を 2 件の承認に使えない）。
    /// 実際に答えるのは GenieApproval の `ApprovalRelay` だけで、生の FFI（`apiTaskApprove`）は
    /// このアプリの中からは呼ばない —— `scripts/verify-approval-boundary.sh` が数える。
    static func taskApprove(_ baseUrl: String, accessToken: String, taskId: String, approvalId: String,
                            approval: consuming UserApproval) throws {
        try ApprovalRelay.approve(baseUrl, accessToken: accessToken, taskId: taskId, approvalId: approvalId, approval: approval)
    }
    /// 承認しない（REJECTED）。止める方向なので証拠は要らない。backend はこの仕事を CANCELLED にする。
    /// **呼ぶのは人が「やめる」を押したときだけ**（答えが無い・カードが見えないは PENDING のまま残す）。
    static func taskReject(_ baseUrl: String, accessToken: String, taskId: String, approvalId: String) throws {
        try ApprovalRelay.reject(baseUrl, accessToken: accessToken, taskId: taskId, approvalId: approvalId)
    }
    static func taskGet(_ baseUrl: String, accessToken: String, taskId: String) throws -> String {
        try apiTaskJson(baseUrl: baseUrl, accessToken: accessToken, taskId: taskId)
    }
    static func personalizationUpdate(_ baseUrl: String, accessToken: String, updateJson: String) throws -> String {
        try apiPersonalizationUpdate(baseUrl: baseUrl, accessToken: accessToken, updateJson: updateJson)
    }
}

/// backend が止めて待っている承認 1 件（`GET /v1/tasks/:id/approvals` の items[]）。
///
/// 形は契約（`@genie/contracts` approval.ts の Approval / ApprovalImpact）が正本。
/// server は details 列に `{ items: [{label, value}], impact: {...} }` を入れて返す（古い行は配列だけ）。
/// 読めない項目は捨てるが、id の無いものは承認として扱わない。
struct BackendApproval: Equatable {
    struct Detail: Equatable { let label: String; let value: String }
    struct Impact: Equatable {
        let primaryActionLabel: String?
        let affectedCount: Int?
        let external: Bool
        let reversible: Bool
        let recoveryNote: String?
    }
    let id: String
    let summary: String
    /// backend の ActionRisk（READ / REVERSIBLE_WRITE / EXTERNAL_COMMIT / DESTRUCTIVE / REGULATED / FINANCIAL）。
    let risk: String
    var details: [Detail] = []
    var impact: Impact?
    /// 返ってくれば使う（今の server は tool_id をカードの型に含めない）。
    var toolID: String?

    func detail(_ label: String) -> String? { details.first { $0.label == label }?.value }

    static func parse(_ json: String) -> [BackendApproval] {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = obj["items"] as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            var raw: Any? = item["details"]
            if let text = raw as? String, let d = text.data(using: .utf8) { raw = try? JSONSerialization.jsonObject(with: d) }
            let container = raw as? [String: Any]
            let rows = (container?["items"] as? [[String: Any]]) ?? (raw as? [[String: Any]]) ?? []
            let impactObj = (item["impact"] as? [String: Any]) ?? (container?["impact"] as? [String: Any])
            return BackendApproval(
                id: id,
                summary: (item["summary"] as? String) ?? "",
                risk: (item["risk"] as? String) ?? "",
                details: rows.compactMap { r in
                    guard let label = r["label"] as? String else { return nil }
                    if let v = r["value"] as? String { return Detail(label: label, value: v) }
                    if let v = r["value"] as? NSNumber { return Detail(label: label, value: v.stringValue) }
                    return nil
                },
                impact: impactObj.map { i in
                    Impact(primaryActionLabel: (i["primary_action_label"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                           affectedCount: (i["affected_count"] as? NSNumber)?.intValue,
                           external: (i["scope"] as? String) != "internal",
                           reversible: (i["reversible"] as? Bool) ?? false,
                           recoveryNote: i["recovery_note"] as? String)
                },
                toolID: (item["tool_id"] as? String) ?? (item["tool"] as? String))
        }
    }
}
