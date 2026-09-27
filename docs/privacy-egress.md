# 何が Mac の外へ出るか（実装から読んだ一覧、2026-09-04）

> **2026-09-10 更新。**下の一覧は見つけた時点の姿。現在は、利用者が設定で明示的に許可した場合に限り、録音全体をGoogle STTへ送り高精度な確定版を作る。
> 守るのは `scripts/verify-privacy-egress.sh`（PRIVACY_EGRESS_GATE、verify-all に入っている）と
> `--selftest egress`（実行体で、既定 OFF と「資産の無いロケールで throw」を確かめる）。

取扱説明書の脚注は「録音した音声・文字起こし・鍵はこの Mac の中だけで扱われ、あなたが確認して
実行したものだけが外に出ます」と言う。それが**どの条件で本当か**を、意図ではなく実装
（呼び手と条件）で一覧にする。spec §22 の label（local-only / cloud-used / external-send）で分類する。
表示の文言はまだ変えていない（この一覧が正本になってから）。

| 経路                                                         | 出るもの                                                                                                                                                                                                         | 出る条件                                                                                                                                                                                                                     | 分類                                                            | 根拠                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple の音声認識サーバ                                       | **会議の音声**                                                                                                                                                                                                   | `SFSpeechRecognizer(ja-JP).supportsOnDeviceRecognition == false` のとき。コードが `requiresOnDeviceRecognition` をその値にしているので、日本語のオンデバイス資産が無い Mac では**黙って**サーバ認識になる                    | cloud-used（利用者に見えない）                                  | `Audio/SpeechTranscriber.swift:53,93`、呼び手 `RecordingWorkspace/RecordingRuntime.swift:82`                                                 |
| gateway（`ASTRA_GATEWAY_URL`、既定 `http://127.0.0.1:3000`） | 開発サインイン（`main-<pid>@astra.local`）、`/v1/me`、会議の作成・終了、**録音した音声の全断片**（WS `/v1/meetings/:id/audio`）、落ちた録音の回復送信、声で頼んだ文（`/v1/conversations/:id/turns`）、タスク作成 | gateway に到達できるとき。音声の会議作成・送信・回復は設定の `astra.transcription.cloudGoogleSTT=true`（「高精度クラウド文字起こし」）のときだけ。Main window は接続情報を渡すが、音声送信の判断は `RecordingRuntime` が行う | cloud-used / external-send（Google STT は設定がオンのときだけ） | `Main/MainWindowView.swift:35-49`、`RecordingRuntime.swift:150-185,406-410,475-482`、`core/genie-core/src/api.rs:63,111,135,248,297,322,383` |
| connector の OAuth                                           | 認可コード往復（本文は出ない）                                                                                                                                                                                   | 利用者が接続操作をしたとき                                                                                                                                                                                                   | external-send（本人操作）                                       | `Context/ConnectorFlow.swift:9-14`                                                                                                           |
| Sparkle appcast（GitHub Releases）                           | 版・OS の情報                                                                                                                                                                                                    | 起動時 1 回、「更新を確認…」                                                                                                                                                                                                 | cloud-used                                                      | `App/SoftwareUpdate.swift`                                                                                                                   |
| 会話（Gemini Live、`Audio/GeminiLiveProvider.swift`） | **「会話」の間の声**（16 kHz PCM）と、Gemini が作る文字起こし・答えの声。仕事は `delegate_task` で Genie に渡し、Google へ返すのは受け付けたか（status）だけ。API キーはヘッダー（`x-goog-api-key`）で送り、URL・ログに載せない | 本人が設定で「会話で Gemini Live を使う」をオンにし、キー（キーチェーン）と月の上限（分）を置き、「会話」を始めたときだけ。上限に達したら始めない・途中で終える。「聞く」と会議の録音は送らない。失敗しても別の有料の提供元へ切り替えない | external-send（本人の同意・本人のキー） | `Audio/GeminiLiveProtocol.swift`（接続先）、`Audio/GeminiLiveProvider.swift`、`VoiceHUD/VoiceHUDState.swift` `beginConversation` |
| いまの情報（agent host、`workers/agent-host/src/current-info/`） | 天気: 緯度経度と日数（`api.open-meteo.com`）、質問に出た地名だけ（`geocoding-api.open-meteo.com`。既定の地域は同梱の表で引き、送らない）。ニュース: 何も送らない（`news.web.nhk` の主要 RSS）、話題の語だけ（`news.google.com` の検索 RSS）。会話の文脈・Work Context・既定の地域の設定は送らない | 利用者が天気・ニュースを聞いたときだけ（`info.lookup`）。相手先は `CURRENT_INFO_HOSTS` の 4 つに限り、https・転送不可・5 秒 | external-send（本人の質問） | `current-info/hosts.ts`、`services/conversation/src/current-info.ts` |
| 配布ページ / ガイドの URL                                    | なし（ブラウザを開くだけ）                                                                                                                                                                                       | 本人操作                                                                                                                                                                                                                     | —                                                               | `App/StatusBarController.swift`                                                                                                              |

