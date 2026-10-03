# Macで最初の仕事を試す（v0.1.4）

**このページは、Ollamaのローカルモデルを使うv0.1.4の手動起動手順です。** 既存のCodex接続で`gpt-6-sol`を使う場合や、DBとサービスの起動をまとめる場合は、現在のソース向けの[まとめて起動する手順](MANAGED_PREVIEW.ja.md)へ進んでください。その外部モデル経路にOllama・dbmate・psqlの導入は不要です。アプリを自分でビルドする場合の道具は別途必要です。

[テスター案内に戻る](TESTING.ja.md) · [English setup](LOCAL_PREVIEW.md)

このページだけで、準備 → 起動 → 依頼 → 保存 → 停止まで進めます。対象は **macOS 14以降の開発者向けプレビュー**です。アプリのほかに、このMacで動くGateway・Task Worker・Agent Hostとモデルが必要です。環境構築とモデルのダウンロードには時間がかかります。

最初は架空のメモから行動計画をつくります。Google/Microsoft連携、マイク許可、顧客データは不要です。

## 1. アプリと必要な道具を用意する

[Genie-0.1.4.dmg](https://github.com/FORIFOR/genie/releases/download/v0.1.4/Genie-0.1.4.dmg)を開き、Genie.appをApplicationsへコピーしてください。[リリース情報](https://github.com/FORIFOR/genie/releases/tag/v0.1.4)には署名・公証・チェックサムと制約を記載しています。

必要な道具は次のとおりです。**既にあるものを入れ直す必要はありません。** このページでは配布アプリを使うため、フルのXcodeとRustによるアプリのビルドは不要です。

| 道具                     | 確認コマンド             | 必要な状態                           |
| ------------------------ | ------------------------ | ------------------------------------ |
| Node                     | `node --version`         | 22以降                               |
| pnpm                     | `pnpm --version`         | 10.12.2                              |
| DockerとCompose          | `docker compose version` | Dockerのエンジンが起動している       |
| dbmate                   | `dbmate --version`       | コマンドが見つかる                   |
| PostgreSQLクライアント   | `psql --version`         | コマンドが見つかる                   |
| Xcode Command Line Tools | `xcode-select -p`        | インストール先が表示される           |
| Ollama                   | `ollama list`            | 起動しており、使うモデルを確認できる |

<details>
<summary>不足する道具をHomebrewで用意する例</summary>

[Homebrew](https://brew.sh/)を使っている場合の例です。不足しているパッケージだけを選んでください。Nodeを別の方法で管理している場合は、その環境を使います。

```sh
brew install node@22 dbmate libpq
brew install --cask docker-desktop ollama
```

HomebrewのNode 22とpsqlを、このターミナルで使えるようにします。Intel/Apple siliconで共通の書き方です。

```sh
export PATH="$(brew --prefix node@22)/bin:$(brew --prefix libpq)/bin:$PATH"
npm install --global pnpm@10.12.2
```

Xcode Command Line Toolsがない場合は`xcode-select --install`を実行し、Macに表示される案内を完了してください。DockerとOllamaも初回起動の案内を完了します。

```sh
open -a Docker
open -a Ollama
```

このPATH変更は現在のターミナルだけに適用されます。後で開くターミナルでも、`node`・`pnpm`・`psql`が見つからない場合は同じPATH設定を行ってください。

インストール名の根拠：[Docker DesktopのHomebrew定義](https://formulae.brew.sh/cask/docker-desktop)、[Node 22](https://formulae.brew.sh/formula/node@22)、[pnpmのインストール](https://pnpm.io/installation)。既存のDocker環境がある場合は、その環境で構いません。

</details>

## 2. v0.1.4のソースを用意し、事前診断する

新しく試す場合の保存先は`~/Projects/genie-preview`とします。既にv0.1.4をcloneしている場合はそのフォルダを使い、以下の`--repo`や`cd`のパスを読み替えてください。**既存の設定・データ・稼働中サービスは上書きしません。**

```sh
mkdir -p "$HOME/Projects"
cd "$HOME/Projects"
git clone --branch v0.1.4 --depth 1 https://github.com/FORIFOR/genie.git genie-preview
cd genie-preview
```

次の診断スクリプトは**v0.1.4の配布後に追加した独立ツール**です。検証済みの公開コミットから別ファイルとして取得し、内容を確認して実行します。アプリやバックエンドのソースを`main`へ更新する操作ではありません。

```sh
curl --fail --location --output "$HOME/Downloads/genie-doctor-local-preview.mjs" https://raw.githubusercontent.com/FORIFOR/genie/3bd0d00ef19835fc98a0a6bd9ab782f8d7bc1e35/scripts/doctor-local-preview.mjs
less "$HOME/Downloads/genie-doctor-local-preview.mjs"
```

`less`は`q`で閉じます。その後、検査したいチェックアウトを指定します。

```sh
node "$HOME/Downloads/genie-doctor-local-preview.mjs" --repo "$HOME/Projects/genie-preview"
```

**初回は「要対応」が出て正常です。** 道具・依存・GatewayのDB/Redis確認・ローカルモデル一覧・Temporal設定先のポート・アプリ識別情報を調べ、不足項目と次の操作を表示します。まだ準備していないものを自動インストールすることはありません。

診断はファイルや設定を変更せず、認証トークンを作らず、モデルへの生成依頼も行いません。バージョン確認によるCorepack/pnpmの自動取得・切替も無効にします。Task WorkerとAgent Hostの稼働、モデル品質、実際のタスク完了は未検査です。全部が`OK`でも「製品全体の動作検証済み」という意味ではありません。

終了コードは`0`が検査項目の通過、`1`が要対応、`2`が引数・設定・検査のエラーです。構造化した報告には末尾に`--json`を付けます。`.env`のローカル接続設定を読みますが、シェルで上書きした設定は引き継がないため、カスタムモデルや接続先は`--help`を見て明示してください。

## 3. ローカルサービスとDBを準備する

作業するターミナルを**A**とします。ここから先のコマンドは、すべて同じ`genie-preview`フォルダで実行してください。

```sh
cd "$HOME/Projects/genie-preview"
pnpm install
```

`.env`がない場合だけ、同梱の開発用設定をコピーします。既存の`.env`は保持します。

```sh
if [ ! -e .env ]; then
  cp .env.example .env
fi
pnpm dev:infra
docker compose -f infra/docker-compose.dev.yml ps
```

PostgreSQLが`healthy`になり、Temporalが起動するまで待ちます。コンテナが停止・再起動している場合は、先にDockerの状態や使用ポートを確認してください。開発用の認証・DBはこのMac専用です。外部ネットワークへ公開しないでください。

既存の`.env`を使う場合も、**`ASTRA_API_HOST=127.0.0.1`が明示されていること**を確認してください。未設定や`0.0.0.0`なら、その1項目だけを編集します。未設定時のGatewayは外部から到達可能な待受が既定です。`.env`全体を置き換える必要はありません。既にGatewayを動かしている場合は、編集後にGatewayを再起動します。

DBにスキーマを作り、アプリ用の権限を設定します。以下の認証情報は同梱のローカル開発用設定です。

```sh
dbmate --url 'postgres://astra:astra@127.0.0.1:5433/astra_dev?sslmode=disable' --migrations-dir infra/db/migrations --no-dump-schema up
psql 'postgres://astra:astra@127.0.0.1:5433/astra_dev?sslmode=disable' -v ON_ERROR_STOP=1 -f infra/db/bootstrap.sql
pnpm build
```

`astra`というDB名や環境変数は、既存データとの互換性のために残っています。手動で`genie`へ置き換えないでください。独自のDB設定がある場合は、既存の環境に対応する接続先を使います。

## 4. GatewayとTask Workerを起動する

ターミナル**A**でGatewayを起動し、そのまま開いておきます。

```sh
node --env-file=.env --import tsx services/api-gateway/src/server.ts
```

別のターミナル**B**を開き、Task Workerを起動します。

```sh
cd "$HOME/Projects/genie-preview"
node --env-file=.env --import tsx workers/task-worker/src/worker-main.ts
```

プロンプトに戻る・エラーで終了する場合は、まだ動いていません。DB・Temporal・ビルドを確認してください。ブラウザで[Gatewayの依存確認](http://127.0.0.1:3000/readyz)を開き、`status: ok`とDBの確認結果が出ることを確認します。これはWorkerの稼働確認は含みません。

## 5. アプリとローカルモデルをつなぐ

Genieを起動して**Homeを一度開きます**。Gatewayが動いている間に行うことで、このMacのローカル開発用識別情報が用意されます。

別のターミナル**C**を開きます。Ollamaが起動していることを確認し、検証例と同じモデルを用意します。`qwen3.5:9b`のダウンロード容量・実行メモリは別途必要です。

```sh
cd "$HOME/Projects/genie-preview"
ollama pull qwen3.5:9b
node "$HOME/Downloads/genie-doctor-local-preview.mjs" --repo "$HOME/Projects/genie-preview"
node --env-file=.env scripts/start-local-host.mjs
```

Hostの起動コマンドは**v0.1.4に入っているhelper**です。独立doctorと違い、このコマンドはローカル認証とタスク実行能力の登録を行い、Hostを起動します。認証トークンをコピーする必要はありません。Hostもそのまま開いておきます。

既に別のモデルを使っている場合は、追加モデルを自動で選ぶことはありません。例えば文章用の`llama3.2`を選ぶなら、診断とHostの両方に同じ名前を指定します。回答品質はモデルごとに違い、この例は画像理解には使えません。

```sh
node "$HOME/Downloads/genie-doctor-local-preview.mjs" --repo "$HOME/Projects/genie-preview" --model llama3.2
ASTRA_LOCAL_LLM_MODEL=llama3.2 node --env-file=.env scripts/start-local-host.mjs
```

Hostはローカルモデルを明示して起動し、有料APIへ黙って切り替えません。このテストでは外部サービスの認証や自動同期は不要です。

## 6. ひとつ依頼し、結果を持ち出す

Homeに以下を貼り付けます。

```text
アプリを試す、デモを撮る、公開文を書く。
このメモから担当者と次の行動が分かるチェックリストを作って。
未定の担当者は未定と書いて。
```

- [ ] 依頼を開始し、結果が出た。
- [ ] 3つの仕事が整理され、担当者を勝手に作っていない。
- [ ] 別の画面へ移った後、同じ結果をWorkから開き直せた。
- [ ] コピーかMarkdown保存で、内容を持ち出せた。

待機が続くときは同じ依頼を何度も送らず、A・B・Cのターミナルが終了していないか確認します。診断が通るのに止まる場合は「最初の依頼で止まった」と報告してください。再実行で解決したことにせず、起きた状態を記録します。

## 7. 終了し、結果か最初のつまずきを報告する

[3項目のテスターレポート](https://github.com/FORIFOR/genie/issues/new?template=tester_feedback.yml)から、「どこまで進んだか」「やりたかった仕事」「結果・最初のつまずき」を送れます。インストール前・準備中に止まった報告も歓迎です。Issueは公開されるため、`.env`・トークン・顧客情報は載せないでください。診断の項目名と結果だけでも構いません。

A・B・Cをそれぞれ`Ctrl+C`で止めます。コンテナも止める場合は、チェックアウトで実行します。

```sh
pnpm dev:infra:down
```

このコマンドは開発コンテナを止め、データ領域は保持します。再び使うときは`pnpm dev:infra`を実行し、手順4・5のGateway・Worker・Home・Hostを起動します。データを残したい場合、Dockerのボリュームや`.data`を削除しないでください。

### 最初につまずきやすいところ

| 表示・状態                      | 次に確かめること                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `psql`がない                    | libpqをインストールした場合は、その`bin`を現在のターミナルのPATHに追加                            |
| `gateway_binding`が要対応       | `.env`の`ASTRA_API_HOST=127.0.0.1`を確認。ない/`0.0.0.0`ならこの項目だけを編集してGatewayを再起動 |
| `gateway` / `database`が要対応  | Aが起動しているか、Docker・DB準備・`.env`が同じチェックアウトに対応しているか                     |
| `temporal_port`が要対応         | DockerのTemporalが起動しているか。到達後もWorker稼働はBで確認                                     |
| `model`が要対応                 | Ollamaの起動、モデル名の一致。doctorの`--model`とHostの指定を合わせる                             |
| `desktop_identity`が要対応      | Gateway起動後にGenieのHomeを開いたか。カスタムGatewayの場合は診断にも同じURLを指定                |
| Gateway再起動後に認証が止まった | 開発用の鍵は再起動で変わることがあります。アプリとHostも再起動                                    |
| 全項目がOKだが依頼が進まない    | Worker・Host・認証・タスク完了は診断の対象外。B・Cの停止や表示を確認して報告                      |

2026-09-14追補。アプリとバックエンドの対象はv0.1.4で、doctorとこの日本語ガイドは後から追加したものです。製品全体のリリース判定とは別の初回テストです。
