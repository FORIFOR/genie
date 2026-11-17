# Noa 共存メモリ観察の補足（2026-10-02）

判定は **PASS（限定した合成生成・常駐観察）**。実行者は root、本書はハーネス実装担当による保存結果の読み合わせ。今回の整理では試験・アプリ・モデルの再起動やソース変更を行っていない。独立担当のレビューは[ソース／mock記録](noa-generation-harness-independent-review.json)を参照。

[75秒共存結果](noa-resident-75s-coexistence.json)と private `resident-75-1/report.json` の内容・元レポートSHA-256を照合し、時間、品質設定、各生成stage、常駐samples、メモリ集計、cleanupに不一致はなかった。試験はUTC 2026-10-01 21:58:54.087〜22:00:09.469（JST 10月2日06:58:54.087〜07:00:09.469）。

| 観測 | 結果と範囲 |
| --- | --- |
| 全所要時間 | 75.382秒（終了処理込み）。観察終了は開始後75.135秒。 |
| 実生成 | 合成入力3turnのLLM・host音声・comment音声。生成終了は開始後15.965秒。その後に推論／TTSを追加していない。 |
| モデル保持 | 53回のread-only確認。開始後16.117〜75.135秒に、専用11435の唯一residentが同一`qwen3.5:9b`・同一manifest digestと一致。両端間は59.018秒。 |
| メモリ | 155観測すべてpressure=1（normal）、free最低46%。この観察ではwarningなし。 |
| Genieとの重なり | 外部`gpt-6-sol`の合成テキストtaskが12.190秒重なりCOMPLETED。記録内の内容確認6項目もtrue。native Home経路ではない。 |
| 専用終了処理 | unload要求、serve停止、runner停止、assets不変、総合okの全項目true。共有11434／Aivis／VOICEVOXの停止・unloadは行わない。 |

品質設定は[先の14.774秒試験](noa-short-coexistence.json)のprojectionと完全一致。LLMは`qwen3.5:9b`、ctx4096、temperature0.7、num_predict220、think=false、生成keep_alive=30m。AivisSpeechのstyle1878365376・speed/intonation/tempo各1、comment VOICEVOXのspeaker2・speed1.15を維持。接続先だけ専用Ollamaへ切り替えた。これは設定維持の照合であり、回答・音声品質の包括的な評価ではない。先の短時間試験のfree最低43%と、今回の46%は別測定。

今回示したのは **run開始から75秒、生成終了後はモデル常駐を観察した結果**。75秒連続生成、モデルが最初から75秒常駐、本番配信・OBS・Jevゲート・再生・長時間安定性のPASSではない。生成本文と音声は配信／再生せず破棄した。Noa本番コード・設定は変更していない。共有音声サーバのcacheが残る可能性と、別起動のproduction server環境変数まで同一と実証していない限界は残る。ユーザー報告の「40秒以上のメモリ警告」はこの限定条件では再現しなかったが、他条件での再発解消までは証明しない。

[初回の起動失敗](noa-generation-start-attempt.json)は保存している。生成0件・起動時cleanup未確認という失敗を、後続PASSで置き換えていない。原因は当時の詳細不足で未確定。今回の候補は終了確認／現Ollama子形式への対応と75秒holdを含み、[31件のmock](noa-generation-harness-fake-tests-resident-hold.log)および別担当の読み取りレビュー後に実行された。

照合したSHA-256:

- `noa-resident-75s-coexistence.json`: `4133104d6c48b77d16741d2054b7bb8df5e7ea4a2724577c7b189693e6cc123e`
- private元report: `a3cbb0c4512a742acb82b080bb5e35c4a4168e2ac11508b034fa13ce235598a1`
- 実行時`generation-load.mjs`: `43f17b5675513bfecd5b3673fd51fb168033043a2609fccde4a365dbb01dab34`
- 実行時`owned-ollama.mjs`: `c5ea2d3de8c3ca2162c41b3ec0824352078686288d15a3cf82699309b7d34be0`

ハーネスはこの実測後に追加変更していない。本書は全体release gateの完了判定を追加しない。
