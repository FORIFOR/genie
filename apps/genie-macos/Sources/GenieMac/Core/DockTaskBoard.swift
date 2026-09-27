import Foundation

// One Continuous Surface（docs/ux-benchmark/compare/continuous-surface/ROUND.md）。
//
// 音声（何を聞いている・話している）と仕事（何件が、どこまで進んだか）を**別々に持ち**、
// Dock に出す一枚の面は、表示の直前にこの二つから純関数で決める（`DockComposer`）。
// 以前は各所が `setDock(.agent)` / `setDock(.result(...))` を直接書き、後から来た表示が
// 先の表示を上書きしていた（仕事の結果で会話の面が消える・止めた仕事が ✓ に戻る）。

/// Dock に行として出す仕事 1 件。backend の仕事でも、会議の AI 操作でもよい。
struct DockTask: Identifiable, Equatable {
    let id: UUID
    /// 出来事の番号。**単調に増える**。これ以下の番号の出来事は古いので捨てる（巻き戻らない）。
    var rev: Int
    var title: String
    /// いまの工程名。取れなければ状態語（「作業中」）。割合は持たない（取れない数字を作らない）。
    var step: String
    var status: Status
    var startedAt: Date
    /// 終わった時刻（結果を縮める時計の起点）。
    var endedAt: Date?

    enum Status: Equatable {
        case running
        case awaitingApproval
        /// 成果物を確かめられたときだけ。成果物の無い成功は `failed` にする。
        case succeeded(DockArtifact)
        case failed(String)
        case cancelled(String)
    }

    var isActive: Bool {
        switch status { case .running, .awaitingApproval: return true; default: return false }
    }
    var isTerminal: Bool { !isActive }
}

/// できた物。「完了しました」だけで終わらせず、何ができたかと、使う操作を出す。
struct DockArtifact: Equatable {
    /// 「下書き」「回答」など、何ができたか。
    var kind: String
    var title: String
    /// 2 行目（例「312字 · Work に保存」）。
    var detail: String
    /// 実際にできることだけ。
    var actions: [AgentResult.Action]
}

/// 仕事の出来事。`rev` は仕事ごとに単調増加。
struct DockTaskEvent: Equatable {
    let taskId: UUID
    let rev: Int
    let kind: Kind

    enum Kind: Equatable {
        case started(title: String, step: String)
        case step(String)
        case awaitingApproval
        case succeeded(DockArtifact)
        case failed(String)
        case cancelled(String)
    }
}

/// 受付の応答。**受け付けた（backend に仕事ができた）ときだけ**「かしこまりました」。
/// 受け付けられなかった依頼は `rejected` で、受け付けたようには見せない。
struct DockAck: Equatable, Identifiable {
    let id: UUID
    let title: String
    /// nil なら受付。値があれば受け付けられなかった理由。
    var rejected: String?
}

/// 仕事の一覧。出来事を順に当て、古い出来事と、終わった仕事への出来事を捨てる。
struct DockTaskBoard: Equatable {
    private(set) var tasks: [DockTask] = []

    var active: [DockTask] { tasks.filter(\.isActive) }
    func task(_ id: UUID) -> DockTask? { tasks.first { $0.id == id } }

    /// 当てたら true。古い（rev が今以下）・終わった仕事への出来事・知らない仕事への途中の出来事は false。
    @discardableResult
    mutating func apply(_ event: DockTaskEvent, now: Date = Date()) -> Bool {
        guard let i = tasks.firstIndex(where: { $0.id == event.taskId }) else {
            guard case .started(let title, let step) = event.kind else { return false }
            tasks.append(DockTask(id: event.taskId, rev: event.rev, title: title, step: step,
                                  status: .running, startedAt: now))
            return true
        }
        var task = tasks[i]
        guard event.rev > task.rev, task.isActive else { return false }
        task.rev = event.rev
        switch event.kind {
        case .started(let title, let step): task.title = title; task.step = step
        case .step(let step): task.step = step; task.status = .running
        case .awaitingApproval: task.status = .awaitingApproval
        case .succeeded(let artifact): task.status = .succeeded(artifact); task.endedAt = now
        case .failed(let reason): task.status = .failed(reason); task.endedAt = now
        case .cancelled(let reason): task.status = .cancelled(reason); task.endedAt = now
        }
        tasks[i] = task
        return true
    }

    /// 動いていても外す（すぐ答えが出た依頼・追うのをやめた依頼）。
    mutating func discard(_ id: UUID) { tasks.removeAll { $0.id == id } }

    /// 終わった仕事を一覧から外す（履歴は Work に残る）。動いている仕事は外さない。
    mutating func forget(_ id: UUID) {
        tasks.removeAll { $0.id == id && $0.isTerminal }
    }
}

/// Dock に出す一枚を決める（純関数）。優先順:
/// 1. 本人が始めた聞き取り・送信中（listening / thinking）
/// 2. 確認待ち（承認はカードでだけ。時間で縮めない）
/// 3. 受付の応答（かしこまりました / 受け付けられません）
/// 4. 本人・声が頼んだ面（答え・天気・Quick Actions・会議など）
/// 5. 注目している結果（完了・失敗・停止）
/// 6. 動いている仕事（1 件以上）
/// 7. 待機
enum DockComposer {
    static func compose(requested: DockPresentation,
                        confirmation: ActionConfirmation?,
                        ack: DockAck?,
                        focusedResult: DockTask?,
                        activeCount: Int,
                        conversationActive: Bool) -> DockPresentation {
        switch requested {
        case .listening, .thinking:
            // 会話の自動の聞き直しは、確認カードを隠さない（本人が始めた聞き取りだけが前に出る）。
            if confirmation == nil || !conversationActive { return requested }
        default: break
        }
        if let confirmation { return .confirmation(confirmation) }
        if let ack { return .ack(ack) }
        switch requested {
        case .idle, .agent: break
        case .result(let r) where r.taskID != nil: break   // 仕事の結果は下の focusedResult が決める
        default: return requested
        }
        if let task = focusedResult, let result = AgentResult(task: task) { return .result(result) }
        if activeCount > 0 { return .agent }
        return .idle
    }
}

extension AgentResult {
    /// 終わった仕事を結果の面にする。動いている仕事なら nil。
    init?(task: DockTask) {
        switch task.status {
        case .running, .awaitingApproval: return nil
        case .succeeded(let artifact):
            self.init(title: artifact.title, actions: artifact.actions, detail: artifact.detail,
                      kind: artifact.kind, taskID: task.id)
        case .failed(let reason):
            self.init(title: task.title, actions: [.retry], detail: reason, failed: true, taskID: task.id)
        case .cancelled(let reason):
            self.init(title: task.title, actions: [], detail: reason, failed: true, cancelled: true, taskID: task.id)
        }
    }
}

/// 結果をいつ縮めるか。**ホバー中は保持**。離れてから、完了は 8 秒・停止は 3 秒。失敗は閉じるまで。
enum DockResultPolicy {
    static func holdSeconds(for status: DockTask.Status) -> TimeInterval? {
        switch status {
        case .succeeded: return 8
        case .cancelled: return 3
        case .failed, .running, .awaitingApproval: return nil
        }
    }
}
