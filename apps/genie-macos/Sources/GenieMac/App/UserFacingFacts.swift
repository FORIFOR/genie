import SwiftUI

/// 利用者に見せる語の正本。画面（SwiftUI / NSMenu）と説明書（`docs/guide/build.py`）が
/// **同じ定義**を読む。
///
/// 0.1.1 の説明書は「音声入力 … 長押し」のまま出た（アプリは出荷の数時間前に
/// 「録音を開始 / 停止」へ変わっていた）。UI が変わったのに説明書だけ古い、を
/// 人の注意で防ぐのはやめる。`--selftest facts` が `FACT\t<key>\t<value>\t<protected>` を
/// 書き出し、`scripts/verify-guide-facts.sh` が説明書側の `fact("key")` と突き合わせる。
///
/// 入れるのは**押せる語・見出し・許可名・鍵**だけ。文の途中の説明（prose）は入れない。
/// key は表示文字列と別に安定させる（`confirmation.cancel` は ja=やめる、あとで en=Cancel）。
/// `protected` の語は build.py に文字で書くと落ちる（必ず `fact()` で引く）。
///
/// 値は全て literal で、OS の言語・時刻・設定に依らない（`NSLocalizedString` は使っていない）。
enum UserFacingFacts {
    static let locale = "ja-JP"

    struct Fact { let key: String; let value: String; let protected: Bool }

    // MARK: 操作ラベル

