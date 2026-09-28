# TaskDock 1b「形と動き」— 印で存在を示す — 2026-09-28

本人が渡したパッチ（`ランディングページ全体改修案.zip` の `patch-genie-app/`、`Genie App UI 改修案.dc.html` の 1b）を反映した。
パッチは HEAD（c57f458）の `VoiceHUDView.swift` から作られていて、差分はパッチ自身の変更だけ（38 行）だった。

reference : 本人の改修案 1b（Genie App UI 改修案）。球（GenieOrb）ではなくブランドの印で存在を示し、動くのは印だけ。
hypothesis: 聞く・作業するときだけ印の中に青（presence）が出て、待機・確認・失敗・完了後は静止すれば、「呼ぶと応える / 任せた仕事が見える」を装飾を増やさずに示せる。紫のアクセント（押せる・選んでいる）と、いま動いている Genie（presence）が別の色になる。
measured  : 前: Listening / Thinking / Agent の見出しは GenieOrb（紫の球、72pt 以下の小型）。作業中の進行帯・実行中の段・会話の波形は accent（紫）。待機の印は紫。`before-*.png`。
candidates: A = いま / B = 1b（印 + presence の青、Listening は輪郭が入力で伸縮、作業中は印の内側と Dock 下辺を流れ、受付・完了で一度だけ反応）（採用: 本人の指定）/ C = 1c の素材（真鍮の印・青い気配）（パッチで不採用）
gate      : 1) 機械: build、swift test 240、UI の癖（gradient 4/4・Capsule 20/20、VoiceHUDView の再確認）、言葉・承認境界・送信・権限の gate、`--selftest dock8` 明暗 25 状態。2) 盲検: 未実施。3) golden: task-dock を撮り直し（明暗 8 状態ずつ変わった）。

## 結果

採用: B（パッチどおり）。

- 新規 `Components/GeniePresenceMark.swift`（`GeniePresenceMark`、`DockFlowLine`）。Reduce Motion で静止、`--selftest` で時間を止める（golden を再現できる）。動くのは listening / working のときだけで、待機中に連続描画しない。
- tokens: `color.presence`（light `#1C7FA8` / dark `#48BCEC`）、`animation.markStretchMs 220`・`markAckMs 320`。`pnpm gen:design-tokens` で `GeneratedMetrics.swift` / `.cs` を生成した（手で写していない）。
- 触っていない: 確認（Action Confirmation、DESIGN.md で完了扱い）、Home・Library・録音面の紫、面の寸法と変形の時間。
- 反映の途中で見つけた検査の誤り: `dock8` の `06-agent` は、段階 ①（One Continuous Surface）から「考えています…」を撮っていた（考え中が動いている仕事より前に出る優先順のため。撮影では答えが来ない）。撮影の順で待機へ戻してから仕事を始めるように直し、正しい作業中の面を撮り直した。

## 測っていないこと

- 実機で動いている姿（印の伸縮・流れ・一度だけの反応）。撮影は時間を止めた静止画。
- Liquid Glass の外殻の上での青の見え方（明るい・込み入った背景）。GPU 負荷。
- 聞く状態の輪郭は `inputLevel`（peak）をそのまま使う。実マイクで振れ幅が小さければ、波形と同じく平方根で広げる（パッチの注記どおり、未調整）。
- 盲検 panel。`verify-all`（本人が Mac を使っている間は、画面を占める検査を回さない）。
