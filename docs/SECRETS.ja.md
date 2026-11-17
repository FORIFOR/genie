# API キー・鍵の置き場所（一元管理）

Genie の API キーとトークンは、**macOS のキーチェーン 1 か所**に置きます。

- **置かない所:** ファイルや環境変数には置きません。
- **読み書きの経路:** 読み書きは Genie.app 自身（`Genie --secret`）が行い、手元のサービスもそこから受け取ります。
  - `/usr/bin/security` で読むと、macOS がそのたびにログインパスワードを求めます。同じ署名の Genie 自身なら、確認なしで読めます。
- **値の扱い:** 値は画面にもログにも出しません。

## どこに何があるか

| 名前（`pnpm secrets`） | キーチェーンの項目（サービス `com.astra.mac`） | 使うところ | 入れ方 |
| --- | --- | --- | --- |
| `gemini` | `gemini.live.apiKey` | Mac の「会話」（Gemini Live）と、LINE から声で話す（`docs/LINE_CALL.ja.md`）。**同じキーを 1 つだけ**持つ | Mac の設定 → 外部サービス、または `pnpm secrets set gemini` |
| `google-maps` | `googleMaps.apiKey.v2` | 近くの店 | Mac の設定 → 外部サービス |
| `line-channel-secret` | `genie.line.channelSecret` | LINE の受け口の署名 | `pnpm secrets set line-channel-secret` |
| `line-access-token` | `genie.line.accessToken` | LINE への返信 | `pnpm secrets set line-access-token` |
| `anthropic` | `genie.anthropic.apiKey` | 送った写真・外国語の文を読む（`docs/UNDERSTAND.ja.md`） | `pnpm secrets set anthropic` |
| `genie-secret-key` | `genie.secretKey` | 受けたメッセージを封じて保存する鍵（32 バイト） | 作成済み |
| `slack-bot-token` / `slack-app-token` | `genie.slack.botToken` / `genie.slack.appToken` | Slack | `pnpm secrets set …` |
| `channel-action-secret` | `genie.channelActionSecret` | チャットの承認ボタンの署名 | `pnpm secrets set …` |

ほかに、キーチェーンには次のものも入っています。どれも Genie が自分で出し入れするもので、手で入れるものではありません。

- アプリ連携（Gmail・カレンダーなど）のトークン（`com.astra.connector.*`）
- 手元の Genie のサインイン（`com.astra.connector.astra.host-session.*`）
- 画面操作などのモデルのキー（`com.astra.connector.llm.*`）

## 使い方

```
pnpm secrets status                  # どれが入っているか（値は出さない）
pnpm secrets set line-access-token   # 入れる・置き換える（入力は表示されない）
pnpm secrets delete anthropic
pnpm secrets import <ファイル>        # KEY=VALUE のファイルの鍵をキーチェーンへ移し、ファイルから消す
```

## 手元のプレビューでの使われ方

`pnpm preview --channels-env "$HOME/Library/Application Support/Genie/channels.env"` で起動すると、gateway に次の 2 つを渡します。

- **鍵:** キーチェーンにあるもの（`scripts/local-preview/secrets.mjs` の `SECRET_ENV` の表）
- **鍵ではない設定:** `channels.env` に書いたもの（月の上限・公開 URL・時間帯・モデル名）

`channels.env` に値の入った鍵の行があると、プレビューは起動しません。そのときは `pnpm secrets import` で移すよう案内します。

プレビューは、周りの環境変数や `.env` から鍵を引き継ぎません。渡すのは上の表の鍵だけです。

## まだ一元化できていないもの

- **リポジトリの `.env`:** 中身は読まない決まりなので、確かめていません。通常の起動（3000 番）で使います。
- **3000 番の gateway の設定ファイル:** `~/Library/Application Support/Astra/gateway-stt.env` は、launchd の常駐の gateway が読みます。中身は読んでいません。
- **Google Cloud の資格情報（ADC）:** Google の仕組みで、`gcloud` の置き場所にあります。

これらをキーチェーンへ寄せるには、それぞれの読み手（launchd の設定・通常の起動）を `Genie --secret` から読む形に変える必要があります。中身を読む許可をいただいてから行います。
