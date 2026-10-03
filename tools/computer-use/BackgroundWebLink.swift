import Foundation

/// This is a narrow navigation route, not a general web action or permission to
/// follow a different destination after an uncertain click.
enum BackgroundWebLink {
    static func enabled(bundle: String) -> Bool {
        if bundle == "com.apple.Safari" { return true }
        #if GENIE_BACKGROUND_TEST
        if bundle == "org.genie.background.webfixture" { return true }
        #endif
        return false
    }
    static func eligible(document: URL, destination: URL) -> Bool {
        func origin(_ url: URL) -> String? {
            guard let scheme=url.scheme?.lowercased(), ["http","https"].contains(scheme),
                  let host=url.host?.lowercased(), !host.isEmpty,
                  url.user == nil, url.password == nil,
                  url.absoluteString.utf8.count <= 4096 else { return nil }
            let port=url.port ?? (scheme == "https" ? 443 : 80)
            guard port > 0, port <= 65535 else { return nil }
            return "\(scheme)://\(host):\(port)"
        }
        guard let source=origin(document), let target=origin(destination) else { return false }
        return source == target && document.absoluteString != destination.absoluteString
    }
}
