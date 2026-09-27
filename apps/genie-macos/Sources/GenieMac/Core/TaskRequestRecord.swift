import Foundation

/// A user's request and its outcome are durable; credentials and captured pixels are not.
struct TaskRequestRecord: Codable, Equatable {
    static let firstExample = "次のメモを、次の行動と担当者が分かるチェックリストにしてください。アプリをテストする、デモを録画する、リリースノートを書く。分からない担当者は「未定」とし、文章だけを作ってください。"

    enum Phase: String, Codable {
        case submitting, working, waiting, complete, needsInput, failed, unknown, cancelled
        var title: String {
            switch self {
            case .submitting: return "依頼を届けています"
            case .working: return "作成中"
            case .waiting: return "続行待ち"
            case .complete: return "成果物ができました"
            case .needsInput: return "確認が必要です"
            case .failed: return "完了できませんでした"
            case .unknown: return "状況を確認してください"
            case .cancelled: return "取り消されました"
            }
        }
        var runState: AgentRunState {
            switch self {
            case .submitting, .working: return .running
            case .waiting: return .pending
            case .complete: return .success
            case .needsInput, .failed, .unknown, .cancelled: return .failed
            }
        }
    }
    static func title(for request: String) -> String {
        let first = request.split(whereSeparator: { $0 == "\n" || $0 == "。" }).first.map(String.init) ?? request
        return first.count > 48 ? String(first.prefix(47)) + "…" : first
    }
    var request: String
    var base: String
    var conversationID = ""
    /// Saved before submission. Older records have no receipt and cannot infer acceptance.
    var turnRequestID: String?
    var backendTaskID = ""
    var artifactID = ""
    var phase: Phase = .submitting
    var result = ""
    /// Optional for compatibility with older saved JSON; original model text is retained.
    var editedResult: String?
    var documentText: String { editedResult ?? result }
    var message = ""
    var updatedAt = Date()
    // Deliberately no token, OAuth reply metadata, screenshots, or automatic resend flag.
    var canRefresh: Bool {
        let canLocate = !backendTaskID.isEmpty || (!conversationID.isEmpty && !(turnRequestID ?? "").isEmpty)
        return canLocate && phase != .complete && phase != .failed && phase != .cancelled && phase != .needsInput
    }
    var hasResult: Bool { phase == .complete && !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

struct TaskReply {
    var text: String
    var phase: TaskRequestRecord.Phase
    var artifactID = ""
    /// 天気・ニュースの答えなら、そのカード。`text` はカードの文（Work にはこちらを残す）。
    var info: InfoCard? = nil
    var settled: Bool { phase != .working && phase != .waiting }
}

extension AgentTask {
    var stateTitle: String { requestRecord?.phase.title ?? status.displayTitle }
    var summary: String {
        guard let record = requestRecord else { return failureReason ?? startedAt.formatted(date: .abbreviated, time: .shortened) }
        guard record.hasResult else { return record.message }
        let firstLine = String(record.documentText.split(separator: "\n").first ?? "")
        return firstLine.replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression)
    }
    /// Export is deterministic and local. Opening or copying never asks the model again.
    var document: String {
        guard let record = requestRecord, record.hasResult else { return "" }
        return "# \(title)\n\n\(record.documentText)\n\n---\n\n依頼\n\n\(record.request)\n"
    }
}

extension AgentTask {
    /// Prepare an edit without changing task identity, phase or original model output.
    func editingDocument(_ text: String) -> AgentTask? {
        guard var record = requestRecord, record.hasResult,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        record.editedResult = text
        record.updatedAt = Date()
        var edited = self
        edited.requestRecord = record
        return edited
    }
}
