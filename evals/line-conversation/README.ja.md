# LINE 会話の評価（evals/line-conversation）

「何を頼んでも、意図を正しく理解し、自然な日本語で、期待どおりに進めるか」を測る。
ケースの形は [SCHEMA.ja.md](SCHEMA.ja.md)。いまは 300 件（`cases/*.jsonl`）。

| ファイル | 件数 | 中身 |
| --- | --- | --- |
| `daily.jsonl` | 60 | あいさつ・雑談・相づち・知識・天気/ニュース/株価・文の手伝い・翻訳 |
| `calendar.jsonl` | 45 | 予定の確認・登録・変更・削除、予約（リマインダー） |
| `household.jsonl` | 45 | 家計簿・レシート・写真・買い物リスト・家族グループへの送信 |
| `context.jsonl` | 60 | 文脈・省略・訂正・「うん」「違う」「やっぱなし」・確かめ中の返事 |
| `multi.jsonl` | 45 | 一度に複数の依頼・メール・opencode・電話・使った量 |
| `anomaly.jsonl` | 45 | 異常な入力・紛れ込んだ指示・危険な依頼・失敗からの復旧 |

## 動かし方

```sh
# その 1: 振り分け（費用 0。試験用 DB が要る）
./infra/db/with-test-db.sh sh -c 'cd evals && npx tsx line-conversation/measure.ts --out line-conversation/results/routing-<日付>.json'

# その 2: 汎用の答えに回ったものの、答えの文（お金がかかる。Claude のキーはキーチェーンから）
cd evals && ANTHROPIC_API_KEY="$(/Applications/Genie.app/Contents/MacOS/Genie --secret get anthropic)" \
  npx tsx line-conversation/reply.ts line-conversation/results/routing-<日付>.json
```

## 採点

**その 1（measure.ts）**は、いまの Genie の判断の層を本物のまま通す。決まった言い方（家計簿・グループ送信・見守り・使った量）→ 辞書 → 予約 → 振り分け → 仕事の種類。仕事は作るだけで動かさない。

- **doOk:** 観測した「すること」が期待（do / accept）と合う。
  - 汎用の答え（`llm`）に回ったものは、汎用の答えで済ませてよい期待（あいさつ・知識・文の手伝い・翻訳・聞き返し・断り）のときだけ合格とする。予定やメールの操作が汎用の答えに回ったら不合格。
- **violation:** してはいけないこと（must_not）をした。
- 写真つきのケースは、写真を読む口へ渡すかだけを見る。

**その 2（reply.ts）**は、本番と同じ指示（`promptFor('llm.answer')`）で答えを作り、別のモデルが採点する。

- **採点する観点:** 意図に応えたか、聞き返しの要否、していないことをしたと言っていないか、文脈を失っていないか、自然さ（1〜5）。
- **「承知しました」の決まり:** 文字で判定する。

## 限り（いまの評価が見ていないもの）

- **前の会話:** 本人の発言だけを順に Genie へ送って作る。Genie の返事は Genie 自身のもの（ケースの genie の文とは違うことがある）。
- **写真:** 本物の写真が無いので、写真の中身の判断は見ていない。
- **Work Context と電話（Oathra）:** 本番のプレビューにあるが、評価には入れていない。予定・メールの質問に Work Context から答えられる場合も、ここでは不合格になる。他人への電話も同じ。
- **重さと承認:** 仕事を動かさないので、承認の画面が出るか（送信・支払いの前の確認）は見ていない。
