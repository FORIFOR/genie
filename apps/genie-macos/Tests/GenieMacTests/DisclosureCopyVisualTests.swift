import XCTest
import AppKit
import SwiftUI
@testable import GenieMac

/// Renders production views in an ordered-out window, without activation, account or network.
@MainActor enum DisclosureCopyFixture {
    static func capture<V: View>(_ content: V, name: String, width: CGFloat,
                                 height: CGFloat? = nil, scrollToBottom: Bool = false,
                                 verify: ((NSView) async throws -> Void)? = nil) async throws {
        let host = NSHostingView(rootView: content)
        host.frame = NSRect(x: 0, y: 0, width: width, height: height ?? host.fittingSize.height)
        // SwiftUI's scroll document is laid out only after attachment to a window.
        // Keep this owned window ordered out for its entire lifetime.
        let window = NSWindow(contentRect: host.bounds, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 40_000_000)
        host.layoutSubtreeIfNeeded()
        XCTAssertEqual(host.bounds.width, width, accuracy: 0.01)
        XCTAssertGreaterThan(host.bounds.height, 0)
        var geometry: [String: Double] = ["width": host.bounds.width, "height": host.bounds.height]
        if let height { XCTAssertEqual(host.bounds.height, height, accuracy: 0.01) }
        if scrollToBottom {
            func scrollViews(_ view: NSView) -> [NSScrollView] {
                (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrollViews)
            }
            let scroll = try XCTUnwrap(scrollViews(host).first { $0.contentSize.height >= 100 })
            let document = try XCTUnwrap(scroll.documentView)
            guard document.bounds.height > scroll.contentSize.height else {
                XCTFail("Scroll document was not laid out: \(document.bounds), viewport: \(scroll.contentSize)")
                return
            }
            let bottom = document.isFlipped ? document.bounds.maxY - scroll.contentSize.height : document.bounds.minY
            scroll.contentView.scroll(to: NSPoint(x: 0, y: bottom))
            scroll.reflectScrolledClipView(scroll.contentView)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(nanoseconds: 40_000_000)
            host.layoutSubtreeIfNeeded()
            geometry["documentHeight"] = document.bounds.height
            geometry["viewportHeight"] = scroll.contentSize.height
            geometry["scrollY"] = scroll.contentView.bounds.origin.y
            geometry["bottomY"] = bottom
            XCTAssertEqual(scroll.contentView.bounds.origin.y, bottom, accuracy: 1)
        }
        XCTAssertFalse(window.isVisible, "An offscreen fixture must not show a window")
        try await verify?(host)
        guard let folder = ProcessInfo.processInfo.environment["GENIE_DISCLOSURE_GOLDEN_DIR"] else { return }
        let directory = URL(fileURLWithPath: folder)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: directory.appendingPathComponent(name + ".png"))
        try JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent(name + ".geometry.json"))
    }
}

@MainActor final class DisclosureCopyVisualTests: XCTestCase {
    func testExistingConnectionPurposeCopyFitsForBothProviders() async throws {
        let dependencies = ConnectorState.Dependencies(
            configuration: { XCTFail("Rendering must not inspect configuration"); return [:] },
            read: { _ in XCTFail("Rendering must not read credentials"); return nil },
            write: { _, _ in XCTFail("Rendering must not write credentials") },
            delete: { _ in XCTFail("Rendering must not delete credentials") },
            list: { _, _, _ in XCTFail("Rendering must not query accounts"); return [] },
            register: { _, _, _, _ in XCTFail("Rendering must not register an account") },
            remove: { _, _, _ in XCTFail("Rendering must not remove an account") },
            exchange: { _, _, _, _, _ in throw URLError(.cancelled) },
            account: { _, _ in XCTFail("Rendering must not query account identity"); return nil })
        let state = ConnectorState(sources: [], dependencies: dependencies)
        for provider in ["google", "microsoft"] {
            for dark in [false, true] {
                let view = ConnectorsPane(apps: [], connections: state).purposeSheet(provider, dark: dark)
                    .background(dark ? Color.black : Color.white)
                    .environment(\.colorScheme, dark ? .dark : .light)
                try await DisclosureCopyFixture.capture(view, name: "connection-\(provider)-\(dark ? "dark" : "light")", width: 500)
            }
        }
    }
}
