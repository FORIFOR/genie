import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Canonical Gateway values. No local classifier turns `ended` into `COMPLETED`.
indirect enum OathraValue: Codable, Equatable {
    case object([String: OathraValue]), array([OathraValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: OathraValue].self) { self = .object(v) }
        else { self = .array(try c.decode([OathraValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> OathraValue { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    var text: String { if case .string(let v) = self { return v }; return "" }
    var number: Double? { if case .number(let v) = self { return v }; return nil }
    var flag: Bool { if case .bool(let v) = self { return v }; return false }
    var values: [OathraValue] { if case .array(let v) = self { return v }; return [] }
    var fields: [String: OathraValue] { if case .object(let v) = self { return v }; return [:] }
    var display: String {
        switch self { case .string(let v): return v; case .number(let v): return String(format: "%g", v); case .bool(let v): return v ? "はい" : "いいえ"; case .null: return "未確認"; default: return "詳細あり" }
    }
}

enum OathraConnectionError: LocalizedError {
    case invalidOrigin, invalidToken, invalidID, rejected(Int, String), invalidResponse, identityMismatch, disconnected
    var errorDescription: String? {
        switch self {
        case .invalidOrigin: return "接続先はHTTPSのオリジンを指定してください。HTTPはlocalhostだけに使えます。"
        case .invalidToken: return "Oathraの利用者用トークンを設定してください。"
        case .invalidID: return "正しいOathraの依頼IDを指定してください。"
        case .rejected(let status, let code): return "Oathraが受け付けませんでした（\(status): \(code)）。"
        case .invalidResponse: return "Oathraの応答形式を確認できません。"
        case .identityMismatch: return "応答の依頼IDが一致しません。操作を停止しました。"
        case .disconnected: return "Oathraとの通信を確認できません。下書きや発信の操作を繰り返さず、状況を確認してください。"
        }
    }
}

/// Redirects must not carry an operator credential to another origin.
private final class OathraNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

final class OathraGatewayClient {
    let origin: URL
    private let token: String
    private let session: URLSession
    private let delegate = OathraNoRedirect()

    static func originURL(_ input: String) throws -> URL {
        guard let c = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path == "" || c.path == "/", let host = c.host, !host.isEmpty,
              c.scheme == "https" || (c.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())),
              let url = c.url else { throw OathraConnectionError.invalidOrigin }
        return url
    }
    static func missionID(_ input: String) throws -> String {
        guard let id = UUID(uuidString: input), input.count == 36 else { throw OathraConnectionError.invalidID }
        return id.uuidString.lowercased()
    }
    init(origin: String, token: String, configuration: URLSessionConfiguration = .ephemeral) throws {
        self.origin = try Self.originURL(origin)
        guard !token.isEmpty, token.rangeOfCharacter(from: .newlines) == nil else { throw OathraConnectionError.invalidToken }
        self.token = token
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    func request(_ path: String, method: String = "GET", body: OathraValue? = nil, key: String? = nil) async throws -> OathraValue {
        guard path.hasPrefix("/"), !path.contains(".."), !path.contains("?") else { throw OathraConnectionError.invalidResponse }
        var request = URLRequest(url: origin.appendingPathComponent("v1" + path))
        request.httpMethod = method
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, data.count <= 4 * 1024 * 1024 else { throw OathraConnectionError.invalidResponse }
            guard (200...299).contains(http.statusCode) else {
                let parsed = try? JSONDecoder().decode(OathraValue.self, from: data)
                let code = parsed?["error"].text ?? "request_failed"
                let safe = !code.contains(token) && code.range(of: "^[a-z][a-z0-9_]{0,100}$", options: .regularExpression) != nil ? code : "request_failed"
                throw OathraConnectionError.rejected(http.statusCode, safe)
            }
            return try JSONDecoder().decode(OathraValue.self, from: data)
        } catch let error as OathraConnectionError { throw error }
        catch is CancellationError { throw CancellationError() }
        catch { throw OathraConnectionError.disconnected }
    }
    func mission(_ id: String) async throws -> OathraValue {
        let id = try Self.missionID(id), m = try await request("/missions/" + id)
        guard m["id"].text.lowercased() == id, m["kind"].text == "phone-request" else { throw OathraConnectionError.identityMismatch }
        return m
    }
    func record(_ id: String) async throws -> OathraValue {
        let id = try Self.missionID(id), r = try await request("/phone/calls/" + id)
        guard r["id"].text.lowercased() == id else { throw OathraConnectionError.identityMismatch }
        return r
    }
}
