import AppKit
import SwiftUI

extension SelfTest {
    @MainActor static func initialProfileShots(_ args: [String]) async {
        let directory = args.count > 3 ? args[3] : "/tmp/astra-initial-profile"
        do {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let store = InitialProfileStore.shared
            let sections = InitialProfileSections(focus: ["Genieの開発とリリース調整。仕様レビューの依頼と実装報告を継続して担当しています。", "LUMIの導入準備。田中さんと納期・レビュー日程を調整しています。"], people: ["田中", "佐藤", "山田"], priorities: ["佐藤さんから依頼されたプロダクトレビューへの回答", "田中さんとの導入日程の確認"], workPattern: ["過去90日の予定は午後開始が多い（7/9件）"], openItems: 2)
            func fixture(_ status: String) -> InitialProfileResult {
                InitialProfileResult(id: "fixture", provider: "google", status: status, startedAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", outcomes: [
                    InitialProfileProgress(source: "google_calendar", status: status == "failed" ? "failed" : "synced", artifacts: status == "failed" ? 0 : 84),
                    InitialProfileProgress(source: "gmail", status: status == "failed" ? "failed" : (status == "analysing" ? "reading" : "synced"), artifacts: ["analysing", "failed"].contains(status) ? 0 : 100)
                ], sections: status == "failed" ? nil : sections, analysis: status == "ready" ? InitialProfileAnalysis(version: 2, status: "complete", selectedCount: 100, analyzedCount: 100) : nil)
            }
            let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 800, height: 680), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            var geometry: [[String: Any]] = []
            for dark in [false, true] {
                let host = NSHostingView(rootView: InitialProfileView().environment(\.colorScheme, dark ? .dark : .light))
                window.contentView = host; window.makeKeyAndOrderFront(nil)
                for stage in ["analysing", "ready", "editing", "failed"] {
                    if stage == "editing" {
                        guard UIProbe.tap("initialProfileEdit") else { throw URLError(.cannotParseResponse) }
                    } else { store.installForTesting(fixture(stage)) }
                    try await Task.sleep(for: .milliseconds(450))
                    host.layoutSubtreeIfNeeded()
                    if ["ready", "editing"].contains(stage), !UIProbe.exists("initialProfileConfirm") { throw URLError(.cannotParseResponse) }
                    guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { throw URLError(.cannotDecodeContentData) }
                    host.cacheDisplay(in: host.bounds, to: bitmap)
                    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw URLError(.cannotDecodeContentData) }
                    let name = "\(stage)-\(dark ? "dark" : "light")"
                    try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
                    geometry.append(["name": name, "width": host.bounds.width, "height": host.bounds.height, "bytes": png.count])
                    if stage == "failed" {
                        guard UIProbe.tap("initialProfileLater"), !store.visible else { throw URLError(.cannotParseResponse) }
                        store.connected(provider: "google")
                        guard store.visible, store.result?.status == "failed" else { throw URLError(.cannotParseResponse) }
                    }
                }
            }
            store.installForTesting(nil); window.close()
            try JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("geometry.json"))
            print("SELFTEST_OK initialprofile: 8 native captures; review/edit and defer/reopen actions verified; no external data or send")
            exit(0)
        } catch { print("SELFTEST_FAIL initialprofile: \(error)"); exit(1) }
    }
}
