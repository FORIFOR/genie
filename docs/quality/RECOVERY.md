# 未達項目の追加改善と検証 — 2026-09-19

今回、応答喪失からの復帰、初回の成果物編集、生成ファイル整合、旧workflow履歴の再生を修正・実行検証し、対象条件をPASSにした。**製品全体のリリース判定はBLOCKED**。未実施の実機・実ユーザー試験をPASSにはしていない。

対象は `28f89f2636a3b780e813ea902e07d2e4900a6e3f` を基点とする未コミットの作業ツリー。最終ファイルSHA256は [source-manifest.json](evidence/2026-09-19-recovery/source-manifest.json)。過去の [RESULTS](RESULTS.md) / [FOLLOWUP](FOLLOWUP.md) は各時点の記録として保持する。合格条件は実装前の [acceptance](acceptance.md) に固定した。ローカル変更のみ。既存のユーザー変更6ファイルを保護し、外部送信・公開・課金・commitは行っていない。

## 改善した動作

- 会話の送信前にUUIDの受付識別子を永続化する。実行層が同じ利用者・会話・識別子の重複を防ぎ、同じキーで異なる入力は409とする。応答喪失時はGETで元の受付・タスクを照会し、再送しない。
- Macの「状況を確認」が、タスクIDをまだ受け取れていない依頼でも保存済み受付を使える。作業詳細を開いた際の照会も読み取り専用。pendingや見つからない受付を完了表示にしない。
- 実機で発見した「最初の編集だけ本文が空になる」問題を修正。編集対象をsheetのidentityとして渡し、編集画面自身が本文と保存エラーを保持する。元の生成結果は残す。
- サービス間のDB直接参照をTaskServiceの読み取り契約に置き換え、生成ヘッダーの末尾空白を生成スクリプトで正規化。語彙検査は「リリースノート」だけを正しく扱い、禁止語の検査を維持した。
- README、導入・デモ・SDK例・互換性説明を更新。新しいDB migrationを先に適用する順序と、旧クライアント・旧サーバーの制約を [INTEGRATION](../INTEGRATION.md) に明記した。

## 測定環境・方法

macOS 26.6.2 arm64、ネイティブSwiftUIアプリ、ローカルOllama `qwen3.5:9b`。主要タスクはメモ3件から担当未定を保持したMarkdownチェックリストを作成・編集・保存すること。専用データディレクトリ、隔離したPostgreSQL/Temporal/Gateway、架空入力を使用した。端末・ツール版は [環境](evidence/2026-09-19-recovery/gates-environment.json)。コマンド、所要時間、exit codeは [commands.jsonl](evidence/2026-09-19-recovery/commands.jsonl)、[独立ゲートのcommands](evidence/2026-09-19-recovery/gates-commands.jsonl)、[backend manifest](evidence/2026-09-19-recovery/backend-manifest.json) に記録した。

モデル実行の通信はloopbackだけ。ポート43150の試験proxyが43149のgatewayから受付済み応答を受信した後に、そのPOST応答だけを切断した。自動試験はunknownを観測してからGET照会する。GUI試験では詳細画面のonAppear照会が復帰を行ったため、手動で確認ボタンを押した証拠とはしていない。receipt取得はタスク完了ではなく、続く状態・成果物取得まで確認した。

## 最終判定

