import AppKit
import Foundation

/// Follows the existing durable task. It never resends a user request or creates a second job.
@MainActor
final class ExecutionTaskMonitor {
    static let shared = ExecutionTaskMonitor()
    private var active: Set<UUID> = []
    private var stopping: Set<UUID> = []
    private var prepared: Set<UUID> = []

    func begin(_ id: UUID) -> Bool {
        guard !active.contains(id), let task = LocalStore.shared.loadTasks().first(where: { $0.id == id }) else { return false }
        if let running = GenieStateStore.shared.state.activeTask, running.id != id, running.status == .running { return false }
        active.insert(id)
        var next = task
        next.requestRecord?.backendKind = "execution.run"
        next.steps = [AgentStep(title: "方法と内容を確認", tool: "execution.prepare", state: .running),
                      AgentStep(title: "実行・結果確認", tool: "execution.apply")]
        GenieStateStore.shared.startTask(next)
        WindowCoordinator.shared.showVoiceHUD()
        return true
    }
    func progress(_ id: UUID, status: String) {
        guard active.contains(id), var task = LocalStore.shared.loadTasks().first(where: { $0.id == id }) else { return }
        if status == "WAITING_APPROVAL" { prepared.insert(id) }
        let ready = prepared.contains(id)
        task.steps = [AgentStep(title: "方法と内容を確認", tool: "execution.prepare", state: ready ? .success : .running),
                      AgentStep(title: "実行・結果確認", tool: "execution.apply",
                        detail: stopping.contains(id) || status == "CANCELLING" ? "停止を要求しています" : status == "WAITING_APPROVAL" ? "内容の承認待ち" : ready ? "確認した経路で実行中" : "準備を待っています",
                        state: ready && status != "WAITING_APPROVAL" ? .running : .pending)]
        task.status = .running
        // Do not replace a confirmation in progress or force-open a user-collapsed Dock.
        GenieStateStore.shared.trackExecution(task)
    }
    func end(_ id: UUID) { active.remove(id); prepared.remove(id); stopping.remove(id) }

    func approve(_ items: [[String: Any]], localID: UUID) -> String? {
        guard active.contains(localID), !stopping.contains(localID), items.count == 1,
              let item = items.first, item["id"] is String,
              let expiry = item["expires_at"] as? String, let date = ExecutionReceipt.date(expiry), date > Date(),
              let details = item["details"] as? [String: Any], let rows = details["items"] as? [[String: String]],
              !rows.isEmpty, rows.count <= 10, rows.allSatisfy({ $0["label"] != nil && $0["value"] != nil }) else { return nil }
        let preview = rows.map { "\($0["label"]!): \($0["value"]!)" }.joined(separator: "\n\n")
        guard preview.utf8.count < 70000 else { return nil }
        let confirmation = ActionConfirmation(app: "Genie", appIcon: "checkmark.shield", title: "この内容を実行します",
            preview: preview, details: ["変更が残る場合があります。修正する場合は中止して、改めて依頼してください。"],
            risk: .r3, confirmLabel: "この内容で実行")
        // The fallback small modal does not show preview. Require the real Dock instead.
        WindowCoordinator.shared.showVoiceHUD()
        guard WindowCoordinator.shared.isVoiceHUDVisible else { return "REJECTED" }
        let accepted = Confirm.ask(confirmation)
        guard date > Date(), !stopping.contains(localID) else { return "REJECTED" }
        return accepted ? "APPROVED" : "REJECTED"
    }
    func cancelling(_ id: UUID) { stopping.insert(id); progress(id, status: "CANCELLING") }
    func cancelFailed(_ id: UUID) { stopping.remove(id); progress(id, status: "RUNNING") }

