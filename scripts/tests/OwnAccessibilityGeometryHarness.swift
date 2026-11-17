import AppKit
import SwiftUI

private struct GeometryProbeView: View {
    var body: some View {
        VStack(spacing: 20) {
            Text("自分の画面だけを測ります").accessibilityIdentifier("swiftLabel")
            Button("有効な操作") {}.frame(width: 140, height: 32).accessibilityIdentifier("swiftEnabled")
            Button("無効な操作") {}.frame(width: 140, height: 32).disabled(true).accessibilityIdentifier("swiftDisabled")
        }
        .padding(20)
        .frame(width: 360, height: 240)
    }
}

@main struct OwnAccessibilityGeometryHarness {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let native = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 360, height: 240),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        native.title = "Genie Geometry Native Fixture"
        native.isReleasedWhenClosed = false
        let group = NSView(frame: NSRect(x: 20, y: 20, width: 180, height: 52))
        group.setAccessibilityElement(true)
        group.setAccessibilityRole(.group)
        group.setAccessibilityIdentifier("nativeFrame")
        native.contentView!.addSubview(group)
        let button = NSButton(title: "固定した操作", target: nil, action: nil)
        button.frame = NSRect(x: 10, y: 10, width: 140, height: 32)
        button.setAccessibilityIdentifier("nativeButton")
        group.addSubview(button)
        let swift = NSWindow(contentRect: NSRect(x: 500, y: 100, width: 360, height: 240),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        swift.title = "Genie Geometry SwiftUI Fixture"
        swift.isReleasedWhenClosed = false
        swift.contentView = NSHostingView(rootView: GeometryProbeView())
        native.orderFrontRegardless(); swift.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            var failures: [String] = []
            let nativeElements = OwnAccessibilityGeometry.elements(in: native)
            let swiftElements = OwnAccessibilityGeometry.elements(in: swift)
            if let actual = nativeElements.first(where: { $0.identifier == "nativeFrame" }) {
                let screen = native.convertToScreen(group.convert(group.bounds, to: nil))
                let expected = NSRect(x: screen.minX - native.frame.minX, y: native.frame.maxY - screen.maxY,
                    width: screen.width, height: screen.height)
                if abs(actual.x - expected.minX) > 0.5 || abs(actual.y - expected.minY) > 0.5
                    || abs(actual.width - expected.width) > 0.5 || abs(actual.height - expected.height) > 0.5 {
                    failures.append("Native accessibility and actual view frames differ")
                }
            } else { failures.append("nativeFrame missing") }
            for id in ["swiftLabel", "swiftEnabled", "swiftDisabled"] {
                if !swiftElements.contains(where: { $0.identifier == id }) { failures.append("\(id) missing") }
            }
            if swiftElements.first(where: { $0.identifier == "swiftEnabled" })?.enabled != true { failures.append("enabled state missing") }
            if swiftElements.first(where: { $0.identifier == "swiftDisabled" })?.enabled != false { failures.append("disabled state missing") }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            struct Report: Codable { let native: [OwnAccessibilityGeometry.Element]; let swift: [OwnAccessibilityGeometry.Element]; let failures: [String] }
            let data = try! encoder.encode(Report(native: nativeElements, swift: swiftElements, failures: failures))
            if let index = CommandLine.arguments.firstIndex(of: "--output"), CommandLine.arguments.count > index + 1 {
                try! data.write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1]))
            }
            print(String(data: data, encoding: .utf8)!)
            print(failures.isEmpty ? "OWN_GEOMETRY_OK" : "OWN_GEOMETRY_FAIL")
            fflush(stdout)
            if CommandLine.arguments.contains("--hold") {
                func describe(_ value: Any, depth: Int = 0) {
                    guard depth < 8, let object = value as? NSObject else { return }
                    let names = object.accessibilityAttributeNames()
                    let keys: [NSAccessibility.Attribute] = [.identifier, .role, .title, .value, .position, .size, .enabled]
                    var values: [String: String] = [:]
                    for key in keys where names.contains(key) { values[key.rawValue] = String(describing: object.accessibilityAttributeValue(key)) }
                    print("OWN_ATTRIBUTES \(depth) \(type(of: object)) \(values)")
                    if names.contains(.children), let children = object.accessibilityAttributeValue(.children) as? [Any] {
                        for child in children { describe(child, depth: depth + 1) }
                    }
                }
                for _ in 0..<24 {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    let updated = OwnAccessibilityGeometry.elements(in: swift)
                    print("OWN_GEOMETRY_LIVE \(updated.compactMap(\.identifier))")
                    describe(swift.contentView!)
                    fflush(stdout)
                    if let index = CommandLine.arguments.firstIndex(of: "--output"), CommandLine.arguments.count > index + 1 {
                        try? encoder.encode(updated).write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1] + ".live.json"))
                    }
                }
            }
            native.close(); swift.close()
            Darwin.exit(failures.isEmpty ? 0 : 1)
        }
        app.run()
    }
}