## Apple 音声認識の実測（この Mac、macOS 26.6.2、2026-09-04）

`SFSpeechRecognizer` の `supportsOnDeviceRecognition` はロケールごとに違う。この Mac では
**ja-JP と en-US だけ true**、en-GB / zh-CN / ko-KR / de-DE / fr-FR / es-ES / vi-VN / th-TH /
id-ID / hi-IN / tr-TR / uk-UA / ms-MY / he-IL は `available=true, onDevice=false`
（ログは "No Assistant asset for language …"）。つまり「対応していない Mac」ではなく
「その言語のオンデバイス資産が入っていない Mac」で起きる。日本語の資産が入っていない
Mac（英語環境の Mac など）で Genie を使うと、この列に ja-JP が入る。

`say` で作った 2.75 秒の音声を de-DE（onDevice=false）で認識させた結果:

| `requiresOnDeviceRecognition` | 結果                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| true                          | 即座に error `Failed to access assets`（kLSRErrorDomain 102）。文字は出ない                 |
| false                         | `Guten Morgen wie teuer die hat` が返る——資産が無いのに認識できた＝**サーバで認識している** |

Genie のコードは後者の設定になる（`= recognizer.supportsOnDeviceRecognition`）。
Info.plist の `NSSpeechRecognitionUsageDescription` は「音は端末から出しません」と言っている
（`scripts/release-macos.sh:132`）。**この 2 つは両立しない。**

決めること（→ A に決めた。末尾）: A = `requiresOnDeviceRecognition = true` を固定し、資産が無ければ
「この Mac では日本語のオンデバイス文字起こしが使えません」と明示して録音だけ続ける
（spec §21 "Meeting STT degraded: 録音は継続中"）。B = サーバ利用を許し、ガイドと UI で
「必要な場合は Apple の音声認識を利用」と正確に表示する。

## 相手の声（system audio）について

`RecordingWorkspaceState.start()` は `RecordingRuntime.begin(meetingId:)` を既定引数で呼ぶので
`captureSystemAudio: false`。**製品の録音は相手の声（画面の音）を一度も取り込んでいない**。
「System Audio: On」の切り替え（`Home/NewRecordingSheet.swift:12`）は保存されるだけで、
読む側が無い。一方 `.meeting` は録音開始時に「相手の音声のために」画面収録を求める
（`Settings/PermissionCenter.swift:24,33`）。使わない許可を求めている。
画面収録が実際に要るのは、Workspace の「スキャン」（`captureScreenshot()`）と画面について答える
`.screenAsk` だけ。

## 決めたこと（2026-09-04、本人の決定）

1. **STT は黙ってクラウドへ落とさない。** `requiresOnDeviceRecognition = true` を固定
   （`Audio/SpeechTranscriber.swift:74,115`）。資産が無いロケールでは `start` が code 3 で throw し
   （`:68-69`）、`recognizeFile` は nil。**エラー後に false で取り直さない。**録音は続き、Workspace の
   本文が「この Mac ではオンデバイス文字起こしを使えません。音声は保存されています」と言う
   （`RecordingWorkspaceView.swift:494`、`Facts.transcriptionOnDeviceUnavailable`、ガイド §7 に行を足した）。
   クラウド文字起こしを足すなら「音声が外部サービスへ送信されます」と言う別の opt-in 機能として作る。
   実測: ar-SA（資産無し）で `start=code3 file=nil`（`--selftest egress`）。
2. **録音のGoogle STT送信は既定 OFF、明示同意で ON。** `MainData.load()` は接続情報を録音側へ渡すが、
   録音開始時とフレーム送信時の両方で同意を確認する。「ライブ文字起こし（Google STT）」をONにすると
   マイクとシステム音声を別々の認識ストリームへ送り、途中経過と確定発話を録音中に表示・ローカル保存する。
   Gatewayの `/v1/transcription/live` は認証必須で、音声をディスク保存せずGoogleへ逐次転送する。
   通常の録音停止ではBatchRecognizeも録音全体の再送も実行しない。過去録音の自動送信も行わない。
   AI 操作・翻訳・声で頼む（文字を gateway へ送る）は人が押してから動くので残す。
