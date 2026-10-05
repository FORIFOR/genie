import Foundation

/// Read-only task/error context omitted by the compact UniFFI TaskStatus.
/// A stopped local workflow does not prove an external order was cancelled.
struct TaskOutcomeContext: Equatable {
    let kind: String?
    let transactionResultUnknown: Bool
    var isTransaction: Bool { kind?.hasPrefix("transaction.") == true || transactionResultUnknown }

    static let stoppingTransaction = "操作の停止を依頼しました。注文の受付結果は未確認です。再注文せず履歴を確認してください。"
    static let stoppedTransactionUnknown = "操作を止めました。注文の受付結果は未確認です。再注文せず履歴を確認してください。"
    static let transactionUnknown = "注文の受付結果は未確認です。再注文せず、同じ注文の履歴を確認してください。"
    static let stoppingUnidentifiedTask = "停止を依頼しました。実行結果は未確認です。再実行せず履歴で状況を確認してください。"

    /// Accept GET /v1/tasks/:id and task.cancelled event envelopes from the same contract.
    static func decode(_ json: String) -> Self? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let kind = (object["kind"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let isCancellationEvent = object["type"] as? String == "task.cancelled"
            && object["payload"] is [String: Any]
        // Missing metadata is a failed read, not proof that an order is safe to repeat.
        guard kind?.isEmpty == false || isCancellationEvent else { return nil }
        let payload = object["payload"] as? [String: Any] ?? object
        let error = payload["error"] as? [String: Any]
        let result = error?["transaction_result"] as? [String: Any]
        return Self(kind: kind,
                    transactionResultUnknown: result?["status"] as? String == "unknown")
    }
}
