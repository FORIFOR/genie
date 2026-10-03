# Genie DESIGN.md — 造形の憲法と、借りてくる先

Genie の UI を触る人（人でも Claude Code でも Codex でも）は、編集の前にこれを読む。
ここには **何を目指すか**、**どの製品の作法をどの面に借りるか**、**借りたものを
どう検証するか** だけを書く。決まった数値の正本は `shared/design/tokens.json`、
確かめ終わった規則は `docs/DESIGN_SYSTEM.md`（DS-01〜05・§7）。この 2 つと矛盾する
記述があれば、そちらが勝つ。

## 0. Philosophy

> Calm ambient intelligence. Capabilities are rich; chrome is quiet.
> One continuous surface, task-adaptive size.

- 面は 1 枚。窓を増やさず、同じ面が役割に合わせて **寸法を変える**（idle 220x44 →
  workspace 1080x680）。
- 面の高さは中身の実寸で決まる（DS-01）。推定式も飾りの余白も持たない。
- 造形は飾って良くならない。**構造と実寸を正すと良くなる**（craft ①〜⑨、DS-01〜05 で
  確かめた。採用 4 / 差し戻し 5。差し戻したものは §5 に列挙）。
- 参照は仮説の源で、判定は Genie のゲートがする（§4）。

## 1. 面の役割と、借りる先

Genie の 6 つの面（型）には、それぞれ性格の近い製品がある。**同じ製品を全面に敷かない。**
役割ごとに借りる先を固定する。

| 面（型）                                          | 性格             | 借りる先        | 借りるもの                                                             | 借りないもの                                                      |
| ------------------------------------------------- | ---------------- | --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Home / Library / Meeting Detail（白の窓）         | 読む・探す・戻る | Apple + Notion  | 近白の canvas、hairline での区切り、飾りの影を持たない、字の重さで階層 | Apple の 980px pill ボタン、Notion の accent 塗りの feature block |
| Dock（idle / listening / thinking / agent）（黒） | 動作中の道具     | Linear          | 近黒の substrate、低い weight（≤ 590）、0.5px hairline、影で分けない   | acid-lime accent、大きな display 型                               |
| 音声・AI の気配（orb、波形、result）              | 質感             | ElevenLabs      | 抑制、warm-neutral、AI gradient を持たない、accent はまばら            | Waldenburg 300 の見出し、product visual 専用の violet/orange      |
| Action Confirmation（Dock の中）                  | 一度だけ決める   | Apple + Linear  | 主たる操作は 1 つだけ塗る、副は文字だけ、警告は独立した段              | —（craft ①〜⑨ で局所は完了。**触らない**）                        |
| Recording Workspace / Meeting Notes               | 書きながら聞く   | Notion + Linear | 白の面に hairline の列、道具（pill）は Linear の密度                   | 3 列の情報設計をこれ以上増やすこと                                |

### 参照の実値（公開ページから取ったもの）

Refero Styles の公開ページ（`styles.refero.design`、2026-09-03 取得）から、Genie の寸法と
突き合わせられる数だけを写す。**Refero MCP はこのリポジトリに接続されていない**ので、
以下は WebFetch で読んだ公開ページの値であり、MCP の `refero_match_style` の出力ではない。

| 項目          | Linear                                       | Apple                                      | Notion                             | ElevenLabs                         | Genie いま（tokens / 実装）                                         |
| ------------- | -------------------------------------------- | ------------------------------------------ | ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| canvas        | #08090a（void）/ #0f1011（card）             | #f5f5f7                                    | #f6f5f4（warm）/ card #ffffff      | #fdfcfc（eggshell）/ #f5f3f1       | light #F7F8FA / surface #FFFFFF、dark #0F1115 / #171A20             |
| 文字          | #ffffff / #d0d6e0 / #8a8f98 / #62666d        | #1d1d1f / #333 / #707070                   | #000 の alpha 100/95/90/60/40/20%  | #000 / #44403b / #777169 / #a59f97 | text #17191D / muted #667085                                        |
| accent        | #e4f222 を **主操作 1 つ** だけ              | #0071e3 を塗りボタンと選択だけ             | #0075de を **画面に 1 つ**         | 黒塗り + eggshell 枠の 2 段だけ    | #5B4CF0 / dark #8A7DFF（1 色）                                      |
| weight の上限 | 300–590（700 以上を使わない）                | 300/400/600/700（製品名に 700 を使わない） | 400–700                            | 見出し 300、本文 400、強調 500     | 400–700（workspaceTitle 700、semibold 72 箇所、bold 2 箇所）        |
| tracking      | -0.022em（48px 以上）                        | 本文 -0.016em                              | display だけ負、本文は normal      | 見出し -0.02em、本文 +0.01em       | 見出し .kerning(0.6)（大文字ラベル）以外は default                  |
| radius        | 2 / 4 / 6（button・input）/ 12（card）/ pill | 8（card・input）/ 980（button）            | 4 / 8（button）/ 12（card）/ pill  | 4 / 4–10 / 20（card）/ 24 / pill   | tokens 8 / 12 / 16、view の literal に 5 / 6 / 7 / 9 / 10 / 14 / 24 |
| 縁            | 0.5px hairline #23252a / #383b3f             | 影なし（card / button / nav に付けない）   | 1px rgba(0,0,0,.08)、card に影なし | 1px #ebe8e4、影は 1px 級のみ       | hairline 0.5〜1、white 0.14（Dock）                                 |
| 影            | 分離には使わない（inset と hairline）        | 製品写真だけ                               | nav に 3px/9px の極薄              | ボタンに 1px + 2px/4px の極薄      | 窓: NSWindow の影（floating のみ）。view: §3 の一覧                 |
| 間隔          | 4 の段。要素 8、card 24                      | 4 の段。要素 12、card 24                   | 4 の段。要素 8、card 24            | 4 の段。要素 8–16、card 32         | base 8 / compact 4 / card 18 / large 24、Dock padH 20 / padV 16     |

