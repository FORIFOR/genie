# LINE 会話の評価ケースの形（evals/line-conversation）

1 行 1 ケースの JSONL（`cases/<category>.jsonl`）。**採点できることだけを書く。**期待が一つに決まらないものは `accept` に並べる。

```jsonc
{
  "id": "ctx-001",                       // <category の頭>-<3 桁>
  "category": "context",                 // daily | calendar | household | context | multi | anomaly
  "history": [                           // 直前までの会話（古い順）。無ければ []
    { "role": "user", "text": "明日の予定教えて" },
    { "role": "genie", "text": "明日は 14:00 から打ち合わせ、18:00 から食事です。" }
  ],
  "pending": null,                       // Genie が確かめ中のこと（"group_send" | "schedule_confirm" | "expense_confirm" | null）
  "attachments": [],                     // [{ "type": "image", "about": "receipt" }]（about: receipt|meal|product|document|screenshot|invitation|other）
  "input": "打ち合わせ30分遅らせて",
  "expect": {
    "act": "request",                    // question | request | correction | undo | confirm_yes | confirm_no | ack | chitchat | multi | unclear
    "do": "calendar.reschedule",         // 下の「すること」から 1 つ
    "accept": [],                        // ほかに正しいと認める「すること」
    "parts": [],                         // act が multi のとき、分けた「すること」の並び
    "confirm": true,                     // 実行の前に本人の確認が要る（送信・削除・変更・支払い）
    "clarify": false,                    // 聞き返すのが正しい（対象が一つに決まらない・情報が足りない）
    "must_not": ["calendar.delete"],     // してはいけないこと（誤実行）
    "reply": { "shouchi": "forbid" }     // 返事の決まり: shouchi = require | allow | forbid（「承知しました」）
  },
  "why": "直前に出した予定の「打ち合わせ」を指す。変更は確認が要る"
}
```

## すること（do）

| do | 意味 |
| --- | --- |
| `answer.chat` | あいさつ・雑談・相づちにそのまま返す |
| `answer.knowledge` | 一般的な知識で答える（調べなくてよい） |
| `info.weather` / `info.news` / `info.stock` | いまの情報を取って答える |
| `research` | 調べてまとめる（Web 調査） |
| `calendar.read` / `calendar.create` / `calendar.reschedule` / `calendar.delete` | 予定 |
| `reminder.create` / `reminder.list` / `reminder.cancel` | 予約・リマインダー（「〜に教えて」） |
| `mail.read` / `mail.draft` / `mail.send` | メール |
| `household.expense_add` / `household.view` / `household.budget` | 家計簿 |
| `list.shopping_add` / `list.todo_add` / `list.view` | 買い物リスト・TODO |
| `group.send` | 家族の LINE グループへ送る |
| `photo.read` | 写真を読む（商品・書類・スクショの説明） |
| `meal.estimate` | 料理の写真からカロリーの目安 |
| `translate` | 外国語を日本語に |
| `compose` | 文を書く・まとめる・言い換える（送らない） |
| `call.start` | 電話で話す |
| `task.status` | 前に頼んだことの様子 |
| `task.cancel` | 進めている仕事・直前の操作をやめる |
| `undo` | 直前に実行したことを元に戻す |
| `opencode.watch` / `opencode.status` | opencode の見守り |
| `usage.report` | 使った量 |
| `clarify` | 聞き返すだけ（do が決まらない） |
| `refuse` | 断る（危険・権限外・不正） |
| `none` | 何もしない（相づちに短く返すだけ、など） |

## 返事の決まり（reply.shouchi）

「承知しました」は**依頼を引き受けて実行する・結果を返すときだけ**（2026-10-26 本人の指示）。
質問・あいさつ・雑談・できない・分からない・聞き返すときは付けない（forbid）。
