import Foundation

/// Public connection state contains no endpoint, account, token or raw server error.
enum GatewayConnectionIssue: Equatable {
    case credentialAccess, reconnect, unreachable, rateLimited, configuration

    static func classify(_ error: Error) -> Self {
        if error is KeychainStore.KeychainError { return .credentialAccess }
        if let session = error as? GatewaySession.SessionError {
            switch session {
            case .credentialAccessRequired: return .credentialAccess
            case .rateLimited: return .rateLimited
            default: break
            }
        }
        return .reconnect
    }
    var message: String {
        switch self {
        case .configuration: return DesktopConnectionBootstrap.issueMessage
        case .credentialAccess: return KeychainStore.accessMessage + "入力は残しています。"
        case .reconnect: return "接続を再確認してください。入力は残しています。"
        case .unreachable: return "接続先に届きません。入力は残しています。"
        case .rateLimited: return "少し待ってから送信してください。入力は残しています。"
        }
    }
    var diagnosticCode: String {
        switch self {
        case .configuration: return "invalid_saved_connection"
        case .credentialAccess: return "credential_access_required"
        case .reconnect: return "reconnect_required"
        case .unreachable: return "unreachable"
        case .rateLimited: return "rate_limited"
        }
    }
}
