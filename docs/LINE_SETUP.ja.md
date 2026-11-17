# LINE を手元の Genie につなぐ

LINE には、Slack の Socket Mode のように「Mac からつなぎに行く」受け方がありません。LINE から届く知らせ（Webhook）を受けるには、外から届く HTTPS の URL が要ります。手元の Mac で動く Genie では、次の形にします。

```
LINE → https://<トンネル>.trycloudflare.com → cloudflared → 中継（127.0.0.1:43190）→ プレビューの gateway（127.0.0.1:43123）
```

- **トンネルは gateway に直接向けず、中継に向けます。**直接向けると、開発用のサインイン（`/v1/auth/dev/token`）まで外から呼べてしまいます。
- 中継（`scripts/line-webhook-relay.mjs`）が通すのは、次の 2 つだけです。ほかはすべて 404 にします。
  - `POST /v1/channels/line/webhook`。本文は 1 MB まで、見出しは `content-type` と `x-line-signature` だけを渡します。
  - 通話のページとその音声（`GET /v1/channels/call/<リンク>` と `…/ws`、[LINE_CALL.ja.md](LINE_CALL.ja.md)）。
- 署名は gateway が確かめ、合わない配信は断ります。

## 1. LINE 側（LINE Developers、本人のアカウントで）

1. https://developers.line.biz/console/ で、プロバイダーを作り、その中に「Messaging API」のチャネルを作ります。LINE 公式アカウントも同時にできます。
2. 次の 2 つを、鍵のファイル（次の節）に書きます。
   - 「チャネル基本設定」の **チャネルシークレット**
   - 「Messaging API 設定」で発行する **チャネルアクセストークン（長期）**
3. LINE Official Account Manager の「応答設定」で、次のように切り替えます。
   - **応答メッセージ: オフ**
   - **あいさつメッセージ: オフ**
   - **Webhook: オン**

## 2. 鍵（キーチェーンに入れる）

鍵はファイルに書かず、キーチェーンに入れます（[SECRETS.ja.md](SECRETS.ja.md)）。入力は表示されません。

```
pnpm secrets set line-channel-secret   # 「チャネル基本設定」のチャネルシークレット
pnpm secrets set line-access-token     # 「Messaging API 設定」のチャネルアクセストークン（長期）
pnpm secrets set anthropic             # 写真と外国語を読むとき（Claude、有料）
pnpm secrets status                    # 入ったかどうか（値は出さない）
```

鍵ではない設定（通話の月の上限・公開 URL など）は、`~/Library/Application Support/Genie/channels.env`（`chmod 600`）に書きます。

## 3. 起動

```
pnpm preview stop
pnpm preview --channels-env "$HOME/Library/Application Support/Genie/channels.env"
node scripts/line-webhook-relay.mjs --port 43190 --gateway http://127.0.0.1:43123
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:43190
```

`cloudflared` が出した `https://….trycloudflare.com` に `/v1/channels/line/webhook` を付けたものを、LINE の「Webhook URL」に入れて「検証」を押します。成功と出れば、つながっています。

- 無料の一時トンネルの URL は、`cloudflared` を起動し直すたびに変わります。そのたびに LINE の Webhook URL も直してください。
- URL を固定するには、Cloudflare のアカウントと自分のドメインで「名前付きトンネル」を作ります。
- Mac が寝ている間や、プレビューが止まっている間は、メッセージを受けられません。

## 4. 自分の LINE とつなぐ

1. LINE Developers の QR コードから、公式アカウントを友だちに追加します。
2. Mac の Genie で「アプリ連携」→「Slack・LINE」の札を開き、連携コードを出します（10 分・1 回だけ有効）。
3. 表示された「連携 XXXXXXXX」を、公式アカウントとのトークに送ります。
4. 「連携しました」と返れば完了です。あとは、写真や文を送るだけです（[UNDERSTAND.ja.md](UNDERSTAND.ja.md)）。

## 確かめ方

- `GET /v1/channels/status`: LINE が「設定済み」か
- `~/Library/Logs/Genie/line-relay.log`: 中継を通った配信と gateway の答え（本文は書きません）
- `~/Library/Logs/Genie/line-tunnel.log`: トンネルの URL と状態
