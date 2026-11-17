# 無効な委任確認ボタンの状態を見えるようにする — 2026-10-02

reference : [DESIGN.md §1・§6](../../../../shared/design/DESIGN.md) の Action Confirmation の主操作と既存造形維持、[world-class-ui](../../../../.agents/skills/world-class-ui/SKILL.md) の状態と実操作の一致。独立レビューで invalid 入力の主ボタンが valid と同じ赤＋白に見えることを確認（2026-10-02）。
hypothesis: 無効時だけ既存 neutral の塗りと muted 文字へ変えれば、押しても進めない状態を見た目で判別できる。赤い有効状態、ラベル、32pt高さ・96pt最小幅・7pt角丸、配置と警告本文を変えない。
measured  : 保存済み明暗の valid/invalid はともに560×340pt（1120×680px）。ボタン下部50pxの主要色・画素数は一致（light RGB165/50/36が6314px、dark238/124/113が6312px）。現在 .disabled は入力を拒否するが GenieControlStyle は isEnabled を読まず、ラベルの白と riskTint の塗りが固定。
candidates: A=赤＋白を維持、B=無効時だけ Palette.muted（light #667085 / dark #98A2B3）＋Palette.border（#E6E8EC / #2B3038）、C=surface塗り（light #FFFFFF はfixtureの白背景と同色なので選ばない）。Bを対象にする。全画面の共通ButtonStyleやtoken値は変更しない。
gate      : actual ConfirmationDock の valid/invalid×明暗4面を再描画し全画像を開く→ボタン内だけ色差、実寸・本文・当たり範囲不変をgeometryで確認→invalidの同一action入口で送信0件、valid復帰で有効に戻ることを確認→独立レビュー→VoiceHUD source SHAのreviewを理由付き更新。最終package・macOS27 profileの採取に含め、閾値は変更しない。

採用前の画像は `docs/quality/evidence/2026-10-02-completion/confirmation-disabled-before/` に保存する。これは新しい確認画面の造形ではなく、既存の無効状態の表示修正。通常の『今回だけ』と有効な委任は既存表示のまま。

## 検証結果

Bを採用。actual ConfirmationDock の4画像を実描画して開いた。valid明暗は保存済みbeforeとSHA/画素が同一。invalid明暗は変更矩形がともに `(722,584)-(1080,648)px`、つまり主ボタンの179×32ptだけ。本文・配置・全geometryは同一。測定値とhashは [comparison JSON](../../../quality/evidence/2026-10-02-completion/confirmation-disabled-comparison.json) に保存した。

対象 Swift **2/2 PASS、0 skip**。invalidの実際の表示ボタンに登録された同一actionを、arm待機後にUIProbeから呼んでも送信0件・frozenBody無し・submitメッセージ無しだった。入力を直すとspecが有効に戻る。UIProbeは物理マウスクリックやOSのAX disabled属性の実測ではない。既存の `.disabled` を維持し、同じ条件をaction guardと表示にも使う。通信不明のfrozen retryは既存どおり無効にしない。

`/root/verification_audit` が新4画像と旧invalid明暗2枚・geometry・sourceを独立確認し、無効な灰色状態と有効な赤色状態の区別、説明とラベルの全文可読、寸法・位置維持を確認した。追加finding無し。VoiceHUDのreview SHAはこの限定差分を理由付きで更新し、UI_TASTE_OK（長文actual10-reviewed4=6、既存上限6）を維持した。
