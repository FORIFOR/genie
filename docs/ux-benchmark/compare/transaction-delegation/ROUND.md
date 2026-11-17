reference: Genie の既存 ConfirmationDock / Settings の段階的開示と native Picker。Apple・Linear 由来の既存設計を使い、新たな外部寸法は採用しない。
hypothesis: 既定を「今回だけ」にし、本人が「同じ条件で任せる」を選んだときだけ固定条件・予算・回数・期限を示せば、毎回の判断を減らしながら範囲を理解して取消できる。
measured: 変更前は注文ごとの確認カードのみ。幅560pt・高さ上限360pt、下見スクロール66pt、設定は460pt。委任の実測は実装後に geometry と golden で記録する。
candidates: 常時全条件を増設する案は不採用。既存確認面の中を切り替え、設定の一覧で残量と取消を扱う案を採用候補とする。別ブランドや新たな装飾は加えない。
gate: 今回だけが初期値・明示選択なしの作成0・固定条件と全制限が読める・条件変更時は再確認・取消の再読込反映・確認面360pt以内・Swift契約試験/承認境界/実画面操作。模擬のみで実注文は未対応と示す。

2026-10-02 verification supplement: 造形・文言の変更なし。既存goldenはスクロール上部のみで、予約量・入力条件・取消境界の長文そのものは未確認だった。実viewの本文末尾/無効入力/管理一覧をlight・darkで追加描画し、560×340pt（本文160pt）/560×460pt内で3つの全文を確認した。画像とgeometryは `docs/golden-screenshots/disclosure-copy`、失敗からのfixture修正・本文hash限定reviewは `docs/quality/evidence/2026-10-02-completion/UI_TASTE_REVIEW.md`。これは表示検証の補足であり、範囲の拡張や実注文の承認ではない。
