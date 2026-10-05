import AppKit

DesktopConnectionBootstrap.install()

// Genie macOS の入口。Dock アイコンを持たない overlay として振る舞う（AI レイヤー）。
// UI の状態から Window を出し入れするのは WindowCoordinator（React の状態管理はもう使わない）。
let app = NSApplication.shared
let delegate = GenieAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
