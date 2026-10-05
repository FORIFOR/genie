# 2026-09-19 — Skills導入と終端状態の追加改善

これは追加改善時点の記録です。受付応答喪失・旧revision replay・生成物検査の後続修正は [RECOVERY.md](RECOVERY.md) を参照してください。

判定: **FAIL（リリース条件全体は未達）**。今回は前回の「取消/完了競合」に対象を絞った。UIの造形・主要フローは維持し、状態の根拠となる実行層を修正した。受付応答喪失からの照合は引き続き未実装。

## Skillsと依頼の扱い

ユーザー提供の `/Users/shuhei/Downloads/oss-quality-kit/` から、レビューしたローカル導入スクリプトで5つを `.agents/skills/` へ追加した。既存のAGENTS.mdやSkillを上書きせず、通信・依存ダウンロードなし。添付マスタープロンプトは改善方針の参考であり、公開・外部送信などの追加許可としては扱っていない。

`skill-installer`で導入方法を確認し、`oss-standard-audit` → `outcome-first-ux` → `contract-first-build`を今回の範囲で適用。別担当が`independent-product-verification`でDB試験とコードレビューを実施。`world-class-ui`は導入・内容確認済みだが、この追加ラウンドではUI変更がなく、UI設計・仕上げ工程を実行したとは扱わない。Skillsの自動検出は次のターンから利用可能。今回はファイルを直接読んで適用した。

キットは独自テンプレートと記載され、明示的なライセンスファイルは含まれていない。ユーザーが依頼したローカル導入の範囲で保持し、GenieのMITがキットの再配布許諾を与えるとは主張しない。[導入元と13ファイルのハッシュ](evidence/2026-09-19-followup/installed-skills.json)。

## 監査と修正前後

| 主張 / 対象 | 修正前の根拠 | 追加改善 |
|---|---|---|
| 完了表示は実際の完了に一致する | `completeTask`はDB更新0件でも完了イベントを発行し、workflowは完了を返していた | 実際に更新した場合だけイベント発行。workflowは永続化された状態と成果物IDを返す |
| 取消で完了済みの仕事を戻さない | `TaskService.cancel`の読取と更新の間に完了が割り込めた | 行ロックの内側で終端状態を確認し、終端なら既存の`task.invalid_state`エラー |
| 再試行で終端通知を増やさない | 取消の再試行で時刻・監査ログが変化し得た。失敗後にも異なる終端イベントを発行し得た | 条件付き更新の結果を検査し、確定済みの状態を保持。更新なしならイベント・取消監査を追加しない。独立レビューで発見した遅いstart/host-pauseによる取消状態の上書きも防止 |
| 古い実行との互換性 | Temporalの履歴は決定的なコマンド順が必要 | `task-terminal-outcome-v1`のpatch分岐で旧経路を保持。実履歴replayは未検証 |

最小の境界は既存のTask状態・DBトランザクション・イベント。新しい外部API、状態enum、テーブル、プロトコルは追加していない。Coreの状態処理をUI/SDKへ複製していない。取消は外部処理の巻き戻しではなく、組み立て済みの成果物がLibraryに残る場合がある。

UIの変更がないため新たな見た目の優劣は判定しない。前回のmacOS実機での生成・編集・保存の証拠は[初回結果](RESULTS.md)のrevisionに対するもの。この追加変更でGUI・IME・競合製品比較を再実行したとは主張しない。

## 判定と証拠

測定対象: `28f89f2636a3b780e813ea902e07d2e4900a6e3f`＋未コミット変更。環境: Apple silicon/macOS26.6.2、Node26.5.0、pnpm10.12.2。追加試験は架空のタスク・ローカルPostgreSQL16・実Temporalおよびmock workflow境界で、外部モデルや利用者データを使わない。最終ソース識別は[source-manifest.json](evidence/2026-09-19-followup/source-manifest.json)。

| 条件 | 判定 | 観測 |
|---|---|---|
| F1 Skills導入 | PASS | 同梱SHA256SUMS一致、導入後13ファイル一致、形式検査と導入器19テストexit0 |
| F2 workflow境界の取消・復帰 | PASS | 修正前5件中4件FAIL → 修正後5件PASS。composition中の取消、signal到達前のCANCELLING、確定済み成果物ID、遅い取消、旧patch経路 |
| F3 DB競合・終端イベント | PASS | PostgreSQL16.15＋Temporal CLI1.8.3/server1.31.2で24件PASS（既存E2E15＋追加9）。行ロック待ちを観測する競合試験、終端の再配達、テナント分離、遅い開始/一時停止を検査。実workflowでcomposition中の取消通知あり/通知喪失の2ケースを実行し、成果物の保存・DB・event・workflow結果を照合 |
| F4 build・typecheck | PASS | どちらもexit0。task関連69件PASS。DB/Temporalを外した回のskipは合格扱いしない。DB検査は別ログ |
| 実Temporalでの取消処理 | PASS | キャッシュ済みバイナリを明示し、隔離DBとloopbackで起動。外部ツールはfixture/障害注入であり、外部サービス成功の証拠ではない |
| 過去の本番履歴replay | BLOCKED | 旧patch経路の単体試験は実履歴replayの代用にならない |
| 新規UIの視覚検査 | NOT_APPLICABLE | この追加変更にUI差分なし。前回の未検証アクセシビリティ項目はBLOCKEDのまま |
| 受付応答喪失からの照合 | FAIL | conversation turnの一意な受付IDと照会契約が未実装。無条件再送は追加していない |
| 製品全体・初見ユーザー・最低OS・Windows | BLOCKED | 前回記録した環境/参加者不足と全体ゲート未完了を維持 |

実行コマンド・exit code・出力: [commands.jsonl](evidence/2026-09-19-followup/commands.jsonl)と同じディレクトリのログ。途中のtypecheckは作成中の追加試験の型不足でexit2だったが、必要なDbConfig/step_indexを補い再実行でexit0。修正前の失敗ログも保持した。独立担当の実DB/Temporalコマンド・環境・終了コードは[独立検証記録](evidence/2026-09-19-followup/independent-review.md)。既存ユーザー変更6ファイルのSHA-256一致を再確認し、前回改善の変更も保持した。

変更箇所: `.agents/skills`、task serviceのworkflow/activity契約・状態更新・対応試験、README、組み込み契約、品質文書。[互換性と取消契約](../INTEGRATION.md)。DB migration不要。push・commit・merge・公開・デプロイは行っていない。
