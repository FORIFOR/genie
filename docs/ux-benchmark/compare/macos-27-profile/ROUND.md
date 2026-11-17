# macOS 27.0.1 の明示的な描画環境基準 — 2026-10-02

reference : [DESIGN_SYSTEM.md DS-01](../../../DESIGN_SYSTEM.md) と [承認済み notch round](../notch-safe-area/ROUND.md) の実寸、[presence-mark 第2版](../presence-mark/ROUND.md) の本人指定の青・印、[transcript-modes](../transcript-modes/ROUND.md) の2項目化。今回参照するのは保存済みの実画像と採用記録（2026-10-02確認）。
hypothesis: macOS 27.0.1・2x・safe-top 32pt の基準を現在の固定ソースで別プロフィールとして記録すれば、旧 root 基準のブランド・構成・物理 safe area の差を製品退行と取り違えず、同じ 0.5% 画素／2pt 実寸の gate を維持できる。製品の寸法・文字・色はこの round では変更しない。
measured  : 保存済み候補は idle 220×76px、listening/preparing 600×100px、capture-layout topInsetPx=32（撮影は1px=1pt）。承認済み macOS 26.6.2 safe-top-32 も同寸法。workspace 1080×680、meeting detail 1240×820。旧root参照の220×44／600×53はこの環境の比較基準ではない。最終候補の明暗10面ずつは新規撮影済み、独立目視で欠け・重なり無し。AX実寸はpreview bundleが未許可でSKIP、代替のown-process SwiftUI測定も必須識別子/状態不足でFAIL。
candidates: A=旧root参照へfallbackを継続しFAIL保持、B=既存26.6.2画像・root画像を一切上書きせず27.0.1-2x-safe-top-32の新規プロフィールを独立レビュー後に採用、C=許容差を広げる（不採用）。Bを検証対象とし、未説明の欠け・重なり・寸法差があれば基準化せず原因を修正する。
gate      : 最新releaseを単独再package→light/dark各10面とcapture-layout・AX6状態・shape/occupationを採取→旧root/承認済safe-areaとの三者比較と変更由来を独立レビュー→採用する全画像・geometry・source/binaryのhashと根拠をprovenanceへ記録→新プロフィールでgolden/geometry/densityを再実行。画素0.5%、実寸2pt、density1.5ppの許容差は維持。完全gate完了前のcommitは行わない。

## 状態と範囲

**採用前。** [独立した旧FAILレビュー](../../../quality/evidence/2026-10-02-completion/HISTORICAL_GOLDEN_REVIEW.md) は明るい10面・旧root10面・承認済HUD3面を確認した記録であり、最終ソースやdark画像を承認するものではない。旧FAILとその画像を保持する。

safe-areaによる高さと、本人指定の青・印・翻訳2項目の構成変更は記録で説明できる。meeting detailの左列8px差やnative chromeにはOSとソースの双方が影響しうるため、同一ソースの比較無しにOS由来と断定しない。最終候補の可読性・操作対象・実寸を別に確認する。


## 最終候補の検証補足

[明暗20面の独立目視](../../../quality/evidence/2026-10-02-completion/MACOS27_INDEPENDENT_VISUAL_REVIEW.md)は可読性と主要部分の欠け・重なりについてPASS。shapeは14文節PASS。preview bundleでAXが未許可のため6状態geometryはSKIP。公開APIで自processだけを測る案はSwiftUIの必須3IDと有効/無効状態を回収できず、[FAIL証拠](../../../quality/evidence/2026-10-02-completion/own-geometry-review/result.json)を保存して不採用とした。画素基準・geometryの書換えや許容差の緩和は行っていない。正規 `com.astra.desktop` bundleも新規data rootで読み取り確認した結果、AXは未確認だった。preview IDのみの問題ではない。新しい権限を付与せず、プロフィール採用を保留する。

## 実用 bundle の権限を使った再検証 round

reference : DS-01、既存の macOS 26.6.2 safe-top-32 基準、[実用 bundle の候補](../../../quality/evidence/2026-10-02-completion/INSTALLED_MACOS27_CANDIDATE.md) と [独立した32画像レビュー](../../../quality/evidence/2026-10-02-completion/INSTALLED_MACOS27_INDEPENDENT_REVIEW.md)。
hypothesis: 実際に許可済みの com.astra.mac を同じ署名要件で更新し、6状態の実寸と明暗の候補を別の起動で再計測すれば、権限不足だった別bundleの未実施と、現在のUIの適合を区別できる。製品寸法・色や許容差を変更しない。
measured  : 05:45–05:47 JSTの実用bundle候補は32画像・6 AX状態、必須43要素が存在。idle 220×76、listening/preparing 600×100。独立目視で欠け・重なり無し。旧safe-top-32からのaction hit area拡大、タスク表示6要素35pt移動は既存ソース変更、detail左列8px差はOSだけの原因とは断定しない。次の最終binaryで再比較するまで採用は保留。
candidates: A=過去のFAILを保持して未採用、B=独立レビュー済みの候補20画像・6 geometryを別プロフィールに採用、C=既存画像の上書きや許容差拡大（不採用）。Bは新規起動の一致確認後にのみ採用する。
gate      : 最終binaryから新規撮影・候補へのnative golden 0.5%・geometry 2pt・既存shape/occupation上限・density 1.5ppを検査。候補そのものの自己比較で合格にしない。成功した場合だけ出所とsource/binary hashを付けてプロフィールを採用し、verify-allが緑になるまでcommitしない。

## 実用 bundle 最終再検証と採用

2026-10-02 07:25–07:27 JST、`a01378c92ef466086c4e6e0c1f8263e66a9da61ec24d026c86ef6cda0f678801` を新規起動して32面を撮影。独立レビュー済み候補との明暗20面native golden、6状態geometry、shape、11面occupation、16面densityが通過した。候補densityの1回は基準採取であり比較合格には数えない。その後、承認済み候補HUD3面以外の既存13面基準を保持してdensity比較を実施した。0.5%／2pt／1.5ppは不変。

`macos-27.0.1-2x-safe-top-32` を新規追加した。コピー元の全20画像・6geometry・manifestのhashを独立レビューと照合し、新規実行9ラベル・binary・正常終了receiptが揃う場合だけ採用した。従来profileと元のFAILは保持。最新検証は [保存記録](../../../quality/evidence/2026-10-02-completion/installed-profile-recovery/result.json)、採用出所は [provenance](../../../golden-screenshots/environments/macos-27.0.1-2x-safe-top-32/provenance.json)。全体gateは実行中であり、サービス完成・リリース可の判定ではない。