    static let recordingStart = "録音を始める"
    static let recordingMenuStart = "会議を録音"
    static let recordingMenuStop = "録音を停止"
    /// Home の録音カード・会議バー横（図形 ■ の横の字）。
    static let recordingStop = "止める"
    /// Agent の面。録音と同じ字だが意味が別なので key は分ける。
    static let taskStop = "止める"
    /// 止めるを押した段に書く。音声を止めたのではなく、仕事を取り消した。
    static let taskCancelled = "取り消しました"
    /// 工程名が取れない仕事の段（割合は作らない）。
    static let taskWorking = "作業中"
    /// 止めた仕事の結果の 2 行目。
    static let taskStoppedDetail = "仕事を取り消しました。途中までの内容は使いません。"
    /// 受付の応答。**受け付けた（仕事ができた）ときだけ**言う・出す。
    static let taskAccepted = "かしこまりました"
    static let taskAcceptedSub = "作業中も元のアプリを使えます"
    static let taskRejected = "この依頼は実行できません"
    /// 結果の種類（「<種類>ができました」）。
    static let resultKindAnswer = "回答"
    static func resultLength(_ n: Int) -> String { "\(n)字 · Work に保存しました" }
    static func resultSources(_ n: Int) -> String { n > 0 ? "\(n) 件のソースから作成しました" : "Work に保存しました" }
    static let recordingCannotStart = "録音を始められません"
    static let meetingNotes = "メモ"
    static let meetingNotesOpen = "ライブメモを開く"
    static let meetingNotesPanelTitle = "ライブメモ"
    static let meetingDetach = "会議の横に開く"
    static let notesSummary = "要約"
    static let notesDecisions = "決まったこと"
    static let notesActions = "やること"
    static let notesQuestions = "質問"
    static let notesConcerns = "懸念"
    static let sourceLabel = "出所"
    static let homeIntentPlaceholder = "何を終わらせますか？"
    static var homeSubmitHint: String { "\(UserShortcut.submitRequest.display) で送信・Return で改行" }
    static let listeningPlaceholder = "聞いています…"
    /// Dock の字幕・文字起こしがまだ空のとき。メモ・翻訳と同じく「何も無いことを隠さない」。
    static let captionsEmpty = "まだ発言がありません。聞こえたらここに流れます。"
    /// 新しい録音の Project が空のとき。隣の「自分だけ」と同じ言葉で（「None」だけ英語だった）。
    static let projectNone = "なし"
    /// 録音は続いているが、この Mac ではオンデバイス STT の資産が無い。サーバへは落とさない（`SpeechTranscriber`）。
    static let transcriptionOnDeviceUnavailable = "この Mac ではオンデバイス文字起こしを使えません。音声は保存されています"
    static let taskOpenWorkspace = "作業画面で続ける"
    /// 確認の実行ボタンは依頼ごとに**結果の語**（「切断する」「3 件を捨てる」）が入る
    /// （`ActionConfirmation.confirmLabel`）。固定の語ではない。これは demo と説明書が
    /// 例として使う値で、golden 07-confirmation と説明書の「例: 送る」を同じにする。
    static let confirmationConfirmExample = "送る"
    static let confirmationCancel = "やめる"
    static let confirmationEdit = "直す"
    static let confirmationEditDone = "直し終える"
    static let confirmationEditTitle = "内容を直す"
    static let confirmationEditReturn = "修正内容を確認画面に戻します"
    static let resultOpen = "開く"
    static let resultCopy = "コピー"
    static let resultClose = "閉じる"
    /// 失敗・中止した仕事の結果で、失われていないもの（依頼は Work の一覧に残る）。
    static let resultKept = "依頼は Work に残っています。"
    /// 動いている仕事の数（聞く面・作業中の見出し）。進捗率ではない。
    static func taskRunningCount(_ n: Int) -> String { "実行中 \(n)件" }
    /// 結果を出している間に、ほかに動いている仕事。
    static func taskOthersRunning(_ n: Int) -> String { "他 \(n) 件 実行中" }
    static let taskAwaitingApproval = "確認待ち"
    /// VoiceOver: 作業中の面の名前。
    static func dockRunningLabel(_ n: Int) -> String { "Genie: \(n)件 実行中" }
    static let confirmationNeeded = "確認が必要です"
    /// 音声入力で言い淀みを消して入れたとき。
    static let dictationCleaned = "言い淀みを消して入れました"
    static let dictationRestore = "元の文に戻す"
    static let dictationRestored = "元の文に戻しました"
    /// 音声入力の送信ボタン（入れた先のアプリで Return を押す）。
    static let dictationSend = "入れた先で送信"
    static let dictationSendHelp = "入れた先のアプリで送信します（Return を押します）"
    static let dictationSendFailed = "送信できませんでした。入れた先のアプリで Return を押してください。"
    static func dictationInserted(_ app: String, cleaned: Bool) -> String {
        cleaned ? "\(app) に入れました（言い淀みを消しました）" : "\(app) に入れました"
    }
    static func dictationNotInserted(_ app: String, reason: String) -> String { "\(app) に入れられませんでした: \(reason)" }
    static let dictationRestoreFailed = "元の文に戻せませんでした。入れた先で ⌘Z を押すと戻せます。"
    static let resultOpenSettings = "設定を開く"
    static let recoveryResume = "続きから"
    // Home の Work Context（気にすること・待ち・返すもの・今週の負荷）と Personalization。
    static let workContextTitle = "今日、気にした方がいいこと"
    static let workWaitingTitle = "待っていること"
    static let workOwedTitle = "返すもの"
    static let workWeekTitle = "今週の負荷"
    static let workEvidence = "出所を見る"
    static let workNotPriority = "優先ではない"
    static let workDismiss = "外す"
    static let workDone = "済んだ"
    /// 「なぜ重要？」。数式は見せない。理由の行と、出所。
    static let workWhy = "なぜ重要？"
    static let workClose = "閉じる"
    static let workLevelHigh = "高"
    static let workLevelMid = "中"
    static let workLevelLow = "低"
    static let workContextSourcesTitle = "仕事のコンテキスト"
    /// 「これ返して」の確認カードと、会議前の brief。
    static let replyTitleSuffix = "さんへの返信"
    static let replySend = "送る"
    static let replyConnectNeeded = "送るには「Gmail（下書き・送信・整理）」の接続が要ります"
    static let replyConnect = "接続する"
    static let briefTitle = "次の会議"
    static let briefPrepare = "準備する"
    static let briefClose = "閉じる"
    static let briefStart = "この予定を録音"
    static let briefHistory = "前回からの経緯"
    static let briefOpenSource = "元の資料を開く"
    static let briefPrevious = "前回"
    static let briefSince = "その後"
    static let briefOpen = "開いている件"
    static let briefQuestions = "今日確認したいこと"
    static let personalizationTitle = "Genie が使っているあなたの情報"
    static let personalizationEdit = "編集"
    static let personalizationConfirm = "そのとおり"
    static let personalizationDisableTrait = "この推測を使わない"
    static let personalizationDisableAll = "推測を使わない"
    static let personalizationEnableAll = "推測を使う"
    static let recoveryDiscard = "破棄"
    /// できなかった頼みごとを、同じ入口でもう一度。黙って消える代わりに出す道。
    static let resultRetry = "やり直す"
    /// オンデバイス文字起こしが使えないときの直し方（システム設定 > キーボード > 音声入力）。
    static let transcriptionRecoveryHint = "システム設定の音声入力で日本語を入れると使えます"
    /// 設定の「入力監視」行に添える理由（他の 4 行は PermissionCenter の reason）。
    static let permissionInputMonitoringReason = "⌥Space をどこからでも効かせるには入力監視が要ります。"
    /// Dock の会議コントローラの一時停止 / 再開。
    static let recordingPause = "一時停止"
    static let recordingResume = "再開"
    static let sessionInterrupted = "途中で終わっています"
    static let dockRecord = "録音"
    static let dockRelated = "関連操作"
    /// 「Genie と会話」の入口。一回の音声入力（聞く）とは別。
    static let dockConversation = "会話"
    static let conversationEnd = "会話を終了"
    static let conversationExtend = "5分延長"
    static let conversationRemaining = "残り"
    /// 音声入力で聞いている間の欄の案内（Genie には送らない、と押した後にも分かるように）。
    static let dictationPlaceholder = "前面のアプリに入力します…"
    static let quickConversationHelp = "Genie と話します。答えが返ります"
    static let quickDictationHelp = "前面のアプリに文字を入れます。Genie には送りません"
    static let conversationEnding = "まもなく終了"
    static let conversationStopSpeech = "読み上げを止める"
    static let conversationListening = "聞いています"
    static let conversationThinking = "考えています"
    static let conversationSpeaking = "読み上げ中"
    /// 一回の音声入力（文章を入れるだけ）。Genie に話しかけるのは「会話」。
    static let dockDictation = "音声入力"
    static let conversationDuringRecording = "録音中は会話を始められません。録音を止めてから、もう一度どうぞ。"
    /// 「ジーニー」と呼ばれたときの返事（声で言ってから聞き始める）。
    static let wakeAcknowledgement = "はい、どうされましたか？"
    /// メニュー: 「ジーニー」の呼びかけで会話を始める（端末の中で聞き取る）。
    static let menuWakeWord = "「ジーニー」で呼びかける"
    /// Gemini のクレジット切れ・利用枠の上限で、標準の会話に切り替えたとき。
    static let conversationSwitchedFromGemini = "Gemini が使えないため、標準の会話に切り替えました。続けてどうぞ。"
    static let dictationNeedsAccessibility = "文字を入れるには、アクセシビリティの許可が要ります。設定から許可してください。"
    static let dictationNoField = "文字を入れる欄が見つかりませんでした。Genie に聞くときは「会話」から話してください。"
    static let menuShowControls = "録音コントロールを表示"
    static let menuHideControls = "録音コントロールを隠す"
    static let translationTarget = "翻訳先"
    static let translationAuto = "自動更新"
    static let translationRetry = "翻訳を再試行"
    static let liveRetry = "ライブ字幕を再接続"
    static let hudClickHint = "クリック"
    static let permissionRequest = "許可…"
    static let settingsPermissionsSection = "Genieでできること"
    static let settingsShortcutRow = "録音を開始 / 停止"

