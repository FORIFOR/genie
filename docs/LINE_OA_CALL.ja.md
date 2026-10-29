# LINE の通話ボタンで Genie と話す（公式アカウントの管理画面をつなぐ・検証中）

利用者は LINE の公式アカウントのトークで、いつもの**通話ボタン**を押します。LINE 純正の通話画面のまま、Genie が出て話します。
Twilio・電話番号・SIP・LINE コール Plus は使いません。

```
iPhone の LINE（通話ボタン）
  → LINE 公式アカウントの管理画面（Chrome。Genie 専用のプロファイル）
      ページの WebRTC: 相手の声 → 16 kHz PCM ／ Genie の声 → ページの「マイク」
  → tools/line-call-bridge（Playwright）
  → gateway の通話（/v1/channels/call/:token/ws）→ Gemini Live。頼みは Genie の仕事に
```

**仮想オーディオ（BlackHole・VB-CABLE・PipeWire）は使いません。**音はページの中で受け渡すので、Mac の出力を切り替えません。
OS ごとの部品も要りません（Mac・Windows・Linux で同じ。Chrome があればよい）。

## 使い方（いまは手動応答）

1. `cd tools/line-call-bridge && npm install`（初回だけ）
2. `node tools/line-call-bridge/bridge.mjs` → Genie 専用の Chrome が開く。初回は LINE ビジネス ID に本人がログインする
3. 管理画面の「チャット設定 → 電話 → 音声通話」を「利用する」にする
4. LINE から公式アカウントに電話 → 管理画面で「応答」を押す → Genie が話す

通話の中身はいつもの LINE 通話（`docs/LINE_CALL.ja.md`）と同じ: 頼みは Genie の仕事に、切ったら議事録がトークに届く、月の上限（分）。

## 守っていること

- **連携している人の電話だけ。**かけた人の LINE の利用者 ID が分かればその人の Genie へ。分からなければ、この Genie の LINE の連携が 1 つだけのときに限ってその人とみなす。それ以外は gateway が断り（`not_linked`・`caller_unknown`）、Genie はつながない。
- **鍵の道はこの Mac の中だけ。**`POST /v1/channels/line-oa-call` はループバックからだけ、受けた本文を封じる鍵（`genie-secret-key`）から作った合言葉で。公開の中継（`scripts/line-webhook-relay.mjs`）はこの道を通さない。
- **管理画面とチャットにだけ触れる。**ログイン画面（account.line.biz）・reCAPTCHA には何もしない。
- 探る道具（`probe.mjs`）が残すのは、出来事と音量とボタンの文字だけ。声の中身・名前・本文は残さない。

## 確かめたこと

- 1 ページの中の 2 つの WebRTC で、相手の声が 16 kHz PCM で取れ、Genie の声がマイクとして届く（`tools/line-call-bridge/test/loopback.test.mjs`）。
- LINE の代わりのページから、本物の gateway と Gemini Live まで通した: 合成した「今日は何曜日か教えて」に、Genie が声で答え、その声が相手側に届いた（2026-10-24、手で実行）。
- gateway の道: 合言葉が違えば 403、連携していない人は 409、連携している人は通話の WebSocket が Gemini へつながる（`line-call.integration.test.ts`）。

## 制限（未実装・未検証）

- **本物の LINE の管理画面では、まだ通していない。**管理画面の通話が WebRTC で動くことを前提にしている。
- **自動応答はまだ。**着信の画面のボタンを `probe.mjs` で調べてから作る。
- **この方式の間は、本物のマイクは使わない。**Genie につなげなかった通話でも、人は話せない（相手に Genie の無音が届く）。
- **公式アカウントは 1 つ**なので、製品にするには、管理画面で受けた電話を中継が各利用者の Genie へ振り分ける作りが要る。いまは 1 つの Mac・1 通話。
- LINE の公式の AI 通話の API ではない。管理画面の作りが変われば動かなくなる。利用規約に名指しの禁止は見当たらないが、第 18 条（21）（LINE が不適当と判断した行為）の余地は残る。
