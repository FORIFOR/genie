import Foundation

/// UI transport for the experimental, simulation-only contract. The server validates and reserves quota.
struct TransactionScope: Codable, Equatable {
    struct Destination: Codable, Equatable { let id: String; let label: String }
    struct Item: Codable, Equatable { let id: String; let label: String; let quantity: Int64; let options: [String] }
    struct Stock: Codable, Equatable {
        let symbol: String; let market: String; let side: String; let quantity: Int64
        let orderType: String; let limitPriceMinor: Int64?; let timeInForce: String
    }
    let kind: String; let mode: String; let provider: String; let account: String; let currency: String
    let destination: Destination; let paymentMethodRef: String; let requestedTime: String?
    let stock: Stock?; let items: [Item]

    var review: String {
        var lines = ["シミュレーションのみ（実際の注文・決済・株取引は行いません）",
                     "注文先: \(provider)", "アカウント: \(account)",
                     "配送先・対象: \(destination.label) (\(destination.id))", "支払方法: \(paymentMethodRef)"]
        if let requestedTime { lines.append("希望時刻: \(requestedTime == "asap" ? "できるだけ早く" : requestedTime)") }
        lines += items.map { "\($0.label) (\($0.id)) × \($0.quantity)" + ($0.options.isEmpty ? "" : "\nオプション: \($0.options.joined(separator: "、"))") }
        if let stock {
            lines.append("株式条件: \(stock.symbol) / \(stock.market) / \(stock.side == "BUY" ? "買い" : "売り") \(stock.quantity)株 / \(stock.orderType) / \(stock.timeInForce)")
            if let price = stock.limitPriceMinor { lines.append("指値: \(TransactionMoney.display(price, currency: currency))") }
        }
        return lines.joined(separator: "\n")
    }
}

enum TransactionMoney {
    static let safeMaximum: Int64 = 9_007_199_254_740_991
    static func exponent(_ currency: String) -> Int { currency == "JPY" ? 0 : (currency == "USD" ? 2 : 0) }
    static func unit(_ currency: String) -> String { ["JPY", "USD"].contains(currency) ? currency : "\(currency) minor units" }
    static func input(_ minor: Int64, currency: String) -> String {
        guard exponent(currency) == 2 else { return String(minor) }
        return "\(minor / 100)." + String(format: "%02lld", minor % 100)
    }
    static func display(_ minor: Int64, currency: String) -> String { "\(unit(currency)) \(input(minor, currency: currency))" }
    static func parse(_ text: String, currency: String) -> Int64? {
        let value = text.trimmingCharacters(in: .whitespaces)
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard !value.isEmpty, parts.count <= 2, !parts[0].isEmpty,
              parts.allSatisfy({ $0.utf8.allSatisfy { (48...57).contains($0) } }),
              let whole = Int64(parts[0]), whole >= 0 else { return nil }
        let exponent = exponent(currency)
        if exponent == 0 { return parts.count == 1 && whole <= safeMaximum ? whole : nil }
        guard parts.count == 1 || (1...2).contains(parts[1].count), whole <= safeMaximum / 100 else { return nil }
        let fraction = parts.count == 1 ? 0 : (Int64(parts[1]) ?? 0) * (parts[1].count == 1 ? 10 : 1)
        let result = whole * 100 + fraction
        return result <= safeMaximum ? result : nil
    }
}

struct TransactionAuthorizationSpec: Codable, Equatable {
    let scope: TransactionScope
    let maxPerOrderMinor: Int64; let maxTotalMinor: Int64; let maxOrders: Int; let expiresAt: String
}

struct TransactionAuthorizationRecord: Codable, Equatable, Identifiable {
    let id: String; let createdBy: String; let createdAt: String; let status: String; let revokedAt: String?
    let spec: TransactionAuthorizationSpec; let usedOrders: Int; let usedTotalMinor: Int64
    var remainingOrders: Int { max(0, spec.maxOrders - usedOrders) }
    var remainingMinor: Int64 { max(0, spec.maxTotalMinor - usedTotalMinor) }
    func isActive(at now: Date = Date()) -> Bool {
        status == "ACTIVE" && (TransactionAuthorizationContext.date(spec.expiresAt) ?? .distantPast) > now
    }
}

