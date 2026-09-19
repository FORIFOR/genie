import AppKit
import Foundation
import SwiftUI

// 仕様書 §5 / §15 / §16 / §21 / §25 のデータモデル。
// ここは**モデルだけ**。engine は各 Module が持ち、状態は GenieStateStore が一箇所で持つ。

/// §5 Genie の唯一の活動状態。UI ごとに勝手な mode を作らない。
enum GenieMode: String, Equatable {
    case idle, listening, transcribing, thinking, acting
    case awaitingConfirmation, completed, failed
    case meeting, workspace
}

/// Task Dock が何を見せているか。`GenieMode` は「何が起きているか」、こちらは「何を出しているか」。
///
/// Genie は **窓を増やさない**。一枚の Dock が状態に応じて大きさと役割を変える。
/// 寸法もここから引く（View 側で分岐して数字を書かない）。
enum DockPresentation: Equatable {
    /// 常駐。名前も出さない、いちばん静かな姿。
    case idle
    /// 前面アプリを認識した。巨大な popup は出さず、Presence が静かに変わるだけ。
    case appContext(AppContextSummary)
    /// 上を押して開いた状態。そのアプリで頼めることを出す。
    case appContextExpanded(AppContextSummary)
    /// 声を聞いている。主役は波形ではなく**話した内容**。
    case listening(partial: String)
    case thinking
    /// Agent 実行中。仕事の進行そのものを段で出す。
    case agent
    /// 取り返しのつかない操作の確認。Dock 自体が下へ伸びて聞く（別窓も NSAlert も使わない）。
    case confirmation(ActionConfirmation)
    /// 会議中。既定は 1 行。必要なものだけ開く。
    case meeting(expanded: MeetingPanel?)
    /// すぐ返せる短い回答。Task Dock の中で確認でき、作業画面へ遷移しない。
    case answer(String)
    /// 仕事が終わった直後。消して終わらせず、後始末だけ出して残す（CleanShot の Quick Access）。
    case result(AgentResult)
    /// 文脈の棚を開いた状態（Dropover: 棚そのものが詳細へ展開する）。
    case contextDetail
    /// 旧 Quick Actions（Dock を押したとき）。
    case quickActions
    /// 録音へ移る途中。
    case enteringRecording

    /// 録音中に開ける面。**録音開始では 1 つも開かない**（controller だけ）。
    /// 押されたものだけが、同じ面の中身として入れ替わる。
    enum MeetingPanel: String, Equatable, CaseIterable {
        case notes, captions, ask
        var title: String {
            switch self {
            case .notes: return Facts.meetingNotes
            case .captions: return "字幕"
            case .ask: return "Ask Genie"
            }
        }
        var icon: String {
            switch self {
            case .notes: return "doc.text"
            case .captions: return "text.viewfinder"
            case .ask: return "sparkles"
            }
        }
    }

