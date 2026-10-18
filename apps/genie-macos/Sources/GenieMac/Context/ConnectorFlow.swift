import AppKit
import GenieCore
import Foundation
import Network

/// System-browser PKCE with a bounded, loopback-only, single-use callback.
@MainActor
final class ConnectorFlow {
    struct Pending { let verifier: String; let state: String; let redirectUri: String; let port: UInt16 }
    enum FlowError: Error { case random, listener }
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private var timeout: Task<Void, Never>?
    private var startupTimeout: Task<Void, Never>?
    private var startup: CheckedContinuation<UInt16, Error>?
    private var generation = UUID()
    // Match the five-minute authorization window in genie-core and packages/oauth.
    private static let authorizationTimeout: Duration = .seconds(5 * 60)
    private let openAuthorizationURL: (URL) -> Bool
    private let waitForAuthorization: (Duration) async throws -> Void

    init(openAuthorizationURL: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) },
         waitForAuthorization: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.openAuthorizationURL = openAuthorizationURL
        self.waitForAuthorization = waitForAuthorization
    }

    static func randomVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 64)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return "" }
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func acceptedCallback(request: String, expectedState: String?, path: String = "/callback") -> OauthCallback? {
        guard let line = request.components(separatedBy: "\r\n").first else { return nil }
        let parts = line.split(separator: " ")
        guard parts.count == 3, parts[0] == "GET", parts[1].hasPrefix(path + "?") else { return nil }
        let target = String(parts[1])
        guard let pairs = URLComponents(string: target)?.queryItems else { return nil }
        // Reject duplicate security parameters instead of accepting last-wins parsing.
        for key in ["state", "code", "error"] {
            guard pairs.filter({ $0.name == key }).count <= 1 else { return nil }
        }
        let result = connectorParseCallback(target: target)
        guard let state = result.state, !state.isEmpty,
              expectedState.map({ $0 == state }) ?? true,
              (result.code?.isEmpty == false) != (result.error?.isEmpty == false) else { return nil }
        return result
    }

    @discardableResult
    func startLoopback(expectedState: String? = nil, path: String = "/callback", _ onCallback: @escaping (OauthCallback) -> Void) async throws -> UInt16 {
        stopLoopback()
        let attempt = generation
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: params)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated {
            guard let self, self.generation == attempt else { connection.cancel(); return }
            guard self.connections.count < 8 else { connection.cancel(); return }
            self.connections.append(connection)
            connection.start(queue: .main)
            self.receive(connection, buffer: Data(), attempt: attempt, expectedState: expectedState, path: path, onCallback: onCallback)
            }
        }
        return try await withCheckedThrowingContinuation { continuation in
            startup = continuation
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, self.generation == attempt else { return }
                    switch state {
                    case .ready:
                        guard let port = listener.port, port.rawValue > 0 else { self.stopLoopback(); return }
                        let pending = self.startup; self.startup = nil
                        self.startupTimeout?.cancel(); self.startupTimeout = nil
                        pending?.resume(returning: port.rawValue)
                    case .failed, .cancelled: self.stopLoopback()
                    default: break
                    }
                }
            }
            listener.start(queue: .main)
            startupTimeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled, let self, self.generation == attempt else { return }
                self.stopLoopback()
            }
        }
    }

    private func receive(_ connection: NWConnection, buffer: Data, attempt: UUID, expectedState: String?, path: String,
                         onCallback: @escaping (OauthCallback) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            guard let self, self.generation == attempt else { connection.cancel(); return }
            var bytes = buffer; bytes.append(data ?? Data())
            guard bytes.count <= 16384, error == nil else { self.close(connection); return }
            guard let request = String(data: bytes, encoding: .utf8), request.contains("\r\n\r\n") else {
                if complete { self.close(connection) }
                else { self.receive(connection, buffer: bytes, attempt: attempt, expectedState: expectedState, path: path, onCallback: onCallback) }
                return
            }
            let callback = Self.acceptedCallback(request: request, expectedState: expectedState, path: path)
            let message = callback == nil ? "認証を確認できません。元の同意画面から続けてください。" : "認証結果を受け取りました。Genieに戻ると接続状況を確認できます。"
            let body = "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>Genie · Connections</title><p>\(message)</p></html>"
            let response = "HTTP/1.1 \(callback == nil ? "400 Bad Request" : "200 OK")\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            self.connections.removeAll { $0 === connection }
            if let callback {
                // Invalidate immediately; a second callback cannot exchange another code.
                self.stopLoopback()
                onCallback(callback)
            }
        }
    }

    private func close(_ connection: NWConnection) {
        connection.cancel(); connections.removeAll { $0 === connection }
    }
    func stopLoopback() {
        generation = UUID(); timeout?.cancel(); timeout = nil
        startupTimeout?.cancel(); startupTimeout = nil
        let pending = startup; startup = nil; pending?.resume(throwing: FlowError.listener)
        listener?.cancel(); listener = nil
        connections.forEach { $0.cancel() }; connections.removeAll()
    }

    func begin(provider: String, clientId: String, scopes: [String],
               onTimeout: @escaping () -> Void = {},
               onCallback: @escaping (OauthCallback, Pending) -> Void) async throws -> Bool {
        guard !clientId.isEmpty else { return false }
        let verifier = Self.randomVerifier(), state = Self.randomVerifier()
        guard !verifier.isEmpty, !state.isEmpty else { throw FlowError.random }
        var pending: Pending?
        let path = provider == "microsoft" ? "/" : "/callback"
        let host = provider == "microsoft" ? "localhost" : "127.0.0.1"
        let port = try await startLoopback(expectedState: state, path: path) { callback in
            if let pending { onCallback(callback, pending) }
        }
        guard !Task.isCancelled else { stopLoopback(); return false }
        let redirect = "http://\(host):\(port)\(path)"
        pending = Pending(verifier: verifier, state: state, redirectUri: redirect, port: port)
        guard let text = GenieCoreBridge.authorizeUrl(provider: provider, clientId: clientId, redirectUri: redirect,
                scopes: scopes, state: state, codeChallenge: GenieCoreBridge.pkceChallenge(verifier)),
              let url = URL(string: text), openAuthorizationURL(url) else { stopLoopback(); return false }
        let attempt = generation
        let wait = waitForAuthorization
        timeout = Task { [weak self] in
            do { try await wait(Self.authorizationTimeout) } catch { return }
            guard !Task.isCancelled, let self, self.generation == attempt else { return }
            self.stopLoopback(); onTimeout()
        }
        return true
    }
}