3. **`.meeting` はマイクと音声認識（Apple Speech、手元で完結し端末から出ない）だけ求める**（`Settings/PermissionCenter.swift`）。system audio は本番経路で
   取り込んでいないので、画面収録を求める理由が無かった。本当に繋いだ日に「相手の声も記録する」の
   入口で JIT で求める（Permission B は別途作らない）。ガイドの「（相手の声のために）画面収録」は消した。

負例で確かめたこと（gate が落ちる）: `requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition`
に戻す → FAIL、`RecordingRuntime.shared.configureBackend` を旗の外へ出す → FAIL、
`.meeting` に `.screenRecording` を戻す → FAIL。

## 残す実機確認（Privacy とは別の gate: Meeting Capture Reality）

`.meeting` をマイクと音声認識だけにしたので、Privacy は PASS でも**会議の録れ方**は別に確かめる（本人の指示、2026-09-04。音声認識は 2026-09-06 に追加: 求めずにいたので初回は文字起こしが動かなかった）。
実際の Meet / Zoom で、スピーカー再生の状態で 1 度録って次を見る:

```
MEETING_CAPTURE_REALITY
  local mic                captured   （自分の声が文字起こしに出る）
  remote speaker           captured   （相手の声がマイク経由で拾えている / 拾えていない）
  system audio             captured   （いまは未接続なので NOT_CAPTURED が正直。繋いだら再測定）
  screen permission        not required（録音開始で画面収録のダイアログが出ない）
```

相手の声が拾えないなら、それは system audio（ScreenCaptureKit / 仮想デバイス）を繋ぐ課題で、
繋いだ時点で `.meeting` の JIT に「相手の声も記録する」として 画面収録 を戻す（`verify-privacy-egress.sh` は
`captureSystemAudio: true` と `.screenRecording` が**両方**あるときだけそれを PASS にする）。
自分では実会議を開けないので、この 4 行は本人の実機で。

## カレンダーは「予定が出る場所」で求める（CALENDAR_PURPOSE_FIRST、2026-09-04）

決める前の状態: カレンダーの許可を求める場所は設定の「権限」の 1 行だけで（`Settings/SettingsView.swift:35`）、
Home は `.onAppear` で黙って読み、未確認なら「これからの予定」の節ごと消えていた。求めてはいないが、
**この機能があることを知る道が無い**（設定を開いた人だけが気づく）。spec §21「Permission missing:
理由 + Connect」§22「利用直前に purpose-first」に対して、理由も入口も無かった。

決めたこと:

1. **求める場所は Home の「これからの予定」の場所**。未確認のときだけ、予定の代わりに
   「予定から録音を始める — これからの会議をここに出すにはカレンダーの許可が要ります。[カレンダーを許可 →]」
   の行を出す（`Home/HomeView.swift` `calendarAskRow`、識別子 `askCalendar`）。押したときだけ OS のダイアログ。
   Home を開いた瞬間には出さない。
2. **拒否されたら二度と聞かない。** 拒否・制限ではこの行を出さない。再許可は設定の「権限」から
   （行はそのまま）。
3. **予定を読む分だけ求める。** `PermissionCenter.Capability.schedule` は `[.calendar]` だけ。録音のマイクは
   `.meeting` が録音開始で別に求める（巻き込まない）。
4. 許可が下りたらその場で予定を読み直す（`HomePane.loadUpcoming`、`onCalendarGranted`）。

gate（`--selftest calendarask`、`verify-macos-recording.sh` と `verify-release-artifact.sh` の一覧に入れた）:

```
CALENDAR_PURPOSE_FIRST
  schedule.required == [calendar]         PASS
  notDetermined → askCalendar + reason     PASS（自プロセス AX で識別子と文を確認）
  granted / denied → askCalendar 無し      PASS
  起動経路で求めていない                    PERMISSION_JIT_OK（HomeView は許可一覧に理由つきで載っている）
```

この Mac は許可済みなので、未確認・拒否は `Permissions.simulatedCalendar`（`simulatedMicrophone` と同じ型）で作る。
**実 TCC ダイアログが出て、許可直後に予定が並ぶ**ところは署名 .app + 未確認の端末でしか確かめられない
（`--selftest calendarlive` と同じ制約、NOT_MEASURED）。

## スクリーンショット（SCREENSHOT_EGRESS_TRUTH、2026-09-07）

「⌘⇧4 → 『これ何？』」で画像がどこまで行くか。**「画像は端末から出ない」とは言わない。**
守るのは `--selftest screenshotegress`（SCREENSHOT_EGRESS_TRUTH）、`core/genie-core` の
`turn_body_carries_ids_and_labels_but_never_pixels`、gateway の `conversations-screenshot.integration.test.ts`
（`data` 等を持つ添付は 400）、実経路は `scripts/reality/run-screenshot-e2e.sh`。