    /// この状態での Dock の大きさ。**top anchor は固定**なので、変わるのは幅と高さだけ。
    ///
    /// 幅は状態ごとの token。高さは **中身を描いて測る**（`DockContentMeasure`）。
    /// 固定値や式で持つと、中身より短ければ角が切れ、長ければ穴が出る。
    /// 固定なのは Dynamic Island そのもの（idle / 畳んだ棚）と、
    /// 生きて増える文字起こしを scroll で見せる会議の字幕面だけ。token の高さは
    /// 測れなかったときの fallback として残す。
    @MainActor func size(agentRows: Int = 0) -> CGSize {
        func measured(_ w: CGFloat, fallback: CGFloat) -> CGSize {
            CGSize(width: w, height: DockContentMeasure.height(of: self, width: w) ?? fallback)
        }
        switch self {
        case .idle:
            // スクショを認識した一瞬（〜1 秒）と、そのあとの chip は、文脈 chip と同じ幅（窓は増やさない）。
            if VisualContextStore.shared.offeredCapture != nil {
                return CGSize(width: Metrics.dockContextWidth, height: Metrics.dockContextHeight)
            }
            return CGSize(width: Metrics.dockIdleWidth, height: Metrics.dockIdleHeight)
        case .appContext:
            return CGSize(width: Metrics.dockContextWidth, height: Metrics.dockContextHeight)
        case .appContextExpanded(let summary):
            return measured(Metrics.dockContextExpandedWidth,
                            fallback: Metrics.dockContextExpandedBase
                                + CGFloat(summary.suggestions.count) * Metrics.dockAgentRowHeight)
        case .listening:
            return measured(Metrics.dockListeningWidth, fallback: Metrics.dockListeningHeight)
        case .thinking, .enteringRecording, .quickActions:
            return measured(Metrics.dockThinkingWidth, fallback: Metrics.dockThinkingHeight)
        case .agent:
            // 内容に応じて**下へ**伸びる。幅は変えない。
            return measured(Metrics.dockAgentWidth,
                            fallback: Metrics.dockAgentHeightBase + CGFloat(agentRows) * Metrics.dockAgentRowHeight)
        case .confirmation:
            // 中身で決まる。固定だと 2 行の確認でも面の半分が空き、
            // 押してほしいボタンが遠くに離れて置かれていた。
            // **上限を置く。** 決断のための面が作業面ほど大きくなると、
            // 何を決めるのかが薄まる（外の製品に負けた理由がこれ）。
            let s = measured(Metrics.dockConfirmWidth, fallback: Metrics.dockConfirmHeight)
            return CGSize(width: s.width, height: min(360, s.height))
        case .meeting(let panel):
            guard panel != nil else {
                return CGSize(width: Metrics.dockMeetingWidth, height: Metrics.dockMeetingHeight)
            }
            // ライブメモは中身で決まり、字幕は固定（`DockContentMeasure` が nil を返す）。
            // どちらも token の高さを **上限** にする。決断の面と同じ理由 —— 会議中の
            // 補助面が作業面ほど大きくなると、会議そのものより目立つ。
            let s = measured(Metrics.dockMeetingWidth, fallback: Metrics.dockMeetingExpandedHeight)
            return CGSize(width: s.width, height: min(Metrics.dockMeetingExpandedHeight, s.height))
        case .answer:
            // 短い回答は結果面と同じ幅で測る。長い回答も Dock 内でスクロールできる。
            return measured(Metrics.dockResultWidth, fallback: Metrics.dockResultHeight)
        case .result:
            return measured(Metrics.dockResultWidth, fallback: Metrics.dockResultHeight)
        case .contextDetail:
            return measured(Metrics.dockContextExpandedWidth, fallback: Metrics.dockContextExpandedBase + 180)
        }
    }
}

/// 終わった仕事。「✓ できました」で消さず、次にやることを出したまま少し残す。
struct AgentResult: Equatable {
    let title: String
    /// 後始末。**実際にできることだけ**を挙げる。
    /// ラベルだけ出して何も起きないボタンは置かない（実機で一度そうなっていた）。
    let actions: [Action]
    /// 何を読んで作ったか。「できました」だけでは、根拠の有無が読めない。
    /// 仕事の結果なら読んだ source の数、会議の結果なら nil（Session の状態を出す）。
    var sourceCount: Int? = nil
    /// 会議の結果なら、その会議。「メモを開く」は一覧ではなく**この 1 件**を開く。
    var sessionId: String? = nil
    /// 2 行目に出す説明。無ければ Session の状態（会議）か件数（仕事）を出す。
    /// 始められなかった理由はここに書く（「何ができないか」を先に）。
    var detail: String? = nil
    /// できなかった結果。印を ✓ にしない。
    var failed: Bool = false

    enum Action: String, Equatable {
        case openWorkspace, openNotes, ask, copy, openSettings, retry

        var title: String {
            switch self {
            case .openWorkspace: return Facts.resultOpen
            case .openNotes: return "\(Facts.meetingNotes)を開く"
            case .ask: return "Ask Genie"
            case .copy: return Facts.resultCopy
            case .openSettings: return Facts.resultOpenSettings
            case .retry: return Facts.resultRetry
            }
        }
    }
}

