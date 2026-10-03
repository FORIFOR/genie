# One Continuous Surface — 段階 ①（状態の持ち方）と印 — 2026-09-28

design handoff「TaskDock — One Continuous Surface」（本人が渡した zip、`design_handoff_taskdock_continuous_surface/README.md`）を 4 段階で入れる。
本人の決定: 会話から頼んだ仕事は受け付けた後も会話を続ける（一回の依頼だけ音声を終える）/ 結果は handoff どおり 8 秒（停止 3 秒）で縮める・失敗は閉じるまで / 全部を段階的に。

reference : handoff README §State Management・§遷移表（表示は音声と仕事から純関数で合成、rev で古い出来事を捨てる、受付は task.accepted の後だけ、成果物の無い成功は失敗）。
hypothesis: 各所が `setDock(.agent)` / `setDock(.result)` を直接書いていたので、後から来た表示が先の表示を上書きしていた（仕事の結果で会話の面が消える・止めた仕事が ✓ に戻る・仕事は 1 件しか持てない）。音声と仕事を別々に持ち、一枚を `DockComposer` で決めれば、複数の仕事・確認・結果・会話が互いを消さない。
measured  : 仕事は `activeTask` 1 件。声の依頼の仕事は Dock に出ない（Work だけ）。止めるの後の遅い成功で ✓（前回直した）。受付と拒否の面が無い（拒否も「回答」として出ていた）。
candidates: A = いまの命令的な setDock / B = 頼まれた面（requested）と仕事の一覧（board）・受付（ack）・注目中の結果を別に持ち、純関数で合成（採用）
gate      : 1) 機械: `ContinuousSurfaceTests`（古い rev・止めた後の成功・複数の仕事・優先順・成果物なし・拒否・保持）、`TaskDockCancelTests`、全 234 件。`--selftest aistop`（実 gateway: 止める → CANCELLED、成功に変わらない）、`voiceask`、`micrelease`（実マイク）、`dock8` 明暗 25 状態。2) 盲検: 未実施。3) golden: task-dock を撮り直し（idle の印が変わった）。

## 入れたもの（段階 ①）

- `Core/DockTaskBoard.swift`: `DockTask`（rev・工程名・状態）、`DockTaskEvent`、`DockTaskBoard.apply`（古い rev・終わった仕事への出来事を捨てる）、`DockComposer.compose`（優先順: 本人の聞き取り/送信 › 確認 › 受付 › 頼まれた面 › 結果 › 動いている仕事 › 待機。会話の自動の聞き直しは確認を隠さない）、`DockResultPolicy`（8 秒 / 3 秒 / 失敗は保持）。
- `GenieStateStore`: `requested` と一覧を分けて持ち `recompose()`。確認カードの「後ろに頼まれた表示」の記録は不要になった（頼まれた面が残っている）。受付（1.7 秒）とホバーの保持。会議の AI 操作も一覧の 1 行。
- 声・文字の依頼: backend に仕事ができたら一覧の行（止めるは backend の取り消し）。承認待ちは「確認待ち」。すぐ答えが出た依頼は今までどおり答えの面で、行にしない。受け付けられなかった依頼は「この依頼は実行できません」と理由（会話では声で理由を言う）。遅い結果は結果の面（開く・コピー）、天気・ニュースはカード。30 分まで追う。
- 結果の操作: コピーはできた中身を写す（以前は題だけ）。再試行は声の依頼なら同じ依頼を送り直す（以前は会議の AI 操作を走らせた）。
- 確認待ちの間も、本人が始めた聞き取り（音声入力・会議の問い）は前に出て、やめたら同じカードへ戻る（カードは答えを待ったまま。120 秒で答えが無ければ承認しないまま残る）。会話は今までどおりカードの間は始めない。

## 印（本人の指定、2026-09-28）

- 本人が渡したランプと G の絵を印にした（元の絵 `apps/genie-macos/Resources/GenieMark-source.png`）。
- app icon: 近黒の角丸に白いランプ、星だけアクセント（`Resources/AppIcon.icns`、`app-icon.png`）。Tauri の desktop app の icon は変えていない。
- メニューバー: SF Symbol の波形 → ランプの template 画像（明暗に合わせて色が変わる）。
- Dock の待機の印: 3 本の棒 → ランプ（アクセント色、12pt 高）。オーブ（声の入力の大きさを示す）はそのまま。

## 次（段階 ②〜④）

② 各状態の面を handoff の寸法・文言へ（聞き取りの「実行中 n件」、作業中の行ごとの停止と不定進捗、確認の読み取り箱、結果の「<種類>ができました」と「他 n 件 実行中」、失敗/停止の見出し）と共有の印（丸 → スピナー → ✓）。③ 外殻と内容のモーション、Reduce Motion/Transparency、VoiceOver の通知。④ 実機の撮影・計測（待機の CPU、モーフの fps）。

## 測っていないこと

- 実 gateway で「12 秒を超える声の依頼」を通した受付 → 行 → 結果の流れ（単体テストと会議の AI 操作では確認。声の長い依頼は段階 ② の検査で撮る）。
- `aistop` が一度だけ、`open -W` 経由で 10 分止まった（主スレッドは待機、通信も無し）。同じ build で直接・`open` 経由とも再現しない。原因は分かっていない。

## 段階 ②〜④ の仕上げ（2026-09-29）

TaskDock 1b の第 2 版（印・静かな作業中・結果の 3 行、`compare/presence-mark`）の上に、handoff の残りを入れた。

- 作業中: 段で進む仕事（会議の AI 操作）が 1 件だけなら段を出す。それ以外（声・文字の依頼・複数の仕事）は **1 件 1 行**（題・いまの工程・行ごとの止める。確認待ちは「確認待ち」を注意色）。以前は声・文字の依頼の仕事で、題が「実行中」・段も止めるも無い面になっていた。見出しに「実行中 n件」。
- 聞く面: 動いている仕事があれば「実行中 n件」。結果の面: ほかに動いていれば「他 n 件 実行中」。
- VoiceOver: 受付・受け付けられない・結果・作業中になった・確認で読み上げる（`DockAnnouncer`、純関数で検査）。聞く・考え中・待機では言わない。
- 使っていない進行帯・経過時間・文脈の定義を消した（Capsule 20 → 19）。
- 動き（段階 ③）: `--selftest markmotion`（`GENIE_ANIMATE_IN_SELFTEST=1`）で実際の Dock の窓を 50ms ごとに撮り、250ms 前と比べた。**聞く 25/25・作業中の印 23/25・下辺の流れ 25/25 で変化、待機 0/25（連続描画しない）**、2 回とも同じ。聞く状態の輪郭は入力の平方根で広げた（波形と同じ）。
- 検査: `dock8` 28 状態（新しく 06h 複数の仕事・06i 聞く面の件数・06j 結果と他の仕事。明暗の golden を追加。既存の 46 枚は画素まで同じ）、swift test 241、verify-all（本人が決めた macOS 27 の shots golden を除いて緑）。
- 測っていない: 実機で本人が使う姿、Reduce Motion / Reduce Transparency を本当に入れた姿、fps と待機の CPU を Instruments で測ること、盲検。`--selftest geometry` はこの OS の基準が無い（本人の決定）。macOS 26.6.2 の基準と比べると、作業中の面が 35pt 短くなり段が上がった等、意図した変更だけが出た。