    // 録音の見出し（録音中 / 一時停止中）の正本は genie-core（Rust）の `hero_text`。
    // Swift へ移さず、`--selftest facts` が Rust の snapshot と一致することを確かめる。
    static let recordingHeroRecording = "録音中"
    static let recordingHeroPaused = "一時停止中"
    static let recordingHeroSilentSuffix = "（音声なし）"
    /// 面は出たが、まだ 1 サンプルも取り込めていない間の見出し。
    /// マイクは engine を start してから最初の IO バッファまで何も入らない（~105ms 実測）。
    /// そこを「録音中」と名乗ると、その間に話した頭が落ちる。**取り込みが生きてから**名乗る。
    static let recordingHeroPreparing = "準備中…"

    // MARK: メニュー

    static let menuOpen = "Genie を開く"
    static let menuSettings = "設定…"
    static let menuGuide = "操作ガイド（PDF）"
    /// Guided Setup: 右下のアバターが System Settings の操作対象を案内する。
    static let menuGuidedSetup = "権限の設定を案内…"

    // MARK: スクショ自動コンテキスト（画像の行き先を偽らない）
    /// cloud のモデルで見るとき。「画像は端末から出ない」とは言わない。{provider} はモデルの名前。
    static let screenshotEgressCloud = "質問したときだけ、その画像を {provider} へ送ります"
    /// 端末内のモデルで見るとき。
    static let screenshotEgressLocal = "画像は端末の外へ送りません"
    /// 検知の一瞬（〜1 秒）だけ Dock に出す 2 行目（1 行目は chip の名）。窓は増やさない・focus は奪わない。
    static let screenshotDetected = "認識しました · そのまま聞けます"
    /// chip の名。以降は「· たった今」などの短い出所だけを添える。
    static let screenshotChip = "スクリーンショット"
    /// 質問で添えたあとの compact provenance（cloud）。{provider} はモデルの名前。
    static let screenshotSentCompact = "{provider} に送信"
    /// 初回だけ明示する（以降は compact）。
    static let screenshotSentFirst = "質問したときだけ {provider} に送信"
    static let menuQuit = "Genie を終了"
    static let menuCheckUpdates = "更新を確認…"
    /// 更新を確認できない実行体（appcast / 公開鍵の無い swift build 等）で出す面。偽の「最新です」は出さない。
    static let updateUnavailableTitle = "この Genie では更新を確認できません"
    static let updateOpenReleases = "配布ページを開く"
    static let updateClose = "閉じる"

