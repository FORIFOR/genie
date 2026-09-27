# 2026-09-19 — 最初の成果物と組み込み契約

この記録は初回改善時点の証拠です。その後のSkills導入・取消競合修正は [FOLLOWUP.md](FOLLOWUP.md) を参照してください。

判定: **FAIL（製品全体のリリース合格には未達）**。選定したローカル文章作成・編集・保存フローは実行確認できたが、受付不明の照合と取消競合が残る。公開・push・merge・デプロイは行っていない。

対象: `28f89f2636a3b780e813ea902e07d2e4900a6e3f` に今回のローカル変更を加えた候補。最終ファイルのSHA-256は `evidence/2026-09-19/source-manifest.json`。既存のcomputer vision関連6ファイルは編集せず、開始時と終了時のハッシュ一致を確認した。

環境: Apple silicon / macOS 26.6.2 (25G83)、Node 26.5.0、pnpm 10.12.2、XcodeのSwift。隔離Gateway `127.0.0.1:43139`、隔離Dockerプロジェクト、Ollama `127.0.0.1:11434` の `qwen3.5:9b`。モデル名が同じでも性能や出力の再現性は保証しない。macOS 14での動作はこのMacから推定しない。

## 3ラウンドの変更

1. 合格条件を先に記録。ユーザーの権利保有確認・採用許可に基づきMITを追加。導入をmanaged/manualに区別し、同じ表示バージョンだけでは互換性を保証できないことを明記。Core/Adapter/UIは既存構成を維持。
2. Homeに完成した編集可能なサンプルと成果物の説明、送信先/料金の開示を追加。Workにローカル編集・保存・キャンセルを追加し、元の生成文は保持。保存失敗はメモリに結果を残して警告し、同じデータの保存だけを再試行。SDKのSSEは標準的な改行・複数data行・任意バイト分割を処理し、同期ハンドラーの失敗を受信済みにしない。SDK例と契約を文書化。
3. 独立AIレビューで編集後の検索と要約が旧本文を参照する問題を発見し修正。MacパッケージのSparkle未同梱を修正し、ビルド・署名・実行を確認。実機で編集・書き出し・空文書拒否・再表示を確認し、ファイルとDBを照合。

指定された4つのSkillはインストール先に見つからず、未使用。独立レビューは別のサブエージェントによる読み取り専用コードレビューで、`independent-product-verification` Skillの実行でも実ユーザー評価でもない。[レビュー記録](evidence/2026-09-19/independent-review.md)。

## 合格条件別の判定

| 条件 | 判定 | 観測と証拠 |
|---|---|---|
| A1 導入・準備 | PASS | 隔離managed launcherがreadyになり、ローカルモデル・Worker・Hostを接続。FIRST_RUNと実際のアプリ出力先を整合。`launcher.log`、53件のNode試験 |
| A2 初回操作 | PASS | Homeのサンプル選択で編集欄に全文が入り、フォーカスが移る。自動送信なし。実機AX操作記録と最終Home画像。新人による理解度は未測定 |
| A3 主要成果物 | PASS | 実際のnative `VoiceHUDState.ask`→Gateway→ローカルモデルで3項目・担当未定の本文を生成。`live-checklist-matched.log`、`generated-checklist.md`。1回10.44秒は試験ハーネス全体の時間で、平均性能/初心者所要時間ではない |
| A4 編集・保存・復帰 | PASS | GUIで日本語/絵文字を編集して保存し、NSSavePanelで書出し。DBの編集本文・元文・元のtask IDを照合。別画面と別プロセスで同じ結果を再表示。`document-bytes.log`、`reopen-edited.log`、`packaged-reopen.log`、`gui-checklist.md` |
| A5 状態・復帰 | FAIL | 空成果物/失敗/取消/未確認の単体試験、空編集のGUI拒否、保存失敗注入後の同一データ保存はPASS。ただし下記の受付不明照合と取消競合が残る |
| A6 SDKイベント互換性 | PASS | SDK30件。CRLF/CR/LF、1バイトずつの日本語・絵文字、コメント、複数data行、欠番・重複・同期受信失敗後の再配送を検証。WHATWGのフレーミングを採用。汎用EventSource完全互換とは主張しない |
| A7 組み込み契約 | PASS | `INTEGRATION.md`と実装/例を照合。例もテスト・型検査対象。private 0.0.0、同一revision、実行権限/冪等性/イベントカーソル/エラー/experimentalを明記。下記の既知問題を含むため本番利用保証ではない |
| A8 OSSライセンス | PASS | ユーザー承認済みMIT、workspace metadata、README/日本語README/貢献・セキュリティ文書。依存・第三者のライセンスは置換しない |
| A9 ビルド・検査 | BLOCKED | build/typecheck/SDK30/Swift161/Node53/workspace1879件はexit 0。workspaceの446件skipは未実施。`check:generated`はDATABASE_URL未設定でexit 1。全体ゲートは下記理由で未実施 |
| A10 アクセシビリティ等 | BLOCKED | nativeで編集時フォーカス・⌘A・Escape・日本語/絵文字の貼付を確認。940/1162pt・light/dark32画像と6状態geometry、UIScale3段の数値検査を実施。実IME変換中、長文、VoiceOver、reduced motion、拡大時の全画面レイアウトは未完了。貼付をIME試験とは扱わない |
| A11 競合・実ユーザー | BLOCKED | 比較手順と公式参照を固定。競合アカウント利用/外部モデル送信の許可と実ユーザーがないため、成功率や優位性は測っていない |
| Webのスマホ幅・200%ブラウザ拡大 | NOT_APPLICABLE | 今回の主要フローはネイティブMac。Web試験をMacの代用にしていない |
| Windows / macOS14実機 | BLOCKED | 対象OSの実機をこの検証で利用していない。debugリンクにmacOS26向けRustオブジェクトの警告があり、最低OS互換性の証拠にはできない |

