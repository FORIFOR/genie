# First main-app simulation order

2026-10-02 JST. This is integration verification, not independent product certification and not a real purchase. Candidate: dedicated `com.genie.transaction-preview` app / PID 31746, LaunchServices-scoped environment in `launchservices-native-scope.json`. Later UI/authorization changes are not covered by this candidate.

The actual main app accepted `模擬ピザを注文して`. Task `01a0f833-323e-7000-8e7f-7985ad9370f3` entered WAITING_APPROVAL. The original UI remained thinking / waiting without a usable approval card. This is a failed UI approval observation; the UI implementation owner subsequently fixed confirmation precedence and complete detail display, pending new-candidate E2E.

For the native baseline only, the verifier read the exact pending approval via the authenticated local API, then approved that fictional order through the normal task approval endpoint. Approval `01a0f833-3ad0-7000-9536-1ea829a37eea`. This API action does not count as passing the app's approval interaction.

The native provider receipt and host logs were independently inspected by the other agent: one background AX button action, one checkout click, zero checkout app activations, and matching pizza options, total JPY 1500, fictional destination and no-charge payment reference. The normal production helper consent dialog returned its allow/selection result; the logs do not identify whether the person or an automation supplied that dialog input. No unattended helper mode was used.

Task status became COMPLETED, artifact `01a0f836-666a-7000-a327-c0ee9a4440d4`. A later cancel request returned 409 because the task had already completed. **That request is not a passing cancellation test.**

Actual app observation using CUA: open Workspace → `状況を確認` changed the old waiting screen into a result document. Accessibility text showed:

- `シミュレーション: 注文を受け付けました（配達・約定完了ではありません）`
- `実際の注文・決済・株取引は行っていません。`
- Receipt `SIM-064994d3-c097-44d0-b4ae-ff4056139016`
- 模擬マルゲリータ / M、レギュラー生地 / quantity 1
- JPY 1200 + fee JPY 300 = JPY 1500
- demo-account / demo-destination / demo-no-charge / asap

The app's result content matched the independently fetched stored Markdown receipt. Manual refresh was necessary after API approval; automatic convergence from external approval is not verified by this run. The full user path remains pending rerun on the fixed UI and bounded-consent candidate.
