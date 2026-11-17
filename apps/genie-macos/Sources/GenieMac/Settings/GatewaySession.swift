import Foundation
import GenieCore

/// One refresh chain per gateway and desktop identity; access tokens stay in memory.
/// A single in-flight task prevents rotating the same refresh token concurrently.
actor GatewaySession {
    struct Credentials: Codable, Sendable {
        let refreshToken: String
        let deviceToken: String
        var pending: Bool? = nil
    }
    enum SessionError: Error { case renewalUncertain, rateLimited, invalidResponse, credentialAccessRequired }
    typealias Exchange = (String) async throws -> Tokens
    private let read: () throws -> Credentials?
    private let readAfterUserRequest: (@Sendable () throws -> Credentials?)?
    private let save: (Credentials) throws -> Void
    private let signIn: () async throws -> Tokens
    private let exchange: Exchange
    private let now: () -> Date
    private let acquireLock: (() async throws -> Int32)?
    private var cached: Tokens?
    private var expiresAt = Date.distantPast
    private var inFlight: Task<Tokens, Error>?
    private var credentialReadInFlight: Task<Bool, Error>?
    private var failure: Error?
    private var retryAt = Date.distantPast
    private struct IssuedCredentialsNotSaved: Error { let underlying: Error }

    init(read: @escaping () throws -> Credentials?, save: @escaping (Credentials) throws -> Void,
         signIn: @escaping () async throws -> Tokens, exchange: @escaping Exchange,
         now: @escaping () -> Date = Date.init, acquireLock: (() async throws -> Int32)? = nil,
         readAfterUserRequest: (@Sendable () throws -> Credentials?)? = nil) {
        self.read = read; self.save = save; self.signIn = signIn; self.exchange = exchange; self.now = now
        self.acquireLock = acquireLock
        self.readAfterUserRequest = readAfterUserRequest
    }

    static func desktop(base: String, identity: String, now: @escaping () -> Date = Date.init) -> GatewaySession {
        let key = "astra.gateway.session.\(base).\(identity)"
        return GatewaySession(read: {
            do {
                guard let value = try KeychainStore.get(key) else { return nil }
                return try JSONDecoder().decode(Credentials.self, from: Data(value.utf8))
            } catch { GenieLog.write("connection", "session read failed for \(key): \(error)"); throw error }
        }, save: { credentials in
            do { try KeychainStore.set(key, String(decoding: JSONEncoder().encode(credentials), as: UTF8.self)) }
            catch { GenieLog.write("connection", "session save failed: \(error)"); throw error }
        }, signIn: {
            try await Task.detached {
                try GenieCoreBridge.devSignIn(base, email: "main-\(identity)@astra.local", displayName: "Genie")
            }.value
        }, exchange: { refresh in
            guard let url = URL(string: base + "/v1/auth/refresh"),
                  url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? ""))
            else { throw SessionError.invalidResponse }
            var request = URLRequest(url: url, timeoutInterval: 15)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": refresh])
            let session = URLSession(configuration: .ephemeral, delegate: NoCredentialRedirect(), delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw SessionError.invalidResponse }
            if response.statusCode == 429 { throw SessionError.rateLimited }
            guard response.statusCode == 200 else { throw SessionError.renewalUncertain }
            struct Reply: Decodable {
                let access_token: String; let refresh_token: String; let device_token: String; let expires_in: Int64
            }
            let result = try JSONDecoder().decode(Reply.self, from: data)
            guard !result.access_token.isEmpty, !result.refresh_token.isEmpty, result.expires_in > 0 else { throw SessionError.invalidResponse }
            return Tokens(accessToken: result.access_token, refreshToken: result.refresh_token,
                          deviceToken: result.device_token, expiresIn: result.expires_in)
        }, now: now, acquireLock: { try await SessionFileLock.acquire(key) }, readAfterUserRequest: {
            guard let value = try KeychainStore.readGatewaySessionAfterUserRequest(account: key) else { return nil }
            return try JSONDecoder().decode(Credentials.self, from: Data(value.utf8))
        })
    }

    /// Read only the existing item after a person presses Home's recovery button.
    /// No token is returned, cached, refreshed, saved or replaced by this operation.
    func confirmCredentialReadAfterUserRequest() async throws -> Bool {
        if let credentialReadInFlight { return try await credentialReadInFlight.value }
        guard inFlight == nil, let readAfterUserRequest else { throw KeychainStore.KeychainError.operationInProgress }
        let work = Task.detached {
            guard let credentials = try readAfterUserRequest() else { return false }
            guard !credentials.refreshToken.isEmpty, !credentials.deviceToken.isEmpty else { throw SessionError.invalidResponse }
            return true
        }
        credentialReadInFlight = work
        defer { credentialReadInFlight = nil }
        return try await work.value
    }

    /// Only an explicit reconnect may abandon an uncertain refresh chain.
    /// Obtain replacement credentials before replacing the saved session.
    func tokens(reauthenticate: Bool = false) async throws -> Tokens {
        guard credentialReadInFlight == nil else { throw KeychainStore.KeychainError.operationInProgress }
        if !reauthenticate, let failure { throw failure }
        if let inFlight { return try await inFlight.value }
        // Leave time for the longest foreground poll; wake also calls this method.
        if !reauthenticate, let cached, expiresAt.timeIntervalSince(now()) > 180 { return cached }
        guard now() >= retryAt else { throw SessionError.rateLimited }
        let work = Task<Tokens, Error> { [read, save, signIn, exchange, acquireLock] in
            let descriptor = try await acquireLock?()
            defer { if let descriptor { SessionFileLock.release(descriptor) } }
            // Even explicit reconnect must first establish access to the existing
            // store. A denied read is never interpreted as a missing session.
            let stored = try read()
            let credentials = reauthenticate ? nil : stored
            let tokens: Tokens
            if var credentials {
                guard credentials.pending != true else { throw SessionError.renewalUncertain }
                credentials.pending = true
                try save(credentials)
                do { tokens = try await exchange(credentials.refreshToken) }
                catch SessionError.rateLimited {
                    credentials.pending = false
                    try save(credentials)
                    throw SessionError.rateLimited
                }
            }
            else { tokens = try await signIn() }
            do { try save(Credentials(refreshToken: tokens.refreshToken, deviceToken: tokens.deviceToken)) }
            catch { throw IssuedCredentialsNotSaved(underlying: error) }
            return tokens
        }
        inFlight = work
        defer { inFlight = nil }
        do {
            let tokens = try await work.value
            failure = nil
            cached = tokens; expiresAt = now().addingTimeInterval(TimeInterval(tokens.expiresIn))
            return tokens
        } catch let error as IssuedCredentialsNotSaved {
            // The server has already issued a chain. A missing local item after a
            // failed first save must never cause repeated automatic sign-ins.
            failure = SessionError.renewalUncertain
            GenieLog.write("connection", "issued credentials not saved: \(error.underlying)")
            if error.underlying is KeychainStore.KeychainError { throw SessionError.credentialAccessRequired }
            throw SessionError.renewalUncertain
        } catch let keychain as KeychainStore.KeychainError {
            // No refresh was replayed or alternate identity created. The user may
            // resolve access in Keychain and retry this same stored session.
            GenieLog.write("connection", "keychain: \(keychain) (reauthenticate: \(reauthenticate))")
            throw SessionError.credentialAccessRequired
        } catch SessionError.rateLimited {
            retryAt = now().addingTimeInterval(60)
            throw SessionError.rateLimited
        } catch {
            // A lost refresh response may already have rotated the server token. Replaying
            // it would revoke the family. Do not silently create a different device either.
            failure = SessionError.renewalUncertain
            throw SessionError.renewalUncertain
        }
    }
}

private final class NoCredentialRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
