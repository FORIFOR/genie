# Genie Design System — 決まっている規則と、その根拠

## 0. 最上位原則 — Genie は装飾ではなく、構造・寸法・意味で美しくする

Genie の造形は飾って良くならない。**情報構造と物理寸法が正確なほど良くなる。**
局所の造形 9 段（`docs/ux-benchmark/auto/CRAFT.md`）と、6 つの型を横断した
DS-01〜05（同 末尾、`docs/ux-benchmark/compare/SAMPLES.md` Sample 11〜16）、
磨きの 7 チケット（Sample 20）と横展開（craftL / Sample 21）で確かめた。

効いたもの: 情報階層 / 実寸で決まる面の寸法 / accent の意味の整理 / 当たり判定 /
出所（provenance）。
効かなかったもの: 飾りの区切り線 / 余白の微調整 / 主操作のさらなる強調 /
隣り合う段の weight 差 / 角丸 / gradient 素材 / 影で浮かせる。

**Craft Freeze（2026-09-03）**: radius / shadow / font weight / spacing / border を
単独で動かす round はもう回さない。動かすのは、構造（列・段・出所）か寸法（token）か
意味（accent が何を指すか）を変える理由があるときだけで、その場合も §4 の手順を通す。
解除は `CRAFT_FREEZE_OVERRIDE` の 3 条件が同時に成り立つときだけ:
journey の失敗が起きている AND 原因が visual grammar に特定できる AND
既存の構造・寸法・意味の修正では解決できない。「何となく直したい」では戻らない。
再確認（2026-09-03、Journey 第 2 回）: 操作ガイド 10 面（Home / Meeting Dock / Notes /
Workspace / Library / Listening / Running / Confirmation / Done / Recovery）を測定と盲検で
見直し、**新しい FIX は 0**。VERIFY だった 2 つは実測で閉じた——Dock → Notes → Workspace は
`--selftest surfacemotion` で同一 CGWindowID 100% / 上辺 0pt / 欠け frame 0（PASS、体感は
NOT_MEASURED のまま）、Home の主入口は盲検 3 名が 3/3 で入力欄を指した。凍結の対象に
Home の階層 / 確認面の寸法 / Library の accent / 主操作の強調 / Compact Meeting Mode を
明示して加える。**測れていない主観（perceived）を理由に面を変えない。**
Library / Running / Confirmation / Recovery は Genie らしさの核で、触るほど退行の危険が高い。
再確認（2026-09-04、P0 Privacy・NAV 4 タブ・Calendar purpose-first のあと）: **新しい FIX は 0、
CRAFT_FREEZE_OVERRIDE は NO**。以後 UI の改善案は作らず、実機で未測定のもの（Full Keyboard Access /
VoiceOver / 実 TCC / 実会議の録れ方）を閉じる。失敗が出たときだけ、Evidence A/B が取れるときだけ、
最小修正（`docs/ux-benchmark/REALITY_GATES.md`）。
次の段は面の局所ではなく、Home → Listening → Task Running → Confirmation → Done、
Meeting → Notes → Workspace → Library → 出所の確認、という一連の遷移を一つの製品として
見る（continuity / task-adaptive sizing / grammar・用語の一貫性 / provenance の連続 /
recovery / keyboard safety / perceived complexity）。ここには **決まった規則** と **試して捨てたもの** だけを書く。
値の正本は `shared/design/tokens.json`（→ `pnpm -s gen:design-tokens` で
`GeneratedMetrics.swift` / `GeneratedMetrics.cs`）。目指す方向と、面ごとに借りる
参照、参照から出た仮説の検証手順は `shared/design/DESIGN.md`。

## 1. 面の高さは中身で決まる（DS-01）

- ノッチのある macOS 画面では、Dock の窓の高さにその画面の
  `NSScreen.safeAreaInsets.top` を加える。背景の上端は画面上端のまま、
  中身は安全領域の下へ置く。token は中身の寸法であり、機種固有の値は写さない。
  2026-09-08 の実機では 32pt。18 Dock 状態で移動後の中身が画素比較で一致し、
  外部画面の inset=0 は配置テストで確認した。AX 要素測定は許可後に6状態で
  再測定・照合済み。実ディスプレイ間の移動確認は未完了。記録: `docs/ux-benchmark/compare/notch-safe-area/ROUND.md`。

