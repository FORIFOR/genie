import AppKit

/// Experimental fixture collector; NOT a product geometry gate.
/// The current SwiftUI probe fails required semantic coverage.
/// Reads only objects owned by this process. It never creates a system-wide AX
/// application or substitutes declared SwiftUI dimensions for rendered frames.
@MainActor enum OwnAccessibilityGeometry {
    struct Element: Codable {
        let identifier: String?
        let role: String?
        let label: String?
        let enabled: Bool
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    static func elements(in window: NSWindow) -> [Element] {
        var result: [Element] = []
        var visited: Set<ObjectIdentifier> = []
        let origin = window.frame
        func walk(_ object: AnyObject, depth: Int) {
            guard depth <= 32, visited.count < 10_000,
                  visited.insert(ObjectIdentifier(object)).inserted else { return }
            if let accessible = object as? NSAccessibilityProtocol {
                let frame = accessible.accessibilityFrame()
                if frame.width > 0, frame.height > 0,
                   [frame.minX, frame.minY, frame.width, frame.height].allSatisfy({ $0.isFinite }),
                   frame.intersects(origin) {
                    let role = accessible.accessibilityRole()
                    let label = (accessible.accessibilityValue() as? String) ?? accessible.accessibilityLabel()
                    result.append(Element(identifier: accessible.accessibilityIdentifier(),
                        role: role?.rawValue, label: label, enabled: accessible.isAccessibilityEnabled(),
                        x: Double(frame.minX - origin.minX), y: Double(origin.maxY - frame.maxY),
                        width: Double(frame.width), height: Double(frame.height)))
                }
                for child in accessible.accessibilityChildren() ?? [] { walk(child as AnyObject, depth: depth + 1) }
            }
            // Some hosting wrappers omit their child view from the accessibility
            // list, while that view still vends its real SwiftUI elements.
            if let view = object as? NSView {
                for child in view.subviews { walk(child, depth: depth + 1) }
            }
        }
        walk(window, depth: 0)
        if let content = window.contentView { walk(content, depth: 0) }
        return result
    }
}