/// 前面アプリの要約。Presence に出すのはこの 1 行だけ。
struct AppContextSummary: Equatable {
    let app: String
    /// 開いている書類（Notion のページ名など）。無ければ nil。
    let document: String?
    /// そのアプリで頼めること。空なら展開しても意味がないので開かせない。
    let suggestions: [String]

    static let none = AppContextSummary(app: "", document: nil, suggestions: [])
}

// MARK: - §7 / §25 Context

/// §7 情報源。数字が小さいほど信頼できる（Browser DOM > AX > ... > OCR）。
enum ContextSourceKind: Int, Comparable, CaseIterable {
    case browserDOM = 1
    case accessibility = 2
    case nativeApp = 3
    case screenVision = 4
    case ocr = 5

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    var label: String {
        switch self {
        case .browserDOM: return "ブラウザ"
        case .accessibility: return "画面の要素"
        case .nativeApp: return "アプリ連携"
        case .screenVision: return "画面"
        case .ocr: return "文字認識"
        }
    }
}

/// §25 その情報がどれくらい機微か。UI に必ず出す。
enum ContextSensitivity: String {
    case public_ = "public"
    case workspace
    case personal
    case secret
}

/// §7 / §25 AI へ渡す文脈の 1 件（`ContextLensView` の表示用 ContextFact とは別物）。**出所を必ず持つ**。持たない文脈は作らない。
struct ContextFact: Identifiable, Equatable {
    let id = UUID()
    let source: ContextSourceKind
    let application: String
    let sensitivity: ContextSensitivity
    let summary: String
    /// 取り込んだ時刻と有効期限。古い文脈を黙って使い続けない。
    let capturedAt: Date
    let expiresAt: Date

    func isFresh(_ now: Date = Date()) -> Bool { now < expiresAt }
}

/// 束ねたもの。同じことを別の source が言っている場合は**優先度の高い方だけ**残す。
struct ContextBundle: Equatable {
    var items: [ContextFact] = []

    /// UI に出す「AI がいま見ているもの」。
    var visibleSources: [String] { items.map { "\($0.application) · \($0.source.label)" } }

    static func resolved(_ raw: [ContextFact], now: Date = Date()) -> ContextBundle {
        // 期限切れは捨てる。同じ application は最も信頼できる source を 1 件だけ残す。
        var best: [String: ContextFact] = [:]
        for item in raw where item.isFresh(now) {
            if let existing = best[item.application], existing.source <= item.source { continue }
            best[item.application] = item
        }
        return ContextBundle(items: best.values.sorted { $0.source < $1.source })
    }
}

// MARK: - §15 Agent

/// 進行状態。`GenieCore.TaskStatus` とは別物なので名前を分ける。
enum AgentRunState: String, Equatable { case pending, running, success, failed }

struct AgentStep: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let tool: String
    /// その段で**実際に何を見て / 何をしたか**。空欄にしない方が、待っている間の不安が減る。
    var detail: String = ""
    var state: AgentRunState = .pending
}

struct AgentTask: Identifiable, Equatable {
    var requestRecord: TaskRequestRecord? = nil
    /// 進み具合（0–1）。段の状態から出す。持たせると必ずずれるので、計算にする。
    var progress: Double {
        guard !steps.isEmpty else { return 0 }
        let done = steps.filter { $0.state == .success }.count
        let running = requestRecord?.backendKind == "execution.run" ? 0 : (steps.contains { $0.state == .running } ? 0.5 : 0)
        return min(1, (Double(done) + running) / Double(steps.count))
    }

    let id: UUID
    let title: String
    var status: AgentRunState
    var steps: [AgentStep]

    /// できなかったとき、どこで止まったか。「黙って消えない」ための 1 文。
    var failureReason: String? {
        guard status == .failed else { return nil }
        guard let step = steps.first(where: { $0.state == .failed }) else { return "途中で止まりました" }
        return step.detail.isEmpty ? "「\(step.title)」で止まりました" : "「\(step.title)」で止まりました · \(step.detail)"
    }
    var startedAt: Date
    var context: ContextBundle
}

// MARK: - §16 / §17 Action risk