- Dock のどの状態も **高さ = 中身の実寸 + inset**。推定式を持たない
  （`DockContentMeasure`）。固定値は Dynamic Island そのもの（idle 44 / 棚 52）と、
  生きて増える一覧を scroll で見せる会議の展開面 460 だけ。
- 根拠: 固定値だったころ listening は中身 47 に対し面 120、thinking は 19 に対し 88。
  **中身の無い部分が面の 40〜60%。** 「余白が広い」「浮いている」は飾りではなく
  この寸法の誤りだった（commit 2a5cdb6 / 8fc8753）。
- 確認カードは `confirmHeight` 176 を底に中身で伸びる。286 → 229 → 254（padV 16）。
  高さ上限 360 / 幅上限 620 は `--selftest confirmflow` が測る。

## 2. 字は段からしか取らない（DS-02）

| 面                               | 段         | 値                                                                                                                              |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 窓（Main / Recording Workspace） | `type`     | workspaceTitle 32 / pageTitle 28 / sectionTitle 22 / cardTitle 18 / primary 17 / body 16 / secondary 14 / micro 12 / caption 11 |
| Dock                             | `dockType` | title 20 / speech 18 / primary 16 / row 15 / meta 13 / label 11                                                                 |

- 同じ役割は同じ段。会議の題は Workspace でも詳細でも 22。最新の発言行は
  note の項目と同じ 16。
- `scripts/lint-type-literals.mjs`（`pnpm lint:type-literals`、verify-all に含む）が
  6 つの型を描く view の `.font(.system(size: <数字>` を落とす。
  `Image(systemName:)` の寸法は図形なので対象外。
- 根拠: Workspace は 1 面に 9/10/11/12/13/14/15/16/24 の 9 段を持っていた。
  12・13・14・15 は「別の段」ではなく「揃っていない」に見える（commit ab97327）。
  10.5pt の Dock label は知覚の下（CRAFT.md）。
- accent は、その面で**鍵になる 1 つの列**にだけ。
  - 結論を読む面（会議の詳細）では引用 [n]・選ばれたタブ・選択行。話者 8 行を accent
    から muted へ落とすと、盲検 3 名全員が「最初に目が行く場所」を名前の列から題へ
    移した（`compare/craftL`、本文列の accent 画素 1044 → 353。証拠の強さは B-:
    有効な判定者が opus 3 名のみ。sonnet 1 名は色差を見ていない）。
  - 生きている文字起こし（作業画面）では話者の列。同じ変更を当てると attribution が
    有効 3 名全員で下がり、戻した（`compare/sample21`）。同じ表でも面の役割で色の
    意味が変わる。
  - 要約 1 行だけ medium にする段（+19% の暗画素）は 3 名中 2 名が見えず、入れない。

## 3. Dock の縁は 1 つ、縁は行間より広い（DS-03）

- Dock の **全状態** の外側 inset は `voiceHud.padH` 20 / `padV` 16 から取る。
  内側の隙間（行間 8、群の中の 5〜9）は literal のまま。
- 根拠: 実測で確認カードの行間は 11.7pt（VoiceOS 9.5）なのに縁は 12〜13pt
  （VoiceOS 20〜28）。**密度の差は行間ではなく縁にあった。** 内が外より広いと
  穴に見える。padV 12 / 16 / 20 を盲検で比べ、観察が実測と一致した 2 名がともに
  12 を最下位、16 と 20 で割れたので小さい方（`compare/craft13`）。
- 幅 520 は本文が折れて高さが 268 になり面積が減らないので、判定にかけず実測で棄却。
- 触らないもの: idle 220x44 / app-context 320x52 / 会議バー 820x76。

## 4. 素材は平らな黒、面は画面に付属する（DS-04・造形⑧）

- `DockSurface`: fill black 0.80、hairline white 0.14、上辺の内側光 0.10。
  gradient / graphite は付けない。
  - 例外（2026-09-27、本人の決定）: macOS 26 以上で「透明度を下げる」がオフのときだけ、
    外殻を Liquid Glass（`glassEffect(.regular)`）にし、その上に黒 0.62 を重ねる。
    中身は変えない。面の輝度は平らな黒と同じ帯（`compare/liquid-glass`）。
- 画面の縁に接した面（Dock）は **影で浮かせない**（造形⑧、3/3）。
  Task Dock の pill は Workspace の凹みに食い込むので影あり（別の面ではない）。