## 実行記録と実機操作

全コマンド、exit code、時間: [`commands.jsonl`](evidence/2026-09-19/commands.jsonl)。各コマンド名の `.log` がstdout/stderr。`native-interactive` のexit -15は、GUIツールで選択できないraw実行を自分で終了した後始末。署名した隔離bundleで同じ画面を検証し `native-gui` はexit 0。最初の `live-checklist` はホストと異なるテスト用アカウントで失敗（exit 2）し、そのログも残した。隔離launcherのidentityに合わせた別のデータルートで実行し直した。失敗したタスクを自動再送したものではない。

実機操作はCuaで `/tmp/GenieQuality-20260919.app`（独立bundle ID・隔離SQLite）を選択して実施。通常のGenieの履歴や既存タスクは変更していない。編集ボタン→文章欄（自動focus）→日本語/絵文字入力→編集を保存→保存…→指定/tmpフォルダ→`gui-checklist.md`。保存直後に操作ツールのpipeが一度切れたが、再接続後の「保存しました」表示と実ファイルを別々に確認した。空白へ編集して保存を試すと拒否され、Escapeで元の保存済み文章へ戻った。Home→同じタスクで追加した確認メモが残り、アプリ終了後の別プロセスでも同じMarkdownになった。モデル生成はこの編集・保存・再表示で再実行していない。

最終fixture画像: [`docs/golden-screenshots/quality-20260919`](../golden-screenshots/quality-20260919)。これらの生成内容はmockであり、実生成の証拠は別のMarkdown/実行ログ。既存goldenの期待値・閾値は緩めていない。geometry記録のみを比較合格とは扱わない。別途 `geometry-compare.log` で既存基準の6状態が2pt以内であることを確認（exit 0）。

## 未達と次に閉じる条件

- **受付不明の照合（FAIL）**: conversation turnの受付応答だけ失うと、backend task IDがなく、既存処理を照合できない。自動再送はしないが、安全な再開経路は未実装。サーバー側のturn idempotencyと照合APIを契約化し、応答喪失を注入して既存task IDに復帰する試験が必要。
- **取消/完了競合（FAIL、静的根拠）**: `services/task/src/workflows.ts` のcomposeArtifact後に取消確認がなく、`activities.ts` のcompleteTaskは条件付きDB更新0件でもcompletedイベントを発行し得る。実行再現は未実施。取消要求と終端更新をDBで整合させ、実DB/Temporalで競合を注入し、DB・event・workflowの3者一致を確認する必要がある。
- **全体ゲート（BLOCKED）**: `verify-all.sh`は固定の既存localhost:3000や録音/権限試験を含み、この隔離文章フローだけで安全に閉じられない。ユーザーの既存データ/接続先を利用する試験は実行していない。`check-generated.sh`も指定DBをdropするため、ユーザーDBを与えて通していない。DBのないskipをPASSにはしない。commitはしていない。
- **最低OS/Windows/アクセシビリティ/初見ユーザー比較（BLOCKED）**: 専用環境と参加者による追試が必要。AIによる見た目の自己採点では埋めない。

## 公式参照と比較のやり方

2026-09-19に[Raycast AI](https://manual.raycast.com/ai)、[NotionのMarkdown書出し](https://www.notion.com/help/export-your-content)、[WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)、[MIT原文](https://opensource.org/license/mit)を確認した。参照先の機能説明は比較実測値ではない。

同じ架空メモを使い、「入力→3項目と未定の担当→1行編集→Markdown保存→アプリを閉じ再表示」を比較する。初期セットアップ時間と準備済みの操作時間を分け、完遂/操作数/不明点/再生成回数/保存内容一致/接続断後の復帰を記録する。Genieの今回の単一ハーネス実行と、競合の広告動画の時間を比較しない。J08の初回成功90%以上は実参加者で測るまでBLOCKED。