struct TransactionAuthorizationContext: Equatable {
    let scope: TransactionScope
    /// Preserve every server intent field: removing exactly these two keys must not widen the scope.
    let scopeJSON: Data
    let maxPerOrderMinor: Int64
    let quoteTotalMinor: Int64
    let quoteExpiresAt: Date

    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func decode(_ data: Data, now: Date = Date()) throws -> Self {
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              var intent = raw["intent"] as? [String: Any], let quote = raw["quote"] as? [String: Any],
              let hash = raw["quoteHash"] as? String, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              intent["mode"] as? String == "simulation", quote["mode"] as? String == "simulation",
              let expires = quote["expiresAt"] as? String, let expiry = date(expires), expiry > now,
              let budget = intent["maxTotalMinor"] as? NSNumber,
              let totals = quote["totals"] as? [String: Any], let total = totals["totalMinor"] as? NSNumber,
              let maxPer = Int64(budget.stringValue), let quoted = Int64(total.stringValue),
              quoted >= 0, maxPer >= quoted, maxPer <= TransactionMoney.safeMaximum else { throw TransactionAuthorizationAPI.Failure.invalidResponse }
        // The server binds the exact context to the approval. Check identity locally as well.
        for key in ["kind", "mode", "provider", "account", "orderKey", "currency", "paymentMethodRef", "requestedTime"] {
            guard String(describing: intent[key]) == String(describing: quote[key]) else { throw TransactionAuthorizationAPI.Failure.invalidResponse }
        }
        intent.removeValue(forKey: "orderKey"); intent.removeValue(forKey: "maxTotalMinor")
        let scopeJSON = try JSONSerialization.data(withJSONObject: intent, options: [.sortedKeys])
        let scope = try JSONDecoder().decode(TransactionScope.self, from: scopeJSON)
        guard !scope.items.isEmpty, scope.kind == "delivery" || scope.kind == "stock_paper",
              scope.kind == "delivery" ? scope.requestedTime != nil && scope.stock == nil : scope.stock != nil && scope.requestedTime == nil
        else { throw TransactionAuthorizationAPI.Failure.invalidResponse }
        return Self(scope: scope, scopeJSON: scopeJSON, maxPerOrderMinor: maxPer, quoteTotalMinor: quoted, quoteExpiresAt: expiry)
    }
    func body(requestID: UUID, approvalID: String, spec: TransactionAuthorizationSpec) throws -> Data {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(spec)) as! [String: Any]
        object["scope"] = try JSONSerialization.jsonObject(with: scopeJSON)
        return try JSONSerialization.data(withJSONObject: ["requestId": requestID.uuidString.lowercased(), "approvalId": approvalID, "spec": object], options: [.sortedKeys])
    }
}

struct TransactionAuthorizationAPI {
    enum Failure: Error { case invalidResponse, status(Int), notConnected }
    struct Created: Decodable { let authorization: TransactionAuthorizationRecord; let approvalId: String? }
    let base: String; let token: String
    var send: ((URLRequest) async throws -> (Data, HTTPURLResponse))? = nil

    func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        guard let url = URL(string: base + path),
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) else { throw Failure.invalidResponse }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let data: Data; let response: HTTPURLResponse
        if let send { (data, response) = try await send(request) }
        else {
            let session = URLSession(configuration: .ephemeral, delegate: TransactionNoRedirect(), delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            let result = try await session.data(for: request)
            guard let http = result.1 as? HTTPURLResponse else { throw Failure.invalidResponse }
            (data, response) = (result.0, http)
        }
        guard (200..<300).contains(response.statusCode) else { throw Failure.status(response.statusCode) }
        return data
    }
    func context(approvalID: String) async throws -> TransactionAuthorizationContext {
        guard UUID(uuidString: approvalID) != nil else { throw Failure.invalidResponse }
        return try TransactionAuthorizationContext.decode(await request("/v1/approvals/\(approvalID)/transaction-context"))
    }
    func create(_ body: Data) async throws -> Created {
        try JSONDecoder().decode(Created.self, from: await request("/v1/transaction-authorizations", method: "POST", body: body))
    }
    func list() async throws -> [TransactionAuthorizationRecord] {
        struct List: Decodable { let items: [TransactionAuthorizationRecord] }
        return try JSONDecoder().decode(List.self, from: await request("/v1/transaction-authorizations")).items
    }
    func revoke(_ id: String) async throws -> TransactionAuthorizationRecord {
        guard UUID(uuidString: id) != nil else { throw Failure.invalidResponse }
        return try JSONDecoder().decode(Created.self, from: await request("/v1/transaction-authorizations/\(id)/revoke", method: "POST", body: Data("{}".utf8))).authorization
    }
}

private final class TransactionNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