読み方: 4 つの参照が **揃って言うこと** が仮説として強い。

1. accent は画面に 1 つ、主操作だけ（4/4）。Genie は既に 1 色。
2. card / panel を **影で分けない**。hairline で分ける（4/4）。Genie の窓の中には
   まだ view 影が残る（§3）。
3. radius の語彙は 3 つ前後（Linear 3 / Apple 2 / Notion 3）。Genie は token 3 に対し
   literal が 7 種類（§3）。
4. weight は低い帯で組む。Linear ≤ 590、ElevenLabs 見出し 300。Genie の semibold 72 箇所は
   多い可能性がある（仮説。判定は §4）。

まだ写していない候補: Cursor、Raycast、Granola、Mercury、Dub（Refero に在るが未取得）。
**型ごとに 3〜5 件** に増やすのは Refero MCP を接続してから行い、取得日と URL を残す。

## 2. Elevation（状態で決まる高さ）

影は **面の役割** で決まり、飾りには使わない。

| 状態                                                              | elevation | 実装                                                                                                                  |
| ----------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| Compact Dock（idle / app-context）                                | 0         | `Elevation.attached`（`NSWindow.hasShadow = false`）                                                                  |
| Expanded Dock（listening / agent / confirmation / meeting notes） | 0         | 同上。画面の縁に付属する面は浮かせない（造形⑧、3/3）                                                                  |
| Recording Workspace（他アプリの上）                               | 1         | `GeniePanel` の `hasShadow = true` だけ。view の 0.17/30 は二重だったので外した（§3）。中の札（文字起こし・資料）は 0 |
| Workspace の中の pill（TaskDock）                                 | 0         | 凹みに納まる面の一部。影 0（fcd050c）                                                                                 |
| Main window（Home / Library）                                     | 1         | 通常の NSWindow                                                                                                       |
| 2                                                                 | 使わない  | 必要になったら理由を DS に書いてから                                                                                  |

規則: **shadow を既定の階層表現にしない。** 面の中で要素を分けるのは hairline と字の重さ。
`Elevation.swift` の enum 以外に影の出所を増やさない。

## 3. いまの Genie が参照から外れている所（棚卸し、2026-09-03）

修正の指示ではない。**仮説の材料**として列挙する。直すかどうかは §4 の手順で決める。

- view に描いている影（`grep -rn "\.shadow(" Sources/GenieMac`）:
  `ConfirmationCardView:69`（0.2/24）、`HomeView:60`（sheet、0.22/40）、
  `GenieOrb:11`（accent の光。質感として意図）。
  外したもの: `RecordingWorkspaceView`（窓の外形 0.17/30、`hasShadow` と二重）、
  `TranscriptPanel`（0.05/10 = 13/255、知覚の下）、`RAGDrawerView`（0.10/16、面の中の区画）。
  `RecordingIndicatorView:37` と `IntentBarView:59` は呼び出し元が無い（6 型に出ない）。
  `ConfirmationCardView:69` は `ConfirmationPresenter` から。Dock の確認カードとは別物。
  `TaskDockView:26` は 0（fixture `.detached` のときだけ 0.6）。
- radius の literal: `cornerRadius:` 10 が 19 箇所、12 が 14、7 が 4、14 が 4、6/5/2 が各 2、
  9/8/24 が各 1。`GenieControlStyle(radius:)` は 8 が 23、7 が 15、6 が 8、9 が 3。
  token は `radius.small 8 / standard 12 / taskDock 16`、`palette.radius 12`、`intentBar 16`、
  `recordingIndicator 12`、`recordingWorkspace.cornerRadius 28`、Dock `topRadius 10 / bottomRadius 18`。
