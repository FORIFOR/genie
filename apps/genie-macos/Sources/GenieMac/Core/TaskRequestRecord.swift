import Foundation

/// A user's request and its outcome are durable; credentials and captured pixels are not.
struct TaskRequestRecord: Codable, Equatable {
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
    var backendTaskID = ""
    var backendKind: String?
    var verificationLabel: String?
    var artifactID = ""
    var phase: Phase = .submitting
    var result = ""
    var message = ""
    var updatedAt = Date()
    // Deliberately no token, OAuth reply metadata, screenshots, or automatic resend flag.
    var canRefresh: Bool { !backendTaskID.isEmpty && phase != .complete && phase != .failed && phase != .cancelled }
    var hasResult: Bool { phase == .complete && !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

struct TaskReply {
    var text: String
    var phase: TaskRequestRecord.Phase
    var artifactID = ""
    var verificationLabel: String?
    var settled: Bool { phase != .working && phase != .waiting }
}

extension AgentTask {
    var stateTitle: String { requestRecord?.verificationLabel ?? requestRecord?.phase.title ?? status.displayTitle }
    var summary: String {
        guard let record = requestRecord else { return failureReason ?? startedAt.formatted(date: .abbreviated, time: .shortened) }
        guard record.hasResult else { return record.message }
        let firstLine = String(record.result.split(separator: "\n").first ?? "")
        return firstLine.replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression)
    }
    /// Export is deterministic and local. Opening or copying never asks the model again.
    var document: String {
        guard let record = requestRecord, record.hasResult else { return "" }
        return "# \(title)\n\n\(record.result)\n\n---\n\n依頼\n\n\(record.request)\n"
    }
}
