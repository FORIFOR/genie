# 限定委任 UI — 2026-10-02

対象は未commitのmacOS差分。`TransactionAuthorizationTests` の模擬ピザ2点・JPY・模擬配送先の固定fixtureを使用し、実注文・決済は行っていない。

- Swift `TransactionAuthorizationTests|ApprovalBoundaryTests|ContinuousSurfaceTests`: 39件 PASS。既定が今回のみ、GETだけで作成しない、正確な固定scope、数値検査、通信不明時の同じrequestId/body、二重approveなし、未確認結果、保存済み使用量と取消を検査。
- Native fixture: 自身の非アクティブpanelのみを表示。CGWindowListのon-screen掲載、前面アプリPID不変、内容が実窓の高さ内に収まることを検査。本人のアプリや画面の画像は取得していない。
- 実測: 今回だけ560×291pt、同じ条件で任せる560×340pt。既存の確認面360pt上限を維持。委任の本文だけ最大160ptでスクロールし、今回を含む回数・累計と期限を示す。
- 画像: `docs/golden-screenshots/transaction-delegation/` の light/dark・once/bounded 4枚と `geometry.json`。4枚を開いて実装担当が目視。主ボタンと入力ラベルは欠けず、固定条件の続きは本文スクロールで確認する構造。独立目視・HTTP/本番helperまでのE2Eは別担当の結果を採用する。
- `verify-approval-boundary.sh`: 違反0。`lint-type-literals.mjs`: PASS。従来の承認証拠を生成する入口1、通常APPROVED送信1を維持。限定許可POSTは表示したカードのボタンからのみ呼び、成功時は通常approveを重ねて送らない。

再現コマンド（native fixtureは他のUI検査と同時に走らせない）:

```sh
GENIE_TRANSACTION_NATIVE=1 \
GENIE_TRANSACTION_GOLDEN_DIR="$PWD/docs/golden-screenshots/transaction-delegation" \
swift test --package-path apps/genie-macos \
  --filter 'TransactionAuthorizationTests|ApprovalBoundaryTests|ContinuousSurfaceTests'
```

これはfixtureの表示・状態・transport契約検査であり、実サービス、他端末で解決した確認カードの同期、人間の初心者評価を合格とする証拠ではない。全体のverify-allと実アプリE2Eはroot担当。
