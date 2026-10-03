# Gemini 3.8 Live で自然な会話へ — 2026-09-29

本人が貼った設計案（「Gemini のネイティブ音声対話 ＋ 端末側の音声制御 ＋ 非同期の実行バックエンド」）を、公式の説明と照らして反映した。

## 公式で確かめたこと（2026-09-29）

- モデル ID は `gemini-3.8-live`。`thinking_config`・`enable_affective_dialog` は入れない。proactive audio は常に有効で `proactive_audio: false` はエラー。非同期の関数呼び出し（`NON_BLOCKING`）が既定（ai.google.dev/gemini-api/docs/models/gemini-3.8-live）。
- 入力 16 kHz・16bit・little-endian PCM、出力 24 kHz。話し終わりの判定は 500〜800ms を推奨。`interrupted` では再生中と再生待ちの声を捨てる。言語は指示で決める（language code は使えない）（live-api/capabilities）。
- 接続は約 10 分。音声だけの会話は圧縮なしで 15 分。`sessionResumptionUpdate` の鍵は切れてから 2 時間有効。`goAway` に残り時間（live-api/session-management）。
- `behavior: "NON_BLOCKING"` は関数の宣言に、`scheduling`（`WHEN_IDLE` 等）は `response` の中（live-api/tools）。

## 入れたこと

- setup: 自動の区切り（`silenceDurationMs 650`・`prefixPaddingMs 200`・`END_SENSITIVITY_LOW`）、`START_OF_ACTIVITY_INTERRUPTS`、`sessionResumption`（鍵があれば渡す）、`contextWindowCompression.slidingWindow`、道具は `NON_BLOCKING`、受付は `WHEN_IDLE`。禁止の設定が入らないことを単体テストで確かめる。
- 指示: 役割・話し方・会話・正確さと実行に分けた日本語の指示（設計案の文を元に、Genie の delegate_task の約束を足した）。
- 答えの声を**届いた順にすぐ流す**（以前は turnComplete まで溜めて一度に流していた）。読み上げの合図では流し終えるのを待つだけ。
- `interrupted`: 再生中・再生待ちの声を捨て、世代を進めて遅れた古い声も流さない。
- 接続が切れた・`goAway`: 再開の鍵で同じ会話へつなぎ直す（最大 3 回）。準備が済むまでマイクの声は送らない。鍵が無いときだけ会話を終える。
- 検査: `tools/gemini-fake/server.mjs`（偽の Gemini。本物の API もキーも使わない）と `--selftest geminiresume`。実アプリで: 流し始めが turnComplete の 1.19 秒前、割り込みで待ちの声 2 片を捨てた、goAway の後に鍵 h1 でつなぎ直して会話が続いた、禁止の設定なし。
- 送信の検査（privacy egress）: 偽の Gemini へは `GeminiLiveProvider.forLocalFake`（127.0.0.1 / localhost だけ）でしかつなげない。差し替え先は private でループバックだけ、を検査に足した（壊すと落ちることを確認）。

## まだのこと（本人の Mac と声が要る）

- **全二重（Genie が話している間も聞く）**: エコー除去が要る。この Mac では以前、AVAudioEngine の voice processing を入れたマイクが完全な無音を返した（micprobe: 0.000）。設計案どおり、マイクと再生を同じ engine に載せて voice processing を効かせる形を試し、実機で「内蔵スピーカー＋内蔵マイク」で確かめてからでないと入れない。それまでは半二重のまま（話している間はマイクを閉じる）。
- 本物の Gemini 3.8 Live での通し: API キーがキーチェーンに無い（本人が設定の「会話（Gemini Live）」に入れる）。入れたら `--selftest geminismoke`（本物・上限内）で確かめる。
- 声の選択（`speechConfig`）: 設計案の `Kore` は仮の声なので入れていない（既定の声）。日本語で聞き比べてから決める。
- 応答の速さ（話し終わりから意味のある返答が聞こえるまで）・割り込みから停止までの時間の実測。
- 短命トークン（配布するときはキーをサーバーに置く）: 本人の Mac ではキーチェーンのキーを使う。