- weight: `.semibold` 72、`.medium` 52、`.bold` 2（`WorkSurfaceView:50` の ✓、
  `MainWindowView:407` のアバター頭文字）。tokens の `type.workspaceTitle.weight` 700。
- 言語: 文と操作は日本語（録音中 / ライブメモを開く / メモ / 字幕 / 作業画面で続ける /
  やめる / 直す）。Linear 型の大文字ラベル（PLAN / CONTEXT / SOURCES / SUGGESTED）と
  「Ask Genie」は固有の記号として英語のまま。Cancel は「キャンセル」だと 102pt で主操作 96pt
  より広くなり造形⑤を割るので「やめる」。

## 4. 検証の手順（BEST-IN-CLASS_REFERENCE_GATE）

参照は **仮説を出す**。決めるのは Genie のゲート。造形の round はこの 5 行を持たないと始めない。

```
reference : 製品名 + URL + 引用した規則（1 文、取得日）
hypothesis: Genie のどの面の、どの値を、なぜ変えると良くなるか
measured  : いまの値（tokens.json / 実測 pt。推定は書かない）
candidates: A = いま / B / C（値を書く。「少し小さく」は不可）
gate      : 何で決めるか（下の 3 つのどれか、順番どおり）
```

判定は 3 段。上が落ちたら下へ進まない。

1. **機械が測る**（先に、盲検の前に）: `--selftest shape / geometry / occupation`、
   `pnpm lint:type-literals`、`scripts/ux-auto/alignment.py / occupation.py / primary.py`。
   面積・間隔・当たり判定・輝度差はここで決まる。輝度差 16/255 以下、白 10% の線は
   知覚の下なので候補にしない（DS-04）。
2. **盲検の panel**（`docs/ux-benchmark/auto/JUDGE_PROMPT.md`）: 観察を先に書かせ、
   tie / cannot tell を許す。観察が実測と矛盾した判定者は捨てる。1 型 = 1 票。
   2 名で ±3 軸ぶれるので、1 型の数字を単独で読まない。
3. **golden の更新**: 採用したら `docs/golden-screenshots`（light / dark / task-dock）と
   `geometry` を撮り直し、差分が意図した箇所だけであることを diff で確かめてから commit。

`--selftest density`（`docs/evidence/density-baseline.json`）は「地の色に近い画素」を
空きと数える歯止めなので、**飾りの地色や塗りのボタンを外すと "空いた" と出る**。
§0 の「飾りの影・地を敷かない」を実行するとここに当たる。そのときは落ちた面だけ
基準を書き直し、外したものが何かを commit に書く（d9d9f36 の右下 4 ボタン、
Home の復旧札の暖色地）。基準を上げてよいのは外したものが飾りだったときだけ。

参照が「こう言っている」だけでは値を変えない。参照どうしが割れたら（例: card radius
Apple 8 / Notion 12 / ElevenLabs 20）、**いまの値を A に含めて** 3 択で盲検にかける。
cannot tell が多数なら変えない（craft ⑦ の角丸はこれで差し戻した）。

記録先: `docs/ux-benchmark/compare/craftNN/`（prompt、画像、judge の JSON）と
`docs/ux-benchmark/auto/CRAFT.md` の表。採用した規則は `docs/DESIGN_SYSTEM.md` へ。

## 5. 試して捨てたもの（同じ仮説を二度出さない）

- 縦 gradient / graphite の Dock 素材（craft14、3 名 cannot tell）
- 白 10% の境界線（3 名「線は無い」）
- 角丸の変更（craft ⑦、2 名 cannot tell）
- 群を余白で分ける（群の数は変わって見えない）
- 主操作の彩度・寸法を上げる（craft ①、改善なし）
- Dock 幅 520（本文が折れて面積が減らない。実測で棄却）
- Task Dock pill の影で「浮かせる」（sample18 で別窓に見えた。fcd050c で 0）
- 会議の詳細で要約 1 行だけを medium にする（craftL、3 名中 2 名 cannot tell。
  段は色で立った）

## 6. 触らないもの

- Action Confirmation の局所造形（①〜⑨ 完了、Genie 6 / VoiceOS 0 / 引分 1）
- idle 220x44 / app-context 320x52 / 会議バー 820x76 の寸法
- One Surface / Stop / State / Provenance / Confirmation / Recovery の構造
- 新しい画面・新しい機能（いまは「一つの製品に見える」まで磨く段階）
- radius / shadow / font weight / spacing / border を単独で動かす round
  （Craft Freeze 2026-09-03。`docs/DESIGN_SYSTEM.md` §0。効いたのは構造・寸法・意味だけだった）
