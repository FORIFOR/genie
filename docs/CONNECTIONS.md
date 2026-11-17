# Native Connections

Open **Apps → Connections**, choose Google Workspace or Microsoft 365, review the information to be read, and continue in the system browser. Select the intended account. The app displays the connected account and the services actually authorized. Sending and modification permissions are separate from read access.

After connecting, **Profileを確認** starts the one-time initial profile or opens the confirmed profile. **あとでHomeへ** hides the initial-profile panel for the current session; return through Connections without starting another read. **会議の準備を頼む** prepares an editable request; it does not send it automatically. **切断** removes the provider's local and server read/send connections, preserving existing artifacts.

## Publisher configuration

Normal users should receive a configured build. Provide `ASTRA_CONNECTIONS_CONFIG=/absolute/path/connections.json` when calling `scripts/release-macos.sh`. The configuration is copied into the signed app before notarization. Use Google Desktop OAuth clients and Microsoft public desktop clients with supported account types and loopback redirect registration. The Microsoft callback uses `http://localhost:<ephemeral-port>/`; Google uses `http://127.0.0.1:<ephemeral-port>/callback`.

Supported JSON keys:

- `ASTRA_OAUTH_GOOGLE_READ_CLIENT_ID` and `ASTRA_OAUTH_GOOGLE_READ_CLIENT_SECRET`
- `ASTRA_OAUTH_GOOGLE_WRITE_CLIENT_ID` and `ASTRA_OAUTH_GOOGLE_WRITE_CLIENT_SECRET`
- `ASTRA_OAUTH_MICROSOFT_READ_CLIENT_ID`
- `ASTRA_OAUTH_MICROSOFT_WRITE_CLIENT_ID` (must differ from the read client)

The legacy Google `ASTRA_OAUTH_GOOGLE_CLIENT_ID` / `ASTRA_OAUTH_GOOGLE_CLIENT_SECRET` pair remains supported. Dedicated role-specific settings take precedence. Do not package user refresh/access tokens or Microsoft confidential-client secrets.

Local override: `~/Library/Application Support/Genie/connections.json` (0600). An operator can import a JSON file through **詳しい接続情報 → 接続設定を読み込む…**. Successful connection also makes the publisher parameters available to the local worker for token renewal. Environment variables override the bundled/local settings. Isolated selftests do not read the user's real configuration unless an explicit configuration path is provided.

OAuth provider verification, consent-screen branding and public access restrictions must be completed by the publisher before claiming unrestricted public availability. The existing test application is still labeled Genie by the providers.

## Recovery

- Renewal refused by the provider: Genie tells you once on LINE. Send 「Google をつなぎ直して」 for a personal 15-minute link, allow access in the phone browser, then paste the address of the page that fails to open (`http://127.0.0.1…`). The Mac app holds the PKCE verifier, exchanges the code and saves to the Keychain, so tokens and the verifier never leave the Mac. The Mac and Genie must be running.

- Closed/denied authorization: retry **接続**. No ungranted service is marked connected.
- Partial consent: **接続を完了** to add the remaining service.
- Network/session failure: **再確認**, then retry the connection.
- Keychain confirmation: allow the macOS request for this app's connector item, then retry. Worker reads time out instead of waiting indefinitely.
- Use the same Developer ID signature for live testing as the installed app. An Apple Development build has a different Keychain identity and can require additional consent.