| 段階                           | 出るもの                                                       | 行き先                                        | 分類          | 根拠                                                                                             |
| ------------------------------ | -------------------------------------------------------------- | --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| 撮っただけ                     | **なし**（受け渡し場所にも写さない）                           | —                                             | local-only    | `Context/ScreenshotContext.swift` `attachCount==0`、gate capture_only_egress=0                   |
| 参照表現で尋ねた               | 添付の **id / kind / label** の 3 文字列（画素 0）             | gateway `/v1/conversations/:id/turns`         | cloud-used    | `core/genie-core/src/api.rs` `turn_body`、contracts `TurnAttachment.strict()`                    |
| 同上（端末内）                 | `<id>.png` の写しを `~/Library/Caches/Genie/VisualContext/` へ | 端末の worker（`workers/agent-host`）が Read  | local-only    | `visual-context.ts` 正規パス検査、TTL 30 分 / 20 件 / 200MB                                      |
| worker が cloud のモデルで見る | **その画像だけ**（Claude Code CLI が Read した画素）           | 利用者自身の Claude（Claude Code のログイン） | external-send | `llm-steps.ts` `toolsFor` は画像が在るときだけ `Read`。UI の開示は `Facts.screenshotEgressCloud` |
| worker が端末内モデルで見る    | なし                                                           | —                                             | local-only    | `VisualEgressPolicy.localVision`（端末内で画像を見るモデルはまだ無い）                           |

UI の開示（chip の help）: 「質問したときだけ、その画像を Claude へ送ります」。既定の方針は cloud で、
端末内モデルが繋がるまで「出ません」は出ない（`VisualEgressPolicy.current`）。

## 2026-09-09: 画面の音を本番録音に接続

上記の未接続という記述は 2026-09-04 時点の記録。現在は「画面の音」の保存値を
録音開始時に読み、オンの場合だけ `.meetingAudio` の画面収録権限を JIT で要求する。
マイクだけの `.meeting` は引き続きマイクと音声認識だけを要求する。
ScreenCaptureKit の音をマイクと同じ 16 kHz の時間軸に混ぜて保存し、文字起こしは
音源ごとにオンデバイス認識へ渡す。Apple サーバへのフォールバックは追加していない。
画面音の取り込みが始められない場合は、マイク録音を継続して設定への導線を表示する。

公開 YouTube 会話の実測で remote_audio、非ゼロの音量、相手の文字起こし保存を確認。
これは会議アプリの自動検出や Google/Microsoft コネクタ認証の検証とは別。
証跡は `dist/release-validation/system-audio-fix/video-run2/astra/result.json`。
最終配布物での再検証が終わるまで release=go にはしない。

開始直後の停止では、古い録音の ScreenCaptureKit 起動をキャンセルする。
音声コールバックとその解除は同じキューに直列化し、マイクの変換器も tap ごとの所有にした。
終了済み録音が後から音を取り込むことを防ぐ。開始・停止の受け入れ検証19項目は
修正後に10回連続で合格（`dist/release-validation/system-audio-fix/lifecycle-stress`）。

一時停止ではオンデバイス認識要求も終了し、再開時に新しく開始する。音声だけが
戻って文字起こしが戻らなかった実測を受けて修正。`video-run6` で再開後の保存2行、
停止中の音声0フレーム・確定行増加0を確認した。動画途中の広告音声も含むため、
会議内容の抽出精度の判定には使用しない。

### 2026-09-09 録音停止と音源分離の追検証

録音停止時は取り込みを直ちに停止し、認識器の終端処理を非同期で待ってから文字起こしとノートを保存する。確定中に次の録音を要求した場合は保存完了後に開始する。録音IDはUUIDを使い、同秒内の再録音で上書きしない。受け入れ20項目と停止表示51ms（基準150ms）を確認。

ローカル合成の日本語4発言をafplayで再生し、実CoreAudio→ScreenCaptureKit→オンデバイスSTT→Library保存を通した。分離音源の結果は文字一致度0.78（基準0.55）、決定2/2・作業1/1、停止中の音声フレーム0、再開後2行、保存4行。英語固有名詞は誤認識あり。force検出・相手側1チャンネルのため、会議の自動検出と人物別話者分離は検証対象外。先行した不合格実行では動画音声の混入が疑われ、独立した合格実行と区別して保存した。証拠はdist/release-validation/system-audio-fixture/isolated/。
