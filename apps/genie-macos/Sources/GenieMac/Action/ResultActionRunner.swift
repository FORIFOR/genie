import AppKit

/// 結果面のボタンが**ラベルどおりに**することを、1 か所に置く。
///
/// 一度、「開く」も「複製」も `dismissResult()` を呼ぶだけになっていた。
/// View の中に閉じていると気づけないので、外に出して検査から同じ経路を通す。
@MainActor
enum ResultActionRunner {
    static func run(_ action: AgentResult.Action, title: String, sessionId: String? = nil) {
        let store = GenieStateStore.shared
        switch action {
        case .openWorkspace:
            MainWindowController.shared.showWork(.tasks)
            store.workspaceOpened()
        case .openNotes:
            MainWindowController.shared.showLibrary(.meetings)
            // 終わったばかりの会議が分かっているなら、一覧で探させずにその 1 件を開く。
            if let sessionId { MainNav.shared.openSession = sessionId }
            store.workspaceOpened()
        case .ask:
            VoiceHUDState.shared.beginConversation()
            return   // 会話の聞く面へ移るので結果面は畳まれる
        case .copy:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(title, forType: .string)
        case .openSettings:
            // 始められなかった理由はいまのところマイクだけ。OS の許可画面へ。
            Permissions.openMicrophoneSettings()
        case .retry:
            // 同じ入口（AI 操作）でもう一度。走り出せば Dock は実行中の姿になり、走り出せなければ結果面を残す。
            RecordingWorkspaceState.shared.runAIAction(title)
            return
        }
        store.dismissResult()
    }
}
