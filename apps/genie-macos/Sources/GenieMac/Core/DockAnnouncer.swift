import AppKit

/// 面が変わったことを VoiceOver に言う（状態を動きや色だけで伝えない）。
///
/// 言うのは、本人が知るべき変わり目だけ: 受付・受け付けられない・結果・作業中になった・確認。
/// 聞く面・考え中・待機では言わない（毎回の読み上げはうるさい。聞く面は本人が始めたもの）。
enum DockAnnouncer {
    /// 言う文（純関数）。言わない面は nil。
    static func text(for dock: DockPresentation, previous: DockPresentation, activeCount: Int) -> String? {
        switch dock {
        case .ack(let ack):
            return ack.rejected.map { "\(Facts.taskRejected)。\($0)" } ?? "\(Facts.taskAccepted)。\(ack.title)"
        case .result(let r):
            let head = r.cancelled ? "止めました" : (r.failed ? "できませんでした" : "\(r.kind ?? "成果物")ができました")
            return "\(head)。\(r.title)"
        case .agent:
            if case .agent = previous { return nil }
            return Facts.dockRunningLabel(max(activeCount, 1))
        case .confirmation(let c):
            return "\(Facts.confirmationNeeded)。\(c.title)"
        default:
            return nil
        }
    }

    @MainActor static func announce(_ dock: DockPresentation, previous: DockPresentation, activeCount: Int) {
        guard let text = text(for: dock, previous: previous, activeCount: activeCount) else { return }
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: text,
                                        .priority: NSAccessibilityPriorityLevel.medium.rawValue])
    }
}
