import AppKit

/// NSApplication-based apps need a responder-chain Edit menu too. A TextEditor
/// alone does not install Copy/Paste/Select All keyboard equivalents.
@MainActor final class ApplicationMenu: NSObject {
    static let shared = ApplicationMenu()

    func install() {
        let menu = NSMenu()
        let appMenu = NSMenu(title: "Genie")
        let appItem = NSMenuItem(title: "Genie", action: nil, keyEquivalent: "")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let settings = NSMenuItem(title: Facts.menuSettings, action: #selector(showSettings), keyEquivalent: ",")
        settings.target = self; appMenu.addItem(settings)
        let guide = NSMenuItem(title: Facts.menuGuidedSetup, action: #selector(showPermissionGuide), keyEquivalent: "")
        guide.target = self; appMenu.addItem(guide)
        let oathra = NSMenuItem(title: "Oathraと連携…", action: #selector(showOathra), keyEquivalent: "")
        oathra.target = self; appMenu.addItem(oathra)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: Facts.menuQuit, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let edit = NSMenu(title: "編集")
        let editItem = NSMenuItem(title: "編集", action: nil, keyEquivalent: "")
        editItem.submenu = edit; menu.addItem(editItem)
        edit.addItem(withTitle: "取り消す", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "やり直す", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "すべてを選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let windows = NSMenu(title: "ウインドウ")
        let windowItem = NSMenuItem(title: "ウインドウ", action: nil, keyEquivalent: "")
        windowItem.submenu = windows; menu.addItem(windowItem)
        windows.addItem(withTitle: "閉じる", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windows.addItem(withTitle: "しまう", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windows
    }

    @objc private func showSettings() { SettingsWindowController.shared.show() }
    @objc private func showPermissionGuide() { SettingsWindowController.shared.show() }
    @objc private func showOathra() { OathraConnectionWindow.shared.show() }
}
