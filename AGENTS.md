# Genie — repo rules for coding agents

UI（`apps/genie-macos`、`apps/windows`、`shared/design`）を触る前に、必ず読む:

1. `shared/design/DESIGN.md` — 何を目指すか、どの面にどの製品の作法を借りるか、
   借りたものをどう検証するか（BEST-IN-CLASS_REFERENCE_GATE）。
2. `docs/DESIGN_SYSTEM.md` — 確かめ終わった規則（DS-01〜05、占有 §7）と、試して捨てたもの。
3. `shared/design/tokens.json` — 寸法・色・段の正本。`pnpm -s gen:design-tokens` で
   `GeneratedMetrics.swift` / `GeneratedMetrics.cs` に写す。手で写さない。

造形を変える round は、DESIGN.md §4 の 5 行（reference / hypothesis / measured /
candidates / gate）を先に書く。参照が言っているだけでは値を変えない。
採用したら golden（`docs/golden-screenshots`）と `geometry` を撮り直し、
`./scripts/verify-all.sh` が緑になってから commit する。

## SNSの発信元（2026-09-13のユーザー指定）

個人アカウントからの投稿は禁止。ユーザーが承認した事業用アカウント／ブランドページだけを使う。
複数サービスの紹介用として作成されたTikTok `@foriforapps` とFacebookページ
`foriforapps`（公開プロフィールID `61593966556275`）は対象に含む。
投稿・コメント・再共有の直前に公開される発信元を確認し、不明なら下書きのままにする。
Facebookの管理者ログインとページ名義の投稿は区別する。個人タイムラインへの同時投稿や
個人の連絡先への招待は行わない。過去の「owner account」向け原稿は新たな投稿許可ではない。
詳細は [SNS運用ルール](docs/launch/SOCIAL_PUBLISHING.md) を読む。
