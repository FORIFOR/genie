import Foundation

/// Numeric policy only. Native ownership, immutable geometry and authority gates
/// are checked by BackgroundAX. Values use a normalized vertical scrollbar.
enum BackgroundScroll {
    enum Rejected: String, Error {
        case unsupported = "background_scroll_unsupported"
        case boundary = "background_scroll_boundary"
    }
    struct Plan {
        let before: Double, after: Double, delta: Double, viewport: Double, range: Double
    }
    static func plan(value: Double, viewport: Double, content: Double, direction: String) throws -> Plan {
        guard [value, viewport, content].allSatisfy({ $0.isFinite }),
              value >= 0, value <= 1, viewport >= 2, viewport <= 20_000,
              content > viewport, content <= 10_000_000, ["up", "down"].contains(direction)
        else { throw Rejected.unsupported }
        let range = content - viewport
        let next = min(1, max(0, value + (direction == "down" ? 1 : -1) * viewport / 2 / range))
        let delta = (next - value) * range
        guard abs(delta) >= 0.5 else { throw Rejected.boundary }
        return Plan(before: value, after: next, delta: delta, viewport: viewport, range: range)
    }
    static func confirmed(_ plan: Plan, value: Double, documentDelta: Double) -> Bool {
        value.isFinite && documentDelta.isFinite && value >= 0 && value <= 1 &&
        abs((value - plan.after) * plan.range) <= 1 &&
        abs(documentDelta - plan.delta) <= 1 && abs(documentDelta) >= 0.5 &&
        abs(documentDelta) <= plan.viewport / 2 + 1 && documentDelta * plan.delta > 0
    }
}
