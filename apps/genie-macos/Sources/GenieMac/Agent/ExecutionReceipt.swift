import Foundation

/// A receipt is interpreted only for an authenticated execution.run task, never from generic LLM prose.
struct ExecutionReceipt: Codable {
    let version: Int
    let status: String
    let route: String?
    let level: String?
    let summary: String
    let checkedAt: String?
    let evidence: String?

    var verified: Bool {
        guard version == 1, status == "verified", ["api", "mcp", "accessibility", "vision"].contains(route ?? ""),
              ["readback", "field", "visual"].contains(level ?? ""),
              let evidence, evidence.count == 64, evidence.allSatisfy({ "0123456789abcdef".contains($0) }),
              let checkedAt, Self.date(checkedAt) != nil, !summary.isEmpty, summary.count <= 500 else { return false }
        // A visual/field receipt must not be promoted to a saved-data badge.
        return (level == "readback" && ["api", "mcp"].contains(route ?? "")) ||
            (level == "field" && route == "accessibility") || (level == "visual" && route == "vision")
    }
    var label: String? {
        guard verified else { return nil }
        switch level {
        case "readback": return "保存内容を照合済み"
        case "field": return "入力欄を照合済み"
        case "visual": return "画面表示を確認済み"
        default: return nil
        }
    }
    var text: String {
        let limitation = level == "visual" ? "画面表示のみの確認です。保存・外部送信は未確認です。" :
            level == "field" ? "入力欄のみの確認です。保存・送信はアプリ側で確認してください。" :
            verified ? "実行先の内容を読み戻し、承認した内容と照合しています。" :
            "完了確認は取れていません。自動で書き込みを繰り返しません。"
        return [label, summary, limitation].compactMap { $0 }.joined(separator: "\n\n")
    }
    static func parse(_ content: String, taskKind: String) -> ExecutionReceipt? {
        let prefix = "<!--genie-execution:"
        guard taskKind == "execution.run", content.hasPrefix(prefix),
              let end = content.range(of: "-->"), content.distance(from: content.startIndex, to: end.lowerBound) <= 8192 else { return nil }
        let json = String(content[content.index(content.startIndex, offsetBy: prefix.count)..<end.lowerBound])
        guard let data = json.data(using: .utf8), let value = try? JSONDecoder().decode(Self.self, from: data),
              value.version == 1, ["verified", "needs_input", "unavailable", "unverified"].contains(value.status),
              !value.summary.isEmpty, value.summary.count <= 500,
              value.status != "verified" || value.verified else { return nil }
        return value
    }
    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
