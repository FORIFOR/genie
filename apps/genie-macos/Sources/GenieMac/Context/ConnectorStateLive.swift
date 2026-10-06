import Foundation
import GenieCore

extension ConnectorState {
    static func liveDependencies() -> Dependencies {
        Dependencies(configuration: { ConnectionConfiguration.current },
            read: { source in
                let service = KeychainStore.connectorService(source.pluginId, source.connectorId)
                let value = try KeychainStore.getGeneric(service: service, account: NSUserName())
                // 以前の保存は Genie のサービスが読めず、同期のたびに macOS の確認が出ていた。一度だけ保存し直す。
                if let value { KeychainStore.shareConnectorWithService(service: service, account: NSUserName(), value: value) }
                return value
            },
            write: { try KeychainStore.setConnectorSecret(service: KeychainStore.connectorService($0.pluginId, $0.connectorId), account: NSUserName(), value: $1) },
            delete: { try KeychainStore.deleteGeneric(service: KeychainStore.connectorService($0.pluginId, $0.connectorId), account: NSUserName()) },
            list: { base, token, source in
                try await Task.detached {
                    let text = try GenieCoreBridge.pluginConnections(base, accessToken: token, pluginId: source.pluginId)
                    struct Response: Decodable { let items: [Record] }
                    return try JSONDecoder().decode(Response.self, from: Data(text.utf8)).items
                }.value
            },
            register: { base, token, source, credential in
                try ConnectionConfiguration.persistForRefresh()
                // Normalize Graph scope URLs to the manifest spelling, preserving actual grants only.
                let granted = source.scopes.filter { requested in credential.grantedScopes.contains { normalize($0) == normalize(requested) } }
                let body: [String: Any] = ["connector_id": source.connectorId,
                    "credential_ref": "keychain:\(source.pluginId)/\(source.connectorId)", "granted_scopes": granted,
                    "account_label": credential.accountLabel as Any? ?? NSNull(),
                    // Access-token expiry is not the lifetime of a renewable connection.
                    "expires_at": credential.refreshToken?.isEmpty == false ? NSNull() : (credential.expiresAt as Any? ?? NSNull())]
                let text = String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
                _ = try await Task.detached { try GenieCoreBridge.pluginConnect(base, accessToken: token, pluginId: source.pluginId, connectJson: text) }.value
            },
            remove: { base, token, source in
                try await Task.detached { try GenieCoreBridge.pluginDisconnect(base, accessToken: token, pluginId: source.pluginId, connectorId: source.connectorId) }.value
            },
            exchange: { provider, client, secret, pending, code in
                let text = await Task.detached {
                    connectorExchangeConfigured(providerId: provider, clientId: client, clientSecret: secret,
                        redirectUri: pending.redirectUri, code: code, codeVerifier: pending.verifier,
                        nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
                }.value
                guard let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                      let access = value["access_token"] as? String, !access.isEmpty else { throw URLError(.cannotParseResponse) }
                let expiry = (value["expires_at_ms"] as? Double).map { ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: $0 / 1000)) }
                return Credential(clientId: client, accessToken: access, refreshToken: value["refresh_token"] as? String,
                    expiresAt: expiry, grantedScopes: value["granted_scopes"] as? [String] ?? [], tokenType: "Bearer")
            },
            account: { provider, access in
                let endpoint = provider == "google" ? "https://www.googleapis.com/oauth2/v3/userinfo" : "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName"
                var request = URLRequest(url: URL(string: endpoint)!, timeoutInterval: 15)
                request.setValue("Bearer \(access)", forHTTPHeaderField: "Authorization")
                guard let (data, response) = try? await URLSession.shared.data(for: request),
                      (response as? HTTPURLResponse)?.statusCode == 200,
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
                return (value["email"] ?? value["mail"] ?? value["userPrincipalName"] ?? value["displayName"]) as? String
            })
    }
}
