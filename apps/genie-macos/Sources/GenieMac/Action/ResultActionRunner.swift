import AppKit

/// 結果面のボタンが**ラベルどおりに**することを、1 か所に置く。
///
/// 一度、「開く」も「複製」も `dismissResult()` を呼ぶだけになっていた。
/// View の中に閉じていると気づけないので、外に出して検査から同じ経路を通す。
@MainActor
enum ResultActionRunner {
    /// `taskID`: 仕事の結果なら、その仕事。コピー・再試行は**その仕事の中身**に対して行う
    /// （以前はコピーが題だけを写し、再試行は声の依頼でも会議の AI 操作を走らせていた）。
    static func run(_ action: AgentResult.Action, title: String, sessionId: String? = nil, taskID: UUID? = nil) {
        let store = GenieStateStore.shared
        let record = taskID.flatMap { id in LocalStore.shared.loadTasks().first { $0.id == id }?.requestRecord }
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
            // 押されたときだけ写す（自動でクリップボードを書き換えない）。写すのは、できた中身。
            let body: String
            if let record, !record.documentText.isEmpty { body = record.documentText }
            else if taskID != nil, store.state.activeTask?.id == taskID,
                    !RecordingWorkspaceState.shared.aiResult.isEmpty { body = RecordingWorkspaceState.shared.aiResult }
            else { body = title }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(body, forType: .string)
        case .openSettings:
            // 始められなかった理由はいまのところマイクだけ。OS の許可画面へ。
            Permissions.openMicrophoneSettings()
        case .retry:
            // 同じ入口でもう一度。声・文字の依頼は同じ依頼を送り直し、会議の AI 操作は同じ操作を走らせる。
            // 走り出せば Dock は実行中の姿になり、走り出せなければ結果面を残す。
            if let record {
                store.dismissResult()
                VoiceHUDState.shared.ask(record.request)
            } else {
                RecordingWorkspaceState.shared.runAIAction(title)
            }
            return
        }
        store.dismissResult()
    }
}
