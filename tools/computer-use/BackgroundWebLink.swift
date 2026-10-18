import Foundation
import CoreGraphics

/// Origin-only policy shared by native capture/delivery. It never trusts visible page text.
enum BackgroundDocumentOrigin {
    struct WindowCandidate { let pid: Int32, window: UInt32, zOrder: Int }
    /// Candidates must already have a verified allowed origin. Prefer the actual
    /// foreground service, then WindowServer order, never a goal/title heuristic.
    static func preferredWindow(_ candidates: [WindowCandidate], foregroundPID: Int32?) -> UInt32? {
        guard candidates.allSatisfy({ $0.pid > 0 && $0.window > 0 && $0.zOrder >= 0 }),
              Set(candidates.map(\.window)).count == candidates.count else { return nil }
        return candidates.sorted {
            let a = $0.pid == foregroundPID, b = $1.pid == foregroundPID
            if a != b { return a }
            if $0.zOrder != $1.zOrder { return $0.zOrder < $1.zOrder }
            return $0.window < $1.window
        }.first?.window
    }
    /// Picker/reuse eligibility is a read-only native check. Generic app consent
    /// keeps its existing behavior; a constrained run cannot select an unrelated
    /// app and wait until capture to discover the scope mismatch.
    static func selectionAllowed(supportedBrowser: Bool, allowed: [String]?,
                                 observeOrigin: () throws -> String?) -> Bool {
        guard let allowed else { return true }
        guard valid(allowed), supportedBrowser else { return false }
        guard let observed = try? observeOrigin() else { return false }
        return allowed.contains(observed)
    }
    static func singleDocument(_ documents: [URL?], hasEmbeddedFrame: Bool) -> String? {
        guard !hasEmbeddedFrame, documents.count == 1, let url = documents[0] else { return nil }
        return origin(url)
    }
    static func origin(_ url: URL) -> String? {
        guard url.scheme == "https", let host = url.host?.lowercased(), !host.isEmpty,
              host.range(of: #"^[a-z0-9.-]+$"#, options: .regularExpression) != nil,
              url.user == nil, url.password == nil, url.absoluteString.utf8.count <= 4096
        else { return nil }
        let port = url.port ?? 443
        guard port > 0, port <= 65535 else { return nil }
        return "https://\(host)" + (port == 443 ? "" : ":\(port)")
    }
    static func valid(_ allowed: [String]) -> Bool {
        !allowed.isEmpty && allowed.count <= 8 && Set(allowed).count == allowed.count && allowed.allSatisfy {
            guard $0.utf8.count <= 512, let url = URL(string: $0), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
            else { return false }
            return origin(url) == $0 && parts.path.isEmpty && parts.query == nil && parts.fragment == nil
        }
    }
}

enum BackgroundWindowIdentity {
    struct Candidate { let pid: Int32, window: UInt32?, bounds: CGRect? }
    /// Missing/conflicting IDs are never replaced with geometry when the native
    /// ID API exists. Geometry remains exact until a translation is proven.
    static func match(_ candidates: [Candidate], pid: Int32, window: UInt32,
                      bounds: CGRect, identityAvailable: Bool) -> Int? {
        let matches = candidates.indices.filter {
            candidates[$0].pid == pid && candidates[$0].bounds == bounds &&
                (!identityAvailable || candidates[$0].window == window)
        }
        return matches.count == 1 ? matches[0] : nil
    }
}

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