    // MARK: ナビ・見出し

    static let navHome = "Home"
    static let navWork = "Work"
    static let navLibrary = "Library"
    static let navApps = "Apps"
    /// 4 面の中の 2 面ずつ（Tasks / Meetings / Agents / Plugins は上位から親の下へ移した）。
    static let workTasks = "Tasks"
    static let workAgents = "Agents"
    static let libraryMeetings = "Meetings"
    static let libraryFiles = "Files"
    static let appsPlugins = "Plugins"
    static let appsConnectors = "Connections"
    /// `DockLabel` が大文字にして出す（画面では PLAN / CONTEXT / SUGGESTED）。
    static let dockPlan = "Plan"
    static let dockContext = "Context"
    static let dockSuggested = "Suggested"

    // MARK: 許可名（設定画面の 5 行。OS の設定と同じ語）

    static let permissionMicrophone = "マイク"
    /// 6 つ目の許可。`permission.` の鍵は設定の 5 行を数える facts selftest が見るので、別の鍵に置く。
    static let permissionSpeechRecognition = "音声認識"
    static let permissionScreenRecording = "画面収録"
    static let permissionAccessibility = "アクセシビリティ"
    static let permissionCalendar = "カレンダー"
    static let permissionInputMonitoring = "入力監視"
    static let permissionCount = 5