- 根拠: 縦 gradient（0.72→0.88）と graphite（0.17→0.07）を 3 名が盲検で
  **cannot tell**。輝度差は 10〜16/255（`compare/craft14`）。競合の「gradient dark
  surface」は影と壁紙の対比を読んだもので、⑧ で選ばなかった側。
- 同じ理由で捨てたもの: 境界線 白 10%（3 名「線は無い」）、角丸の変更
  （2 名 cannot tell）、群を余白で分ける（群の数は変わって見えない）。

## 5. 図形と操作の重さは役割の順（造形⑤⑨）

- 主たる操作: 塗り + `confirmPrimaryMinWidth` 96。副の操作（やめる / 直す）は
  文字だけ、枠を付けない。
- 図形の重さ: 説明する図形 < 押せる図形 < 重い（警告）図形。飾りと警告が同じ
  重さにならない。
- 警告（「外部に出る」）は題の下の独立した段（造形②）。

## 6. 測ってから決める

- 判定は観察を先に書かせ、tie / cannot tell を許す（`auto/JUDGE_PROMPT.md`）。
  観察が実測と矛盾した判定者は捨てる（craft13 の j1）。
- 面積・間隔・当たり判定は機械が出す（`scripts/ux-auto/alignment.py` /
  `occupation.py` / `primary.py`）。輝度差 16/255 以下・白 10% の線は知覚の下。
- ゲートは **壊して落ちるのを見てから** 入れる（type lint 76 → 0、shape 292 の潰れ、
  confirmflow 900x400）。
- 2 名 panel は同じ絵で ±3 軸ぶれる（sample07 / 14 / 17）。1 型の数字を単独で読まない。
  競合素材は絵を見て有効か確かめる（sample08 / 15 は空のパネルだった）。
  標本の切り抜きも絵を見て確かめる（sample13 は「録音中」が切れて波形が孤立していた）。

## 7. 面は宣言した寸法より大きくならない（占有）

- screen_occupation は採点者に訊かない。6 状態の窓の実寸を `tokens.json` の寸法と
  突き合わせ、1pt を超えて上回ったら落とす（`--selftest occupation`、verify-all に含む）。
  `geometry` の基準は `--record` で書き直せるが、この上限は token を変えない限り動かない。
- 実測（2026-09-02、割合は 13 インチの最小画面 1440x900 に対して）:

| 状態                  | 実寸     | 占有  | 上限（token）                |
| --------------------- | -------- | ----- | ---------------------------- |
| idle                  | 220x44   | 0.7%  | dockIdle 220x44              |
| listening             | 600x79   | 3.7%  | dockListening 600x120        |
| task dock（3 行）     | 720x271  | 15.1% | dockAgent 720 x (190 + 36·3) |
| meeting bar           | 820x76   | 4.8%  | dockMeeting 820x76           |
| meeting notes（展開） | 820x460  | 29.1% | dockMeetingExpanded 820x460  |
| recording workspace   | 1080x680 | 56.7% | workspace 1080x680           |

- 根拠: 採点者は面積を版面から**推論**する。craft3 で 3 名が「C は背が高い」と
  言い、実寸は 3 枚とも同じ。sample11〜17 では 5 型中 3 型が cannot tell。
  上限を 190 に下げて走らせると `03-task-dock 720x271 > 上限 720x190` で落ちる
  （ゲートが効くことを先に見た）。

### 会議面は 3 段で、4 段目（Compact Meeting Mode）は作らない

批評の「必要情報が少ない → Compact Meeting / 増える → Expanded Meeting /
複雑な作業 → Workspace」は、**すでにある 3 段**で満たしている（新しい画面は §6 で禁止）:

| 段                 | 実寸（2026-09-03、`--selftest occupation`） | 決め方                                           |
| ------------------ | ------------------------------------------- | ------------------------------------------------ |
| 会議バー           | 820x76                                      | 固定（Dynamic Island と同じ、DS-01）             |
| ライブメモ（展開） | 820x357（4 件）〜 820x460                   | 中身の実寸（5d97f90）。460 に当たってから scroll |
| 作業画面           | 1080x680                                    | 3 列の作業面                                     |

- 「Compact Meeting」に当たるのは、中身が少ないときのライブメモ（357）そのもの。
  DS-01 で高さを中身に任せたので、別の状態を持つ理由が無い。
- 入る条件は「craft を 6 型へ適用したあと、まだ会議面だけ負け続けるなら」だった。
  Sample 20 で live_captions は 7/0、meeting_controller は 4/2（craft は引分）で、
  条件を満たしていない。