    nonisolated static func follow(_ outcome: TurnOutcome, localID: UUID, base: String, token: String, waitMs: UInt64) async throws -> TaskReply {
        guard !outcome.taskId.isEmpty, !outcome.needsClarification, outcome.answer.isEmpty else {
            return try VoiceHUDState.followUp(outcome, base: base, token: token, waitMs: waitMs)
        }
        let first = try dictionary(GenieCoreBridge.taskGet(base, accessToken: token, taskId: outcome.taskId))
        guard first["kind"] as? String == "execution.run" else {
            return try VoiceHUDState.followUp(outcome, base: base, token: token, waitMs: waitMs)
        }
        guard await shared.begin(localID) else {
            return TaskReply(text: "この仕事はWorkから状況を確認できます。別の確認中は同時に実行を承認しません。", phase: .waiting)
        }
        do {
            let answer = try await followExecution(outcome.taskId, localID: localID, base: base, token: token)
            await shared.end(localID)
            return answer
        } catch { await shared.end(localID); throw error }
    }
    nonisolated private static func followExecution(_ taskID: String, localID: UUID, base: String, token: String) async throws -> TaskReply {
        let deadline = Date().addingTimeInterval(600)
        var answered: Set<String> = []
        while Date() < deadline {
            try Task.checkCancellation()
            let task = try dictionary(GenieCoreBridge.taskGet(base, accessToken: token, taskId: taskID))
            guard task["kind"] as? String == "execution.run", let status = task["status"] as? String else { throw MonitorError.invalid }
            if status == "COMPLETED" {
                let artifact = task["result_artifact_id"] as? String ?? ""
                guard !artifact.isEmpty else { return TaskReply(text: "完了確認の控えが返されませんでした。再実行せず実行先を確認してください。", phase: .needsInput) }
                let content = try GenieCoreBridge.artifactContent(base, accessToken: token, artifactId: artifact)
                guard let receipt = ExecutionReceipt.parse(content, taskKind: "execution.run") else {
                    return TaskReply(text: "結果の確認情報を読み取れませんでした。検証済みとは表示しません。", phase: .needsInput, artifactID: artifact)
                }
                return TaskReply(text: receipt.text, phase: receipt.verified ? .complete : .needsInput,
                    artifactID: artifact, verificationLabel: receipt.label)
            }
            if status == "FAILED" || status == "CANCELLED" {
                return TaskReply(text: status == "CANCELLED" ? "停止しました。すでに行った変更は取り消していません。" :
                    "完了できませんでした。二重実行を防ぐため再送していません。実行先の状態を確認してください。",
                    phase: status == "CANCELLED" ? .cancelled : .failed)
            }
            await shared.progress(localID, status: status)
            if status == "WAITING_APPROVAL" {
                let pending = try dictionary(GenieCoreBridge.taskApprovals(base, accessToken: token, taskId: taskID))
                let items = pending["items"] as? [[String: Any]] ?? []
                if let id = items.first?["id"] as? String, !answered.contains(id),
                   let decision = await shared.approve(items, localID: localID) {
                    // Expiry and approval status are rechecked on the server; no local-only success.
                    try GenieCoreBridge.taskApprove(base, accessToken: token, taskId: taskID, approvalId: id, decision: decision)
                    answered.insert(id)
                    if decision == "APPROVED" { await shared.progress(localID, status: "RUNNING"); await MainActor.run { GenieStateStore.shared.setDock(.agent) } }
                }
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        return TaskReply(text: "結果の確定をまだ確認できません。Workから同じ仕事の状況を確認してください。依頼は再送していません。", phase: .waiting)
    }
    nonisolated private static func dictionary(_ json: String) throws -> [String: Any] {
        guard let data = json.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MonitorError.invalid }
        return value
    }
    enum MonitorError: Error { case invalid }
}

/// Redirects never forward the access token to another host. No token is persisted.
final class ExecutionNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
extension ExecutionTaskMonitor {
    nonisolated static func cancel(base: String, token: String, taskID: String) async throws {
        guard UUID(uuidString: taskID) != nil, let url = URL(string: base + "/v1/tasks/" + taskID + "/cancel") else { throw MonitorError.invalid }
        let session = URLSession(configuration: .ephemeral, delegate: ExecutionNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.timeoutInterval = 10
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{\"reason\":\"Stopped from TaskDock\"}".utf8)
        let (_, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw MonitorError.invalid }
    }
}