    // MARK: 鍵の表示

    @MainActor static var shortcutRecordingToggle: String { GlobalShortcut.label() }
    static var shortcutConfirmationProceed: String { UserShortcut.confirm.display }
    static var shortcutEscape: String { UserShortcut.cancel.display }

    /// `--selftest facts` が書き出す全件。key の重複は selftest が落とす。
    @MainActor static var all: [Fact] {
        func f(_ k: String, _ v: String, _ p: Bool = true) -> Fact { Fact(key: k, value: v, protected: p) }
        return [
            f("recording.start", recordingStart),
            f("menu.guidedSetup", menuGuidedSetup),
            f("screenshot.egress.cloud", screenshotEgressCloud),
            f("screenshot.egress.local", screenshotEgressLocal),
            f("screenshot.detected", screenshotDetected),
            f("screenshot.chip", screenshotChip),
            f("screenshot.sent.compact", screenshotSentCompact),
            f("screenshot.sent.first", screenshotSentFirst),
            f("recording.menu.start", recordingMenuStart),
            f("recording.menu.stop", recordingMenuStop),
            f("recording.stop", recordingStop, false),
            f("task.stop", taskStop, false),
            f("task.cancelled", taskCancelled, false),
            f("task.working", taskWorking, false),
            f("result.close", resultClose, false),
            f("result.kept", resultKept, false),
            f("task.awaitingApproval", taskAwaitingApproval, false),
            f("confirmation.needed", confirmationNeeded, false),
            f("dictation.cleaned", dictationCleaned, false),
            f("dictation.restore", dictationRestore, false),
            f("dictation.restored", dictationRestored, false),
            f("dictation.send", dictationSend, false),
            f("dictation.sendHelp", dictationSendHelp, false),
            f("dictation.sendFailed", dictationSendFailed, false),
            f("dictation.restoreFailed", dictationRestoreFailed, false),
            f("task.stoppedDetail", taskStoppedDetail, false),
            f("task.accepted", taskAccepted, false),
            f("task.acceptedSub", taskAcceptedSub, false),
            f("task.rejected", taskRejected, false),
            f("result.kindAnswer", resultKindAnswer, false),
            f("recording.cannotStart", recordingCannotStart),
            f("meeting.notes", meetingNotes, false),
            f("meeting.notes.open", meetingNotesOpen),
            f("meeting.notes.panelTitle", meetingNotesPanelTitle),
            f("meeting.detach", meetingDetach),
            f("notes.summary", notesSummary, false),
            f("notes.decisions", notesDecisions),
            f("notes.actions", notesActions),
            f("notes.questions", notesQuestions, false),
            f("notes.concerns", notesConcerns, false),
            f("source.label", sourceLabel),
            f("home.intent.placeholder", homeIntentPlaceholder),
            f("home.intent.submitHint", homeSubmitHint, false),
            f("listening.placeholder", listeningPlaceholder),
            f("captions.empty", captionsEmpty, false),
            f("sheet.project.none", projectNone, false),
            f("transcription.onDeviceUnavailable", transcriptionOnDeviceUnavailable),
            f("task.openWorkspace", taskOpenWorkspace),
            f("confirmation.confirm.example", confirmationConfirmExample, false),
            f("confirmation.cancel", confirmationCancel),
            f("confirmation.edit", confirmationEdit),
            f("confirmation.editDone", confirmationEditDone, false),
            f("confirmation.editTitle", confirmationEditTitle, false),
            f("confirmation.editReturn", confirmationEditReturn, false),
            f("result.open", resultOpen, false),
            f("result.copy", resultCopy, false),
            f("result.openSettings", resultOpenSettings),
            f("recovery.resume", recoveryResume),
            f("work.context.title", workContextTitle, false),
            f("work.waiting.title", workWaitingTitle, false),
            f("work.owed.title", workOwedTitle, false),
            f("work.week.title", workWeekTitle, false),
            f("work.evidence", workEvidence, false),
            f("work.notPriority", workNotPriority, false),
            f("work.dismiss", workDismiss, false),
            f("work.done", workDone, false),
            f("work.why", workWhy, false),
            f("work.close", workClose, false),
            f("work.level.high", workLevelHigh, false),
            f("work.level.mid", workLevelMid, false),
            f("work.level.low", workLevelLow, false),
            f("work.sources.title", workContextSourcesTitle, false),
            f("reply.titleSuffix", replyTitleSuffix, false),
            f("reply.send", replySend, false),
            f("reply.connectNeeded", replyConnectNeeded, false),
            f("reply.connect", replyConnect, false),
            f("brief.title", briefTitle, false),
            f("brief.prepare", briefPrepare, false),
            f("brief.close", briefClose, false),
            f("brief.start", briefStart, false),
            f("brief.history", briefHistory, false),
            f("brief.openSource", briefOpenSource, false),
            f("brief.previous", briefPrevious, false),
            f("brief.since", briefSince, false),
            f("brief.open", briefOpen, false),
            f("brief.questions", briefQuestions, false),
            f("personalization.title", personalizationTitle, false),
            f("personalization.edit", personalizationEdit, false),
            f("personalization.confirm", personalizationConfirm, false),
            f("personalization.disableTrait", personalizationDisableTrait, false),
            f("personalization.disableAll", personalizationDisableAll, false),
            f("personalization.enableAll", personalizationEnableAll, false),
            f("recovery.discard", recoveryDiscard),
            f("result.retry", resultRetry),
            f("transcription.recoveryHint", transcriptionRecoveryHint, false),
            f("settings.inputMonitoringReason", permissionInputMonitoringReason, false),
            f("speech.recognitionName", permissionSpeechRecognition),
            f("recording.pause", recordingPause),
            f("recording.resume", recordingResume),
            f("session.interrupted", sessionInterrupted),
            f("dock.record", dockRecord),
            f("dock.related", dockRelated),
            f("dock.conversation", dockConversation),
            f("conversation.end", conversationEnd),
            f("conversation.extend", conversationExtend),
            // 「残り」は普通の言葉（ガイドの本文でも別の意味で使う）。画面の固有の語として縛らない。
            f("conversation.remaining", conversationRemaining, false),
            f("dictation.placeholder", dictationPlaceholder),
            f("quick.conversationHelp", quickConversationHelp),
            f("quick.dictationHelp", quickDictationHelp),
            f("conversation.ending", conversationEnding),
            f("conversation.stopSpeech", conversationStopSpeech),
            f("conversation.listening", conversationListening),
            f("conversation.thinking", conversationThinking),
            f("conversation.speaking", conversationSpeaking),
            // 「音声入力」は macOS の設定（キーボード → 音声入力）の名前でもある。ガイドがその設定を指す文を
            // この文言で縛らない（protected にしない）。
            f("dock.dictation", dockDictation, false),
            f("dictation.noField", dictationNoField),
            f("dictation.needsAccessibility", dictationNeedsAccessibility),
            f("conversation.duringRecording", conversationDuringRecording),
            f("menu.showControls", menuShowControls),
            f("menu.hideControls", menuHideControls),
            f("translation.target", translationTarget),
            f("translation.auto", translationAuto),
            f("translation.retry", translationRetry),
            f("transcription.liveRetry", liveRetry),
            f("hud.clickHint", hudClickHint, false),
            f("permission.request", permissionRequest),
            f("settings.permissionsSection", settingsPermissionsSection),
            f("settings.shortcutRow", settingsShortcutRow),
            f("recording.hero.recording", recordingHeroRecording, false),
            f("recording.hero.preparing", recordingHeroPreparing, false),
            f("recording.hero.paused", recordingHeroPaused, false),
            f("recording.hero.silentSuffix", recordingHeroSilentSuffix, false),
            f("menu.open", menuOpen),
            f("menu.settings", menuSettings),
            f("menu.guide", menuGuide),
            f("menu.quit", menuQuit),
            f("menu.checkUpdates", menuCheckUpdates),
            f("update.unavailable.title", updateUnavailableTitle, false),
            f("update.openReleases", updateOpenReleases, false),
            f("update.close", updateClose, false),
            f("nav.home", navHome, false),
            f("nav.work", navWork, false),
            f("nav.library", navLibrary, false),
            f("nav.apps", navApps, false),
            f("work.tasks", workTasks, false),
            f("work.agents", workAgents, false),
            f("library.meetings", libraryMeetings, false),
            f("library.files", libraryFiles, false),
            f("apps.plugins", appsPlugins, false),
            f("apps.connectors", appsConnectors, false),
            f("dock.plan", dockPlan, false),
            f("dock.context", dockContext, false),
            f("dock.suggested", dockSuggested, false),
            f("permission.microphone", permissionMicrophone),
            f("permission.screenRecording", permissionScreenRecording),
            f("permission.accessibility", permissionAccessibility),
            f("permission.calendar", permissionCalendar),
            f("permission.inputMonitoring", permissionInputMonitoring),
            f("shortcut.recording.toggle", shortcutRecordingToggle),
            f("shortcut.confirmation.proceed", shortcutConfirmationProceed),
            f("shortcut.escape", shortcutEscape),
        ]
    }
}

