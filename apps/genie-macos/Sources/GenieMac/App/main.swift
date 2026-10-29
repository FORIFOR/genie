import AppKit

// サービスが接続の鍵を読み書きするときは、画面を出さずにここで終わる（ConnectorSecretCommand）。
ConnectorSecretCommand.runIfRequested()
// API キー・鍵（docs/SECRETS.ja.md）も同じ。キーチェーン 1 か所から、Genie 自身が読み書きする。
SecretCommand.runIfRequested()
DesktopConnectionBootstrap.install()

// Genie macOS の入口。Dock アイコンを持たない overlay として振る舞う（AI レイヤー）。
// UI の状態から Window を出し入れするのは WindowCoordinator（React の状態管理はもう使わない）。
let app = NSApplication.shared
let delegate = GenieAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
