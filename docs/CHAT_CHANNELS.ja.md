# Slack / LINE から頼む

Slack の DM、Slack のメンション、LINE の 1 対 1 のトークで頼んだことを、Genie は Task Dock で頼んだときと同じように進めます。振り分け（`handleTurn`）、仕事の状態、承認、記録は Task Dock と共通です。チャット専用の別の流れはありません。

## できること

|                  | Slack                                                | LINE                                 |
| ---------------- | ---------------------------------------------------- | ------------------------------------ |
| 頼む             | Bot との DM、またはチャンネルでのメンション          | 公式アカウントとの 1 対 1 のトーク   |
| 返ってくるもの   | 受付、承認待ち、一時停止、終わり（完了・失敗・中止） | 同じ                                 |
| チャットでの承認 | ボタン（外部への送信だけ）                           | ボタン（postback、外部への送信だけ） |
| 会話の単位       | スレッド 1 つが Genie の会話 1 つ                    | 相手ごとに会話 1 つ                  |

途中経過は流しません。チャットへの返信は外部への送信なので、既定では要約と「Genie の作業一覧で開けます」だけを送ります。本文まで送るには、連携ごとに `full_text` を選びます（`PATCH /v1/channels/links/:id`）。

## 準備（運営者）

1. 環境変数を設定します（`.env.example` の「チャット」の項）。設定した提供者だけ受け口が開きます。
   - Slack（Socket Mode。gateway を手元の Mac で動かすとき）: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`（xapp、スコープ `connections:write`）
   - Slack（Events API。gateway を公開 HTTPS に置くとき）: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
   - LINE: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`
   - チャットの承認ボタン: `GENIE_CHANNEL_ACTION_SECRET`（32 文字以上）。設定しなければボタンは出さず、承認は Genie の承認カードだけで行います。
   - `GENIE_SECRET_KEY` があれば、受けたメッセージを封じて（AES-256-GCM）受信箱に保存してから「受け取った」と返します。処理を終えたら本文は消します。無ければ本文は保存しません（そのかわり、処理の途中で gateway が落ちると、その依頼は失われます）。
2. Slack アプリの設定
   - Event Subscriptions に `message.im` と `app_mention` を登録します。Events API のときは、Request URL を `https://<gateway>/v1/channels/slack/events` にします。Socket Mode のときは URL は要りません（Socket Mode を有効にするだけ）。
   - Interactivity: Events API のときだけ `https://<gateway>/v1/channels/slack/interactions`。Socket Mode では URL は要りません。
   - Bot のスコープ: `chat:write`, `im:history`, `app_mentions:read`, `im:write`（メンションの結果を DM に返すため）
3. LINE の設定: Messaging API の Webhook URL を `https://<gateway>/v1/channels/line/webhook` にして、Webhook を有効にします。
4. Events API と LINE の受け口は、公開 HTTPS で届く場所に置きます。受け口は認証の代わりに署名で守っていて、署名が合わない配信は 403 で断ります。Socket Mode の Slack だけは、gateway から Slack へ繋ぐので公開 URL が要りません。
5. つながり具合は `GET /v1/channels/status` で見られます（Slack の受け方、Socket Mode の接続状態と再接続までの時間、受信箱に保存するか。トークンは返しません）。

## 連携（利用者）

1. Genie で連携コードを出します（`POST /v1/channels/link-codes`、本文は `{"provider":"slack"}` または `{"provider":"line"}`）。コードは 10 分間・1 回だけ有効です。保存するのはハッシュだけです。
2. 返ってきた `連携 XXXXXXXX` を、Bot とのトークにそのまま送ります。「連携しました」と返れば完了です。
3. やめるときは、チャットで「連携解除」と送るか、`DELETE /v1/channels/links/:id` を呼びます。連携ごとに作った端末も無効になり、送信待ちのものは送りません。

連携していない人から届いたメッセージには、連携の手順だけを返します。仕事にはしません。連携していない人のメンションには、何も答えません。

## 守っていること

- **本人の発話だけを頼みとして受けます。**Bot の発言、編集・削除、グループのメッセージは受けません。Slack のチャンネルでは、本人のメンションだけを受けます。
- **同じ配信を二度仕事にしません。**Slack の再送や LINE の再配信は、受信箱（`channel_inbox`）で 1 回にまとめます。Slack が 1 つの発言に `message` と `app_mention` の 2 つのイベントを送ったときも、`team:channel:ts` で 1 つにまとめます。
- **受けたものを取りこぼしません（`GENIE_SECRET_KEY` があるとき）。**保存してから「受け取った」と返し、同じ相手の発言は順番どおりに処理します（相手どうしは最大 4 つ並べて）。処理の前に gateway が落ちたものは、次に動いたときに続きから処理します。失敗は間をあけて 5 回まで処理し直します。
- **仕事を二つにしません。**handleTurn の途中で gateway が落ちたものは、やり直さずに「途中で止まりました。作業一覧で確かめてください」と本人に伝えます。
- **届いたか分からない送信は送り直しません。**Slack の時間切れ・5xx・`internal_error` は送り直さず、記録だけ残します。断られたもの（429、繋がらなかった）だけを送り直し、429 は `Retry-After` まで待ちます（無ければ 5 秒から倍々に、最大 10 分）。LINE の push は `X-Line-Retry-Key` で 1 通にまとまるので、5xx でも送り直します。
- 長い仕事の間、LINE の「読み込み中」を 18 秒ごとに出し直します（表示は 20 秒で消えるため）。
- Socket Mode は切れたら 2 秒から 30 秒まで間を広げて繋ぎ直します。トークンが無効・スコープ不足のときは繋ぎ直さずに止め、状態に出します。同じ Slack アプリに 2 本以上つながっているとイベントが分かれるので、記録に残します。
- **区切りは 1 回ずつ送ります。**送信待ちの記録（`channel_outbox`）は task のイベント 1 つにつき 1 行で、失敗したものは 5 回まで送り直します。LINE は reply token が使えるときは reply で返し、使えなければ `X-Line-Retry-Key` を付けて push で送ります。
- **チャットで承認できるのは、外部への送信（EXTERNAL_COMMIT。電話、メールの送信など）だけです。**削除、お金、規制のある記録は、Genie の承認カードで確認してもらいます。
  - ボタンには、どの連携の・どの承認の・どちらの答えかを HMAC で署名した値を載せています。有効なのは 10 分間です。
  - 押した人が、その連携の本人でなければ通しません。転送されたボタンを他人が押しても効きません。
  - 押した時点で、承認がまだ待っていることと、その種類をもう一度確かめます。
  - チャットからの承認は、監査ログに `channel.approval_relayed` として残ります。
- **Slack のメンションの結果は、チャンネルに書きません。**チャンネルには「DM でお返しします」とだけ返し、結果は本人の DM に送ります。
- Mac がオフラインで仕事が止まった場合は、「Mac が戻ると続きから進めます」と伝えます。失敗とは扱いません。

## 制限（未実装・未検証）

- 実際の Slack ワークスペースと LINE 公式アカウントでは、まだ確認していません。Socket Mode も、WebSocket の代役で確かめただけです。署名、本文の形、送信の API は、提供者の仕様どおりに作ったうえで、代役（fetch の差し替え）を使った結合テストで確かめています。
- Slack のスレッドの他の発言を、材料として読むことはしていません（`conversations.replies` は使っていません）。
- 連携コードを出す画面（Mac アプリの設定）は、まだありません。いまは API で出します。
- 音声メッセージ、画像、スタンプは受けません。テキストだけです。
