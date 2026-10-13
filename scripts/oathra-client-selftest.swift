import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class FixtureProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
@main struct OathraClientSelfTest {
    static func main() async throws {
        var checks = 0
        func check(_ condition: Bool, _ message: String) { precondition(condition, message); checks += 1 }
        for url in ["https://example.test", "http://localhost:4244", "http://127.0.0.1:4245", "http://[::1]:4244"] { check((try? OathraGatewayClient.originURL(url)) != nil, "valid origin") }
        for url in ["http://example.test", "https://user:secret@example.test", "https://example.test/v1", "https://example.test?key=x", "https://example.test#x", "http://127.0.0.1.evil.test"] { check((try? OathraGatewayClient.originURL(url)) == nil, "invalid origin") }
        let id = "12345678-1234-1234-1234-123456789abc"
        check((try? OathraGatewayClient.missionID(id)) == id, "UUID accepted")
        check((try? OathraGatewayClient.missionID("../start")) == nil, "path traversal refused")
        let canonical = try JSONDecoder().decode(OathraValue.self, from: Data(#"{"state":"ended","status":"INCOMPLETE","result":null}"#.utf8))
        check(canonical["state"].text == "ended" && canonical["status"].text == "INCOMPLETE", "ended is not completed")
        check(canonical["result"] == .null, "missing proof stays null")
        check(OathraValue.string("true").flag == false, "strings do not become true")
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FixtureProtocol.self]
        let client = try OathraGatewayClient(origin: "http://127.0.0.1:4244", token: "local-test-key", configuration: config)
        var seen: [String] = []
        FixtureProtocol.handler = { request in
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer local-test-key")
            seen.append(request.url!.path)
            return (200, "{\"id\":\"\(id)\",\"kind\":\"phone-request\",\"status\":\"DRAFT\"}")
        }
        let mission = try await client.mission(id)
        check(mission["status"].text == "DRAFT", "canonical draft")
        check(seen == ["/v1/missions/" + id], "no start requests")
        FixtureProtocol.handler = { _ in (200, "{\"id\":\"00000000-0000-0000-0000-000000000000\",\"kind\":\"phone-request\"}") }
        do { _ = try await client.mission(id); preconditionFailure("wrong id accepted") } catch OathraConnectionError.identityMismatch { checks += 1 }
        var count = 0
        FixtureProtocol.handler = { _ in count += 1; return (403, #"{"error":"read_only_account","token":"local-test-key"}"#) }
        do { _ = try await client.request("/phone/draft", method: "POST", body: .object([:])); preconditionFailure("403 accepted") }
        catch { check(!error.localizedDescription.contains("local-test-key"), "credentials redacted") }
        check(count == 1, "mutations are not retried")
        FixtureProtocol.handler = { _ in (302, #"{"error":"redirect"}"#) }
        do { _ = try await client.request("/phone/status"); preconditionFailure("redirect accepted") } catch { checks += 1 }
        FixtureProtocol.handler = { _ in (200, "not json") }
        do { _ = try await client.request("/phone/status"); preconditionFailure("invalid json accepted") } catch { checks += 1 }
        print("Oathra Foundation client: \(checks) checks passed (fixture transport; no carrier or model API)")
    }
}
