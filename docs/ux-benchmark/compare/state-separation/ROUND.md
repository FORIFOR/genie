# 段階 1: 会話・仕事・表示の分離 — 2026-09-27

reference : Apple Human Interface Guidelines — Feedback (https://developer.apple.com/design/human-interface-guidelines/feedback, 2026-09-27)。操作の結果は、何が起きたかが分かる形で返し、入力を黙って捨てない。
hypothesis: 前の依頼に答えている間に話すと、`ask()` が黙って false を返し、Dock はマイクの閉じた Listening のまま残って発話が消える。考え中の面（ThinkingDock）に「未送信」の 1 行を足し、次の Listening で入力欄へ戻せば、発話は失われず、勝手にも送られない。
measured  : 考え中の面 560×100（safe-top 32 を含む窓）。字は dockType primary 16 / meta 13。未送信の行は無い（発話は消える）。
candidates: A = いま（消える） / B = 考え中の面に meta 13・muted の 1 行（最大 2 行）を足し、次の Listening で入力欄に戻す / C = 列に並べて答えのあと自動で送る（1 つ目の答えが考え中の面に隠れるので不採用）
gate      : 1) 機械: `StateSeparationTests`（元の実装に戻すと 3 か所で落ちることを確認済み）、`--selftest state`、`--selftest dock8` 23 状態、`lint:type-literals`、UI の癖。2) 盲検 panel: 未実施（字の段・色・面は既存の値のまま、1 行の有無だけ）。3) golden: `task-dock/05b-thinking-held.png` を追加。

## 結果

採用: B。

- 05b-thinking-held 560×122（未送信の行 1 行ぶん伸びる。高さは中身で決まる）。05-thinking は変更前と画素差 0。
- 最初の撮影で行が切れていた（560×100 のまま）。高さの測定の鍵に `heldUtterance` が入っておらず、前の高さを使い回していた。鍵に入れ、行の増減で `syncDockPanels` を呼ぶよう直した。
- 表示は活動状態を決めない: `GenieStateStore.activity(showing:)` が 確認待ち → 会議 → 聞き取り・考え中 → 動いている仕事 → 表示 の順に決める。回答を出しても、動いている仕事は「完了」にならない。
- 聞き取りの世代（`VoiceGeneration`）: 閉じた後に遅れて届いた確定文では依頼を送らない。Esc は表示に関わらずマイクを閉じる。

## 追記（2026-09-27）: 預かった発話が測った瞬間に消えていた

- ListeningDock の onAppear が預かり（heldUtterance）を取り出していた。面の高さを測る `DockContentMeasure` は
  同じ ListeningDock を画面の外で組み立てるので、聞いている最中に預かると、測った瞬間に onAppear が走って
  預かりが消え、「未送信」の行も消えた。dock8 の 05b が 560x100（行なし）で撮れず見つかった。
- 直し: 預かりを入力欄へ戻すのは状態の側（`beginListening` → `listeningPrefill`）。面は読むだけ。
- 検査: 単体テストでは再現しない（窓に載らない NSHostingView では onAppear が走らない）ので置かない。
  実窓で撮る `--selftest dock8` の 05b（聞いている姿から預かる、本番と同じ順）が、元の実装で落ちることを確かめた。
