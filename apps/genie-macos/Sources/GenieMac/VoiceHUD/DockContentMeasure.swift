import AppKit
import SwiftUI

/// 中身で高さが決まる Dock の状態は、**推定せず、描いて測る。**
///
/// ③ で入れた `surfaceHeight`（view が積むものを式で足す）は 14pt 短く、
/// agent の `base + 段数 × 行高` は 3 段で 31pt 長く、5 段で 25pt 短かった。
/// 式が短いと ZStack の地が中身の大きさまで伸びて窓からはみ出し、角丸が
/// 窓の縁で切られて**四角い黒い板**になる。式が長いと余りが Spacer に吸われて
/// 出所とボタンの間に穴が出る。式と view は必ずずれる。だから式を持たない。
///
/// **Dock の面の高さの規則は 1 つ**: 中身の実寸 + 上下の inset（view 自身の padding）。
/// 固定寸法と上限の例外は 3 つだけ ——
/// - `.meeting(expanded: .captions)`: 生きて増える文字起こしを scroll で見せる **固定**の高さ
///   （`.notes` は測る。**上限 460** に当たってからだけ scroll。`.ask` の答えは
///   `RecordingWorkspaceState` にあって鍵に入らないので、いまは固定のまま）
/// - `.confirmation`: 決断の面が作業面ほど大きくならないよう **上限 360**
/// - `.idle` / `.appContext`（畳んだ棚）: Dynamic Island の寸法そのもの（token）
///
/// `.answer` / `.card` / `.result` は中身を測る（短い回答も結果面と同じ幅で、長文は面内でスクロール）。
///
/// 測るのは `NSHostingView.fittingSize`。実際に窓へ載せる view と同じ型・同じ幅・
/// 同じ environment（dark / UIScale）で測るので、窓の中でだけ違う高さになることはない。
enum DockContentMeasure {
    private static var cache: (key: Key, height: CGFloat)?
    static func invalidate() { cache = nil }

    /// 中身が変わったら測り直す。`GenieState` 全体を鍵にする —— 文脈の棚（listening の
    /// ContextStrip / contextDetail の格子）や結果の行は `dock` の外にあるため。
    private struct Key: Equatable {
        let dock: DockPresentation
        let state: GenieState
        /// 考え中の面に出す「未送信」の行。Store の外（VoiceHUDState）にあるので鍵に入れる。
        let held: String?
        /// 会話の 1 行（ConversationBar）が出ているか・終わり際か・延長できるか。
        let conversation: [Bool]
        /// 音声入力の結果の行（どこへ入れたか・戻せるか）。
        let dictation: String?
        let width: CGFloat
        let type: CGFloat
        let metric: CGFloat
    }

    /// `nil` = この状態は固定寸法（token）で決める。
    @MainActor
    static func height(of dock: DockPresentation, width: CGFloat) -> CGFloat? {
        let body: AnyView
        switch dock {
        case .appContextExpanded(let summary): body = AnyView(AppContextDock(summary: summary, expanded: true))
        case .listening(let partial): body = AnyView(ListeningDock(partial: partial))
        case .thinking: body = AnyView(ThinkingDock())
        case .agent: body = AnyView(AgentDock())
        case .confirmation(let c): body = AnyView(ConfirmationDock(confirmation: c))
        case .result(let r): body = AnyView(ResultDock(result: r))
        case .answer(let text): body = AnyView(AnswerDock(text: text))
        case .card(let card): body = AnyView(DockCardView(card: card))
        case .contextDetail: body = AnyView(ContextDetailDock())
        case .quickActions: body = AnyView(QuickActionsDock())
        case .ack(let ack): body = AnyView(AckDock(ack: ack))
        case .dictated(let notice): body = AnyView(DictatedDock(notice: notice))
        case .enteringRecording: body = AnyView(SimpleDock(icon: "record.circle", text: "録音を始めます…", tint: .recordingRed))
        case .meeting(let panel) where panel == .notes: body = AnyView(MeetingDock(open: panel))
        case .idle, .appContext, .meeting: return nil
        }
        let key = Key(dock: dock, state: GenieStateStore.shared.state,
                      held: VoiceHUDState.shared.heldUtterance,
                      conversation: [VoiceHUDState.shared.conversation.isActive,
                                     VoiceHUDState.shared.conversationEnding,
                                     VoiceHUDState.shared.conversation.canExtend],
                      dictation: VoiceHUDState.shared.listenPurpose == .dictation
                        ? (VoiceHUDState.shared.dictationStatus ?? "") + (VoiceHUDState.shared.lastDictated == nil ? "" : "·戻す")
                        : nil,
                      width: width,
                      type: UIScale.shared.size.type, metric: UIScale.shared.size.metric)
        if let cache, cache.key == key { return cache.height }
        let host = NSHostingView(rootView: body.frame(width: width).environment(\.colorScheme, .dark))
        let h = host.fittingSize.height.rounded(.up)
        cache = (key, h)
        return h
    }
}