- Compact Meeting Mode を 4 段目の状態として足すこと（会議バー 76 / ライブメモ 357〜460 /
  作業画面の 3 段で足りている。`docs/DESIGN_SYSTEM.md` §7）

## 7. 存在の印と色の役割（TaskDock 1b、2026-09-28）

仮説として採用し、§4 の手順で確かめる。reference: Alcove（連続した変形）/ ElevenLabs UI（声と作業の描き分け）/
Apple Liquid Glass（素材は入口だけ、読む面は安定）。候補は A＝現行 / B＝形と動きだけ / C＝B＋真鍮の素材。B を採る。

**印は 1 つ。** `VoiceTaskDockView` が中身の外に `GeniePresenceMark` を 1 つだけ置く。面の変形で中身は
消えて戻るが、印は消えずに左上に居続ける。各 Dock は `DockMarkSlot` で場所を空けるだけ。

| 状態 | 印 | 伝えること |
| --- | --- | --- |
| idle | 本文色で静止（12pt） | 呼び出せる入口 |
| listening | 輪郭が入力音量で伸縮、右に波形（presence） | 聞いていること・認識中の発話 |
| thinking / agent | 内側を presence がゆっくり流れる、下辺に細い流れ | 作業名・段階・停止（進捗率は出さない） |
| confirmation | 印を出さない、動きなし | 何を、どこに（§6 のとおり触らない） |
| result | 静止。「できた」ときだけ一度膨らむ | 何ができたか・どこに・開く |
| 失敗・中止 | 静止 | できなかったこと・失われていないもの・次の操作 |

時間: 変形 `dockResizeMs 180` は据え置き。呼び出しの伸び `markStretchMs 220`、受付・完了の反応 `markAckMs 320`。
Reduce Motion / `--selftest` では動かさず、静止形で描き分ける（listening は輪郭、working は内側の青を中央に止める）。

**色の役割**
- `presence`（light #1C7FA8 / dark #48BCEC）: 印の内側・波形・流れ・Dock の段の点だけ。**文字色にしない。**
- `accent`（light #1C6FA0 / dark #3E95D0）: 選択状態・リンク・強調の文字。紫（#5B4CF0 / #8A7DFF）から青へ移し、
  presence と同じ系統にそろえる。light は白地で 4.5:1 以上。dark の塗りに白文字を載せる所（`borderedProminent`・
  PersonalizationInspector・AvatarHUD）は 3:1 前後なので、盲検と機械の測りで確かめる。
- 主操作の塗りは従来どおり（確認は危険度の色、§6）。success / warning / danger は変えない。
- 真鍮（C 案）は採らない。アイコン・紹介映像で使う場合も、アプリの面には持ち込まない。

**Dock を静かにした所**
- Agent: 経過時間・段数・進行帯・PLAN 見出し・CONTEXT を外し、作業名＋段階＋停止にした（作業画面で見られる）。
- Result: 1 行目に「<種類>ができました / できませんでした / 止めました」、2 行目に題、3 行目に場所・理由。
  失敗・中止で仕事の結果なら「依頼は仕事の一覧に残っています。」を足す。操作は開く系を先頭に。

## 8. 例外のカード（回答面の中の、種類ごとの段）

§6 の「新しい画面・新しい機能」の例外として、本人が承認したもの。天気・ニュース（2026-09-27、
`docs/ux-benchmark/compare/info-card/ROUND.md`）、近くの店の地図と、今後の株価・TODO・予定・メールの返信・
音楽（ジャケット・プレイリスト）（2026-09-30）。どれも **新しい窓ではなく、回答面の中身の型** として作る。

- 窓を足さない。幅は回答面と同じ `voiceHud.resultWidth` 520（会話中は聞く面の幅）。
- 高さは中身の実寸（DS-01）、上限は `voiceHud.cardMaxHeight` 360（確認面と同じ理由）。上げるなら §4 の round で。
- 外側は `DockCardScaffold` だけ（見出しの図形＋題、コピー、会話中は隠す ✕、出所と取得時刻、会話の行、Esc）。
  種類は `DockCard` の case と、その中身の view だけで足す。
- 数字・画像は取得元の値だけ。出所と取得時刻を必ず出す。取れないときは文だけの回答面に戻す。
- 外へ出る操作（送信・注文・再生先の変更など）は `Confirm.approve` を通す。カードのボタンが直接実行しない。
- 会話（Gemini Live）へ返すのは件数・状態の文だけ。カードの中身（店名・住所・本文）は返さない（`docs/privacy-egress.md`）。
- 状態を足したら `--selftest dock8` の撮影と golden（`task-dock/`・`task-dock/dark/`、既存は上書きしない）、
  `--selftest occupation` の上限に加える。
