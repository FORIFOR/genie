# Info card（天気・ニュース） — 2026-09-27

DESIGN.md §6「新しい画面・新しい機能」の例外として、本人が 2026-09-27 に承認した。
新しい窓は作らない。既存の回答面（`AnswerDock`、幅 `voiceHud.resultWidth` 520）と同じ面・同じ幅で、中身だけを種類別の段にする。

reference : Apple Weather widget (https://support.apple.com/guide/iphone/check-the-weather-iph2261b0e1c/ios, 2026-09-27) — 地名・天気・最高/最低を 1 つの塊で先に出し、日ごとの予報は横に並べる。Apple News widget — 見出しと媒体名・時刻の 2 段を縦に並べ、本文は出さない。
hypothesis: 回答面の本文 1 段（`Text(text)` 15pt、`maxHeight 82` の scroll）に予報や見出しを文で流すと、数値（最高/最低/降水確率）と見出しの境目が読めず、82pt で切れて 4 件目以降が見えない。種類ごとの段（天気: 地名+絵+温度の塊、日ごとの列 / ニュース: 見出し 15 + 媒体・時刻 13 の 2 段）に分けると、面の高さは中身の実寸のまま情報が読める。
measured  : 現状の回答面 520 × 中身実寸（本文 maxHeight 82 で scroll、`DockContentMeasure`）。字は dockType の title 20 / row 15 / meta 13 / label 11。縁 padH 20 / padV 16（DS-03）。天気 1 日の文は 1 行 38〜45 字、ニュース 3 件の文は 520 幅で 4〜5 行になり 82 を超える。
candidates: A = いま（文だけ、回答面の本文 1 段） / B = 種類別の段（同じ 520 幅、dockType の段だけ、新しい色・影・角丸なし、高さは実寸で上限 `voiceHud.infoMaxHeight` 360 = 確認面と同じ上限） / C = B に日ごとの横並びを付けず縦の行だけ
gate      : 1) 機械: `pnpm lint:type-literals`、`--selftest occupation` の上限（520 × 360）、swift test（decode と文へのフォールバック）。2) 盲検 panel: 未実施（下に記録）。3) golden: `docs/golden-screenshots` に回答面の天気・ニュースを追加し、既存面の差分が無いことを確かめる。

## 結果

採用: B（種類別の段）。

- 機械: `pnpm lint:type-literals` TYPE_LITERALS_OK、`--selftest occupation` 7 面 PASS、`InfoCardTests` 5 件（decode・文へのフォールバック・未知 schema は文のまま・幅 520 と上限 360）PASS、swift test 169 件 PASS。
- `--selftest dock8`（light / dark）22 状態 PASS。新しい 3 状態の実寸: 06e 天気 4 日 520×216、06g 天気 1 日 520×171、06f ニュース 3 件 520×268（いずれも safe-top 32 を含む窓の高さ。上限 360 以内）。top anchor 固定・窓 1 枚。
- golden: `task-dock/` と `task-dock/dark/` に 06e / 06f / 06g を追加した。**既存の 18 枚は上書きしていない。** この Mac（macOS 26.6.2 より新しい OS、safe-top 32）で撮ると、既存の全状態が golden から 2〜19% ずれる（listening +47pt / thinking +49pt など）。これは今回の変更の前からある未コミットの作業とノッチ対応によるもので、今回の差分ではない。まとめて書き換えると無関係の変化を承認することになるので、別の round で扱う。
- geometry: この OS 用の基準（`environments/macos-<この版>-2x-safe-top-32/geometry`）が無く、`--selftest geometry` は「基準が無い」で FAIL。今回の前から同じ。基準の記録は本人の承認を得てから。
- 盲検 panel: **未実施。** A（文だけ）と B の比較は、見出しと数値の区切りという構造の差で、面積・字の段・色・影は既存の値から動かしていない。