/// §16 全 Action は 4 段階。**確認の要否はここだけで決める**（呼び出し側の気分で変えない）。
enum ActionRiskLevel: Int, Comparable {
    case r0 = 0   // 読むだけ
    case r1 = 1   // ローカルかつ可逆
    case r2 = 2   // 外部への副作用
    case r3 = 3   // 重大・不可逆

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    /// 確認カードを出すか。R0/R1 は出さない（毎回聞くと、聞くこと自体が無意味になる）。
    var needsConfirmation: Bool { self >= .r2 }

    var label: String {
        switch self {
        case .r0: return "読み取りのみ"
        case .r1: return "この Mac の中 · 取り消せる"
        case .r2: return "外部に出る"
        case .r3: return "元に戻せない"
        }
    }
}

/// §17 確認は AI の文章で聞かない。カードに出す。
/// 実行の前に見せる面。**その決断に要るものだけ**を持つ。
///
/// 順番を変えられるようにしない。上から
///   ① どのアプリ / どこへ  ② 何が起きるか  ③ 決定的な値
///   ④ 中身の下見  ⑤ 出所  ⑥ 取消 / 直す / 実行
/// 一番上で何が起きるか分かり、一番下でやる／やめる／直すが分かる。
///
/// 面の型としての比較で、外の製品に負けていた。理由は造形ではなく、
/// **宛先も中身も出所も持っていなかった**こと。
struct ActionConfirmation: Identifiable, Equatable {
    /// 決定的な値の 1 行（宛先・件名・日時など）。
    struct Param: Equatable, Hashable {
        let label: String
        var value: String
        /// その場で直せるか。直せない値（送信元など）は false。
        var editable: Bool = true
    }
    /// 出所。**AI が作ったものなら、どこから来たかを持つ。**
    struct Source: Equatable {
        let title: String
        let speaker: String?
        let time: String?
    }

    let id = UUID()
    /// ① どのアプリ / どこへ。「Gmail」「Calendar」「#product-team」。
    var app: String?
    var appIcon: String?
    /// ② 「何が起きるか」を結果の文で書く。「よろしいですか」とは書かない。
    let title: String
    /// ③ 決定的な値。
    var params: [Param] = []
    /// ④ 中身の下見。長ければここだけ流す。
    var preview: String?
    /// ⑤ 出所。
    var source: Source?
    let details: [String]
    let risk: ActionRiskLevel
    /// ボタンの文字も結果を書く（「送信する」「3件削除する」）。
    let confirmLabel: String

    /// 面の高さは中身で決まる。**固定しない。** 描いて測る（`DockContentMeasure`）。
    /// ここには式を持たない —— 式と view がずれると、必ずどちらかが余るか切れる。

