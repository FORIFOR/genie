# 段階 2: Genie と会話（半二重の複数ターン） — 2026-09-27

PR #27（feat/jarvis-voice-session）の VoiceSessionController を土台に、設計（5 分の明示セッション、入口の分離、共通の終了処理）へ合わせて作り直した。

reference : Apple Human Interface Guidelines — Siri / Voice interactions (https://developer.apple.com/design/human-interface-guidelines/siri, 2026-09-27)。音声が有効な間は、聞いていること・止め方が常に分かる。
hypothesis: 「聞く」を押すたびに 1 回で終わる音声入力しか無いので、相談を続けるには毎回押し直す必要がある。別の入口「会話」から始めた 5 分の会話では、読み上げが終わると自動で次を聞き、面の下に「会話中 · 残り時間 / 会話を終了」を常に出せば、何をしているか・どう止めるかを失わずに続けて話せる。
measured  : Listening 600×126（safe-top 32 を含む窓）。クイック操作 560×68 に 3〜4 項目。会話の入口は無い。字は dockType meta 13。
candidates: A = いま（一回の音声入力だけ） / B = クイック操作に「会話」を足し、会話中は面の下に 1 行（meta 13・muted、終わり 30 秒前だけ「まもなく終了」と「延長」） / C = PR #27 の形（聞くボタン自体を会話にし、90 秒の無操作で終了。設計に反するので不採用）
gate      : 1) 機械: `ConversationLoopTests` 9 件（空の答え・コードだけ・失敗・受付だけ・遅れた知らせ・5 分・延長の上限）、`--selftest dock8` 25 状態、`lint:type-literals`、UI の癖、言葉。2) 盲検 panel: 未実施。3) golden: `task-dock/04b-conversation`、`04c-conversation-ending`、`01b-quick-actions`（「会話」を足した）。

## 結果

採用: B。

- 04b-conversation / 04c-conversation-ending 600×160（会話の 1 行ぶん伸びる）。01b-quick-actions 560×68（項目 4。「関連操作」は撮るときの前面アプリで出る・出ないが変わる）。
- 会話の 1 行が出ても高さが変わらない誤りを先に防いだ: 高さの測定の鍵に会話の状態を入れ、出る・消えるで `syncDockPanels` を呼ぶ。
- 実マイク・実スピーカーでの自己割り込み（Genie の声が自分のマイクに入るか）は未測定。半二重（考え中・読み上げ中はマイクを閉じる）で避けている。段階 3（Audio Runtime・エコー除去）で測る。

## 段階 3〜5 の追記（2026-09-27）

- 起動音: マイクの最初のフレームが届いてから 1 回だけ（macOS 同梱の Pop。生成・通信なし）。古い世代のフレーム・2 ターン目では鳴らない（`ConversationLoopTests`）。
- 読み上げ停止（会話は続けて次を聞く）と「会話を終了」（声だけ止める。仕事は取り消さない）を別の操作にした。
- エコー除去: 会話のマイクだけ AVAudioEngine の voice processing を頼む。効かなければ従来の取り込みに戻す。会議の録音には使わない。切り替えは engine を止めて初期化を解いてから（prepare 済みだと -10849）。
- 実測 `--selftest selfecho`（実スピーカー・実マイク・実音声認識）: **判定できない（SKIP）**。除去なしの対照が読み上げを 1 文字も拾わなかった。この Mac の出力音量が 6% で、スピーカーの声がマイクに届いていない。対照が拾えないときに PASS と名乗らないよう、検査は SKIP を返す。音量を上げた状態で測り直す。
- 会話の提供元（`ConversationProvider`）: いまの経路を `PipelineConversationProvider` として包んだ（Local とは呼ばない）。割り込み・外部送信・外部合成・応答なしを `capabilities` で宣言する。Gemini Live は未実装（本人の同意・API キー・予算の上限が要る）。
- 追加指示（段階 5）: 「あと／それと／それから／ついでに／追加で、」で始まり、直前の仕事が動いている間だけ、その仕事への追加指示（`POST /v1/tasks/:id/instructions`）。受け取った（RECEIVED）と反映した（APPLIED・段）を分け、間に合わなければ NOT_APPLIED、終わった仕事は 409。