- 動かすなら token（`dockMeeting` / `meetingExpandedHeight`）と §4 の round で。
  画面を足さない。

## 8. 同じものは同じ語で呼ぶ（DS-06、Journey Phase）

- 画面に出る語は 1 群 1 語。面ごとに言い換えない（Dock で「やること」と言った
  ものを Library で「アクション」と呼ぶと、同じ会議を見ているのに別のアプリに見える）。
  `scripts/lint-terms.sh` が文字列リテラルを見て落とす（verify-all に含む）。

| 群       | 語           | 捨てた語                                    |
| -------- | ------------ | ------------------------------------------- |
| 決定     | 決まったこと | 決定事項                                    |
| 行動     | やること     | アクション / アクション項目                 |
| 問い     | 質問         | 宿題                                        |
| 気がかり | 懸念         | —                                           |
| その他   | メモ         | ノート                                      |
| 根拠     | 出所         | 出典 / 根拠                                 |
| 許可     | 画面収録     | 画面の読み取り（設定・OS と同じ語に寄せた） |

- 出所の連続: 拾ったもの（決まったこと・やること…）は **[番号]** を持ち、番号は
  文字起こしの **誰の・何時の行** に結ばれる。番号の無い行に [0] を付けない
  （結べなかった要約は番号を出さない）。Dock → Workspace → Library → 出所 → 開き直し
  の 7 段で同じ会議 id が通ることを `--selftest journey JB` が層 A で見る。
- 逃げ道の鍵は面を問わず Esc、外へ出る操作は ⌘Return だけ、Return は何もしない
  （`journey JA`）。1 つの判断に面は 1 枚（`journey JC` の確認）。
- 失敗は Dock の結果面に「何ができないか」と次の一手を出す。理由だけの面・
  開けないカード・戻らない Dock は行き止まりで、`journey JC` が落とす。
- 根拠と経緯: `docs/ux-benchmark/journeys/PHASE2-JOURNEY.md`。
- 押せる語・見出し・許可名・鍵の表示は `UserFacingFacts`（`App/UserFacingFacts.swift`）が正本で、
  画面もメニューも `--selftest facts` もそこから引く。鍵は `UserShortcut`（⌘↩ / esc）と
  `GlobalShortcut.label()`（⌥Space）が表示と実際の鍵を 1 つの定義で持つ。操作ガイド
  （`docs/guide/build.py`）は `fact("key")` / `shortcut("key")` でしか画面の語を書けず、
  `scripts/verify-guide-facts.sh`（verify-all に含む）が、写し違い（一字違い・古い綴り・
  文字で書いた保護語・知らない key）を落とす。台帳は `docs/guide/FACTS.md`。

## いまの立ち位置（sample11〜19、6 型）

```
visual_craft 5/6（前 2/6、raw 4/6）  hierarchy 5/5  state 4/4  provenance 5/6
fragmentation 3/5  control 3/5（負け 0）  density 2/5（負け 1）  occupation → §7 の寸法ゲート
action_confirmation  Genie 6 / VoiceOS 0 / 引分 1
```

sample11〜16 の時点は craft 3/5・hierarchy 4/4・provenance 4/5・fragmentation 3/4・
density 2/4（`compare/aggregate.json` の履歴）。

DS の外の課題は 4 つとも片付いた: post_meeting の戻る手段と fixture の量（547dd40）、
meeting_controller の標本の切り抜き（sample17: 4/1/2、craft は引分）、
screen_occupation の寸法ゲート化（§7）、transcript_attribution の競合素材
（sample18: 動画 webp の 30 コマ目。5 軸で Genie 3 / 競合 1 / 引分 1）。
post_meeting は 547dd40 の絵で採点し直した（sample19: Genie 4 / 競合 2 / 引分 2、
前は 2 / 5）。「戻る手段が無い」「右パネルが上端に寄る」は 2 名から消え、
craft は 2 名一致で Genie（列の揃いは実測 x=295 で確認）。
6 型を揃えた visual_craft は **Genie 5 / 競合 0 / 引分 1**（raw 4 / 1 / 1）。
残る負け筋は 2 つ: fragmentation の「上部の黒いバーが本体と別の窓に見える」
（造形⑧で選んだ側。戻さない）と、post_meeting の 3 列（§7.1 の設計）＋
窓だけの撮影が壁紙の上の小窓に占有で負けること（素材の非対称。§7 で実寸を測る）。