    /// 折り返しを含めた高さ。
    private static func box(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
                            width: CGFloat, lineSpacing: CGFloat = 0) -> CGFloat {
        let para = NSMutableParagraphStyle()
        para.lineSpacing = lineSpacing
        return ceil((text as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: NSFont.systemFont(ofSize: size, weight: weight),
                         .paragraphStyle: para]).height)
    }

    /// 下見の高さ。**中身で決まる。**
    ///
    /// `ScrollView` は差し出された高さを全部取る。`.frame(maxHeight: 66)` は
    /// 上限であると同時に**下限**として働いていた。1 行の下見でも 66pt を占め、
    /// さらに `contentRows` が別に 2 行ぶんを予約していたので、
    /// 本文と出所の間に穴が空いた（`docs/ux-benchmark/auto/CRAFT.md` ③、実測 40pt）。
    func previewHeight(width: CGFloat = ActionConfirmation.contentWidth) -> CGFloat {
        guard let preview, !preview.isEmpty else { return 0 }
        // 長ければ**そこだけ**流す。面ごと大きくしない。
        return min(66, Self.box(preview, size: Metrics.dockRowSize, width: width, lineSpacing: 3))
    }

    /// 下見が 66pt に収まりきらないか。収まるなら `ScrollView` を置かない。
    var previewOverflows: Bool {
        guard let preview, !preview.isEmpty else { return false }
        return Self.box(preview, size: Metrics.dockRowSize,
                        width: Self.contentWidth, lineSpacing: 3) > 66
    }

    /// 中身が使える幅。左右の余白を引いたもの。
    static var contentWidth: CGFloat { Metrics.dockConfirmWidth - Metrics.dockPadH * 2 }

    /// 造形⑨ 図形の重さ。**役割の順に重くする。**
    ///
    /// ```text
    /// 説明する図形   <  押せる図形  <  状態が重い図形
    /// # どのアプリか    › 出所へ       ↗ 外部に出る
    /// regular 11pt      semibold 8pt   bold 10pt
    /// ```
    ///
    /// 直す前は medium < semibold = semibold で、**押せるものと危ないものが
    /// 同じ重さ**だった。採点者の 1 人が画素の明るさで測っている:
    ///
    /// ```text
    /// 直す前   # 20488  ≈  ↗ 20432   （0.3% 差。飾りと警告が同じ重さ）
    /// 直した後 ↗ 23531  >  # 17633   （33% 差）
    /// ```
    ///
    /// 3 人中 2 人はこの差を見分けられなかった（cannot tell）。それでも採るのは、
    /// **直す前の並びが間違っていた**から。飾りの `#` と「外部に出る」が
    /// 同じ重さなのは、見えるか見えないかとは別の話。
    enum Glyph {
        /// 説明する図形。いちばん軽い。
        static let infoWeight: Font.Weight = .regular
        /// 状態が重い図形。いちばん重い。
        static let criticalWeight: Font.Weight = .bold
        static let criticalSize: CGFloat = 10
    }

}

// MARK: - §18 / §21 Meeting

struct MeetingState: Equatable {
    var meetingId: String?
    /// 会議アプリを検出しただけ。**検出は録音開始ではない**（§18）。
    var detectedApp: String?
    var isRecording: Bool = false
    var canvas: MeetingCanvas = MeetingCanvas()
}

/// §21 Markdown ではなく構造データ。UI はここから描く。
/// Canvas に並ぶ 1 行。
///
/// 中身は発言そのもの（`MeetingIntelligence` は言い換えず、拾って分類するだけ）。
/// だから出典は「いつ・誰が」で足りる。以前は `[String]` で、抽出に渡す時点で
/// 話者と時刻を捨てていたので、「決まったこと」から発言に戻れなかった
/// —— 会議詳細の方には引用番号があるのに、AI が拾った側にだけ出所が無かった。
///
/// 文字列リテラルからも作れるようにして、既存の `["…"]` の書き方を壊さない。
struct CanvasItem: Equatable, Identifiable, ExpressibleByStringLiteral {
    let id = UUID()
    let text: String
    /// 会議開始からの秒数。
    var at: TimeInterval?
    var speaker: String?

    init(_ text: String, at: TimeInterval? = nil, speaker: String? = nil) {
        self.text = text; self.at = at; self.speaker = speaker
    }
    init(stringLiteral value: String) { self.init(value) }

    static func == (a: CanvasItem, b: CanvasItem) -> Bool {
        a.text == b.text && a.at == b.at && a.speaker == b.speaker
    }

    /// 「04:21」。時刻が無ければ nil。
    var timeLabel: String? {
        guard let at else { return nil }
        let t = Int(max(0, at))
        return String(format: "%02d:%02d", t / 60, t % 60)
    }

    func contains(_ s: String) -> Bool { text.contains(s) }
}

struct MeetingCanvas: Equatable {
    var decisions: [CanvasItem] = []
    var actions: [CanvasItem] = []
    var questions: [CanvasItem] = []
    var concerns: [CanvasItem] = []
    var notes: [CanvasItem] = []

    var isEmpty: Bool {
        decisions.isEmpty && actions.isEmpty && questions.isEmpty && concerns.isEmpty && notes.isEmpty
    }
}

// MARK: - §5 全体

struct GenieState: Equatable {
    var mode: GenieMode = .idle
    var dock: DockPresentation = .idle
    var context = ContextBundle()
    var activeTask: AgentTask?
    var meeting = MeetingState()
    var confirmation: ActionConfirmation?
}