| 条件 | 判定 | 期待結果・観測・証拠 |
|---|---|---|
| R1 重複防止・権限 | PASS | 実DB/RLSとHTTPで同時予約20件の勝者1件、重複POSTのタスク1件、入力変更409、他tenant/owner404。新規9件＋既存7件、exit0。[backend](evidence/2026-09-19-recovery/backend.md) |
| R2 応答喪失の照会 | PASS | POST応答を破棄後GETが元のIDを返す。pending、clarification、task確定前後の窓を検証。Rust実TCP2件、SDK32件、exit0。[独立検証](evidence/2026-09-19-recovery/recovery-independent-review.md) |
| R3 Macの実行・復帰 | PASS | 実ローカルモデルでunknown→照会→成果物。自動試験exit0、11.63秒。GUIも元のtask IDで復帰し、対象会話へのPOSTは1回。[自動実行](evidence/2026-09-19-recovery/native-recovery.log)、[GUI HTTP](evidence/2026-09-19-recovery/native-gui-http.json) |
| A4 初回編集・長文保存 | PASS | 最終修正後の新規プロセスで初回編集欄に元の3行を表示。日本語・絵文字の300行を編集し、保存・書き出し・別プロセス再表示で一致。元の本文を保持。[照合](evidence/2026-09-19-recovery/native-gui-comparison.json)、[成果物](evidence/2026-09-19-recovery/long-recovered.md)、[再表示exit0](evidence/2026-09-19-recovery/native-long-reopen.log) |
| R4 旧workflow互換 | PASS | 変更前HEADのworkflowで実Temporal履歴を取得し、現在のworkerで完了・取消2履歴をreplay、exit0。ローカルfixture activitiesであり運用履歴ではない。[replay](evidence/2026-09-19-recovery/replay-review.md) |
| A9 build/typecheck/tests | PASS | TypeScript build/typecheck、Swift build・配布形式app build/署名検証・162テスト、SDK32テストがexit0。現revisionのworkspaceは1888 passed /465 skipped、exit0。skip465件をPASSに含めない。[コマンド](evidence/2026-09-19-recovery/commands.jsonl) |
| R5 生成物・境界・静的ゲート | PASS | 別の空DBでSQL/型を再生成して一致、UniFFI再生成一致、サービス所有権・語彙・UI gateが修正後exit0。語彙検査の5例で禁止語の検知も維持。[独立ゲート](evidence/2026-09-19-recovery/gates-review.md) |
| 既存レイアウト | PASS | native fixture32画面、940/1162pt・明暗。既存geometry基準6状態の差2pt以内、exit0。基準変更なし。[goldenとgeometry](../golden-screenshots/quality-recovery-20260919/README.md) |
| キーボード・フォーカス・長文・native Large | PASS | 実GUIで編集フォーカス、全選択・貼り付け、Save Panelのキーボード移動、末尾300行、保存/取消を観測。Large設定で見出し折返しと操作を確認して元に戻した。下記GUI観測記録。これは全アクセシビリティ適合の判定ではない |
| Windows runtime / 最小macOS14 | BLOCKED | 当該OS実機/VMなし。C# compileとXAML5件はPASSだが、Mac上で代用しない |
| 日本語IME・VoiceOver・OS reduced motion | BLOCKED | IME切替後の実キー入力はLatinのnihongoとなり変換を観測できなかった。日本語貼り付けはIME証拠にしない。VoiceOver/reduced motionの実操作も未実施 |
| full verify-all / live provider・音声 | BLOCKED | 集約スクリプトには固定localhost:3000への書込み、マイク/システム音声/権限・アカウント依存があり、この隔離環境では実施していない。外部送信は未許可。静的ゲートの成功から全体成功を推定しない |
| 本番運用履歴のreplay | BLOCKED | 運用履歴未提供。実Temporalで採取した旧コードのローカル履歴とは区別する |
| 実ユーザー初回成功率・他製品との同条件比較 | BLOCKED | 参加者、競合サービス利用・送信許可なし。AIの独立レビューは実ユーザー評価ではない |
| Webスマホ幅・200% browser zoom | NOT_APPLICABLE | 今回の主要タスクはnative Mac。Large設定は200%の代替試験ではない |

## GUI観測と成果物の照合

CUAで `/tmp/GenieRecovery-20260919.app` を操作した。独自bundle ID、専用SQLiteを使用し、ユーザーの普段のアプリデータは使っていない。初期の仮bundleはSparkle rpath不足でexit -6となったため、試験bundleを修正して再実行した。製品のpackaging scriptは既に同梱rpathを設定する。失敗ログも保持している。

初回編集が空の症状を再現後、単純なonAppear代入では解決しなかった。最終的なsheet(item:)と独立editor stateで、新規プロセスの最初の編集に元の全3行が表示された。画面上のSave/Cancel、長文末尾、保存結果をAX/スクリーンショット表示で確認した。実GUIのスクリーンショットはツールで確認したもので、保存済みPNG証拠とはしていない。golden PNGは別途fixtureとして明示している。

編集本文は11,063 Unicode codepoints。書出し30,752 bytes、SHA256 `19caa11f9e2eb4b4daf9946eeec1200b0a0b38aff70b84c3eeb17a51182dd72f`。SQLiteをread-onlyで照合し、保存記録1件、元本文不変、受付UUID保存、同一backend ID、本文/書出し一致を確認した。別プロセスのreopenもexit0。さらに配布形式のrelease appをビルドして同じ保存内容を開き、exit0と[書出しバイト一致](evidence/2026-09-19-recovery/final-artifact-comparison.json)を確認した。コピー/書出しを成功と扱う際は実ファイルで照合した。

## 残る契約上の限界

receiptは無制限のexactly-once実行保証ではない。予約直後でtask未作成のクラッシュはpendingのまま。task DB作成とruntime dispatchの間のクラッシュではIDを照会できても処理開始を保証しない。GETはこれを勝手にdispatchしない。旧記録のキー無し依頼、nativeの直接consumer-task分岐、外部providerの不明な副作用は対象外。SDKのreceipt decoderは現在reply metadataを公開しない。互換性・migration・custom gateway adapterはINTEGRATIONに記載した。

独立した別エージェントが実装と分離してreceipt/権限/再生/ゲートを検証した。同じAIモデルによる技術検証であり、人間の好み・初心者成功率の代用ではない。導入済みskillsの利用・由来は既存FOLLOWUPの記録を継承し、この回はcontract-first-build / outcome-first-ux / world-class-uiの該当する機能改善・実画面検証と、独立側のindependent-product-verificationを適用した。数値や期待値を緩めてPASSにした項目はない。

試験用launcherは管理サービスを停止してexit0、隔離receipt DBコンテナを削除した。保存済み成果物とpreviewデータは保持した。loopback proxyは検証終了後にSIGTERMで停止したため、そのログのexit -15は後片付けを表す。
