import AppKit
import SwiftUI

/// 確認カードを実際に画面へ出す（Dock が出ていないとき）。
///
/// カードは Genie の面（`ConfirmationCardView`）で、NSAlert ではない。仕様書 §17 が
/// 求めているのは「AI が文章で聞く」でも「OS の警告」でもなく、**何が起きるかを書いた面**。
@MainActor
enum ConfirmationPresenter {
    /// 面を出す。答えは**このカードの id 付きで** store に返り（`resolveConfirmation(id:approved:)`）、
    /// 待つ側（`Confirm`）は bus で受け取る。ここでは待たない —— 以前はここで
    /// CFRunLoopRunInMode を空回しして待っていたので、人のクリックがボタンまで届かなかった。
    /// window を出せない環境（selftest / headless）では nil（＝聞けない。答えは無い）。
    static func show(_ confirmation: ActionConfirmation) -> NSPanel? {
        guard !WindowCoordinator.headless else { return nil }
        let panel = GeniePanel(
            size: NSSize(width: 320, height: 200),
            level: .modalPanel,
            canKey: true,
            content: ConfirmationCardView(confirmation: confirmation) { approved in
                GenieStateStore.shared.resolveConfirmation(id: confirmation.id, approved: approved)
            }
        )
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.midX - 160, y: f.midY - 100))
        }
        panel.makeKeyAndOrderFront(nil)
        return panel
    }
}
