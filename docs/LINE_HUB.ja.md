# LINE の公式アカウントを 1 つにする（中継）

Genie の LINE の公式アカウントは、運営者が持つ **1 つだけ**にします。利用者は友だち追加して、Mac の Genie で出した「連携 XXXXXXXX」を送るだけです。LINE Developers も、鍵も、公開 URL も触りません。

```
LINE ──Webhook──▶ 中継（運営者が 1 つ置く。LINE の鍵はここにだけある）
                    │  各利用者の Mac の Genie が、自分から WebSocket を張る（公開 URL いらない）
                    ▼
               利用者の Mac の Genie（gateway）── 返信・写真の取得も中継に頼む
```

## 届け先の決め方

| 送り主 | 届け先 |
| --- | --- |
| 1 対 1 の、まだ連携していない人 | 中継が「連携していません」とだけ返す（どの Genie にも届けない） |
| 1 対 1 の「連携 XXXXXXXX」 | そのコードを出した Genie。以後、この人の発言はその Genie へ |
| 1 対 1 の、連携した人 | その人の Genie |
| グループに招かれた | 中継が始め方だけ返す |
| 持ち主が決まる前のグループの発言 | 話した人が連携していれば、その人の Genie（Genie がそこで使い始める）。連携していない人の「@Genie」には「準備中」と返す。招かれたときは挨拶だけ返す |
| 使い始めたグループ | 使い始めた人の Genie |

- **連携コード:** Mac の Genie が出したコードのハッシュだけを、中継に知らせます（10 分・1 回）。
- **中継に許す操作:** 各 Genie に許すのは、その Genie に届けたもの（返信の token・写真・宛先）と、その Genie の利用者・グループへの送信だけです。ほかの Genie の利用者には送れません。
- **Mac が寝ている間:** 知らせは中継で待ちます（24 時間まで）。Genie がつなぎ直したら、届けて、受け取りの返事（ack）が来たら消します。本文は届けるまでしか持ちません。
- **連携を切る:** Genie で連携を切ると、中継もその人をその Genie へ届けなくなります。

## 運営者（中継を置く人）

```
pnpm secrets set line-channel-secret    # 公式アカウントのチャネルシークレット
pnpm secrets set line-access-token      # 公式アカウントのチャネルアクセストークン（長期）
pnpm line-hub serve                     # 中継を 127.0.0.1:8790 で動かす
```

- **Webhook URL:** LINE の Webhook URL は `https://<中継>/line/webhook` です。
- **登録の合言葉:** 中継は、Genie の登録（`/installs`）に合言葉を求めます。合言葉はキーチェーンの `line-hub-registration` に作ります。
- **公開の場所に置くとき:** `services/line-hub` の `genie-line-hub` を動かします。
  - 必要な鍵は `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`HUB_REGISTRATION_TOKEN` の 3 つで、その場所の秘密の置き場に置きます。
  - 控え（`HUB_DB`）は SQLite のファイル 1 つです。

## 利用者（自分の Mac の Genie）

```
pnpm line-hub register https://<中継>   # この Genie を登録（鍵はキーチェーン、場所は channels.env）
pnpm preview --channels-env "$HOME/Library/Application Support/Genie/channels.env"
```

そのあと、Mac の Genie で連携コードを出し、公式アカウントに送れば使えます。

## 手元で試すとき（いまの形）

運営者と利用者が同じ Mac にいます。

```
LINE → https://<トンネル>/line/webhook → 中継の入り口（scripts/line-webhook-relay.mjs --hub）→ 中継（127.0.0.1:8790）
                                                                                         ↕ WebSocket
                                                                                プレビューの gateway
```

## 制限（未実装・未検証）

- **中継はまだ公開の場所に置いていません。**いまは手元の Mac で、トンネル越しに動かしています。置き場所（例: Cloud Run・Fly.io などの小さなサーバ）と費用を決めてから、別に許可をいただいてデプロイします。
- **通話のページは、まだ中継を通りません。**いまは手元のトンネル（`GENIE_PUBLIC_URL`）を使います。製品にするには、中継がページと音声も各 Genie へ通す必要があります。
- **中継の控えは SQLite 1 つです。**中継を複数台に増やす作りではありません。
- **実際の LINE で、中継を通した動きはまだ試していません。**試験は、本物の中継と、LINE の API の代役を使った結合テストだけです。