typealias Facts = UserFacingFacts

/// 鍵の正本。**実動作（`keyboardShortcut`）と badge の表示を別々に書かない。**
///
/// 以前は `.keyboardShortcut(.return, modifiers: .command)` と `KeyBadge("⌘↩")` が独立していて、
/// 鍵を変えても表示が変わらなかった。表示は key/modifiers から機械的に組む。
/// グローバルの ⌥Space は CGEventTap（`GlobalShortcut`）なので別型だが、表示は同じ規則。
struct UserShortcut {
    let key: KeyEquivalent
    let modifiers: EventModifiers

    /// 確認の実行。Return だけでは走らない（押し慣れた鍵で外へ出るのは危ない）。
    static let confirm = UserShortcut(key: .return, modifiers: .command)
    static let submitRequest = UserShortcut(key: .return, modifiers: .command)
    /// 逃げ道。どの面でも同じ鍵。
    static let cancel = UserShortcut(key: .escape, modifiers: [])

    /// 表示（badge・facts・説明書）。
    var display: String { Self.symbols(modifiers) + keyName }

    var keyName: String {
        switch key.character {
        case KeyEquivalent.return.character: return "↩"
        case KeyEquivalent.escape.character: return "esc"
        case KeyEquivalent.space.character: return "space"
        case KeyEquivalent.tab.character: return "⇥"
        case KeyEquivalent.delete.character: return "⌫"
        default: return String(key.character)
        }
    }

    static func symbols(_ m: EventModifiers) -> String {
        var s = ""
        if m.contains(.control) { s += "⌃" }
        if m.contains(.option) { s += "⌥" }
        if m.contains(.shift) { s += "⇧" }
        if m.contains(.command) { s += "⌘" }
        return s
    }

    /// グローバルの録音鍵（⌥Space）を HUD の badge 列に分ける: ["⌥", "space"]。
    /// 正本は `GlobalShortcut.label()`（Carbon の keycode から組む）。
    @MainActor static var globalRecordingBadges: [String] {
        let label = GlobalShortcut.label()
        var mods: [String] = []
        var rest = Substring(label)
        while let c = rest.first, "⌘⌥⌃⇧".contains(c) { mods.append(String(c)); rest = rest.dropFirst() }
        return mods + [rest.lowercased()]
    }
}
