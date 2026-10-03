import AppKit
import CoreGraphics
import Foundation

/// Standalone fixtures: no screen capture, application activation or injected input.
@available(macOS 14.4, *)
@main struct PointerVisualTests {
    @MainActor static func main() {
        do {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let output = CommandLine.arguments.dropFirst().first ?? "/tmp/genie-pointer-fixtures"
            try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
            var evidence = try geometry()
            try render(output: output)
            if CommandLine.arguments.contains("--native") { evidence["native"] = try native() }
            let data = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: output).appendingPathComponent("geometry.json"))
            print("GENIE_POINTER_VISUAL_TEST_OK \(output)")
        } catch {
            fputs("POINTER_TEST_FAILED: \(error)\n", stderr)
            exit(1)
        }
    }

    @MainActor static func geometry() throws -> [String: Any] {
        func luminance(_ color: NSColor) -> CGFloat {
            let rgb = color.usingColorSpace(.sRGB)!
            func linear(_ value: CGFloat) -> CGFloat { value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(rgb.redComponent) + 0.7152 * linear(rgb.greenComponent) + 0.0722 * linear(rgb.blueComponent)
        }
        let arrowContrast = (luminance(PointerMetrics.outline) + 0.05) / (luminance(PointerMetrics.accent) + 0.05)
        let badgeContrast = (luminance(PointerMetrics.text) + 0.05) / (luminance(PointerMetrics.surface) + 0.05)
        guard arrowContrast >= 3, badgeContrast >= 4.5 else { throw Failure("pointer_contrast") }
        let screens = [NSRect(x: 0, y: 0, width: 1440, height: 900),
                       NSRect(x: -1280, y: 0, width: 1280, height: 800),
                       NSRect(x: 0, y: 900, width: 1200, height: 800),
                       NSRect(x: 1440, y: -200, width: 1600, height: 1000)]
        let points = [CGPoint(x: 600, y: 400), CGPoint(x: -1100, y: 300), CGPoint(x: 200, y: -500),
                      CGPoint(x: 2000, y: 800), CGPoint(x: 1435, y: 895), CGPoint(x: -1275, y: 105),
                      CGPoint(x: 3035, y: 1095), CGPoint(x: 1195, y: -795)]
        var cases: [[String: Any]] = []
        for point in points {
            let rect = CGRect(x: point.x - 10, y: point.y - 10, width: 20, height: 20)
            let label = "Genie · とても長いアプリケーション名（テスト専用）"
            guard let layout = Marker.layout(rect: rect, primaryMaxY: 900, screens: screens,
                                             badgeSize: Marker.Ring.badgeSize(label, status: "背面 · 一時停止中"),
                                             compact: true) else { throw Failure("layout_missing") }
            let actual = CGPoint(x: layout.frame.minX + layout.tip.x,
                                 y: 900 - layout.frame.minY - layout.tip.y)
            guard actual == point else { throw Failure("pointer_tip_offset") }
            let badge = layout.badge.offsetBy(dx: layout.frame.minX, dy: layout.frame.minY)
            guard layout.screen.contains(badge) else { throw Failure("badge_outside_target_display") }
            let glow = Marker.Ring.glowBox(NSPoint(x: point.x, y: 900 - point.y),
                                           directionX: layout.directionX, directionY: layout.directionY)
            guard layout.frame.contains(glow) else { throw Failure("glow_clipped_by_panel") }
            let ring = Marker.Ring(frame: NSRect(origin: .zero, size: layout.frame.size))
            ring.tip = layout.tip
            ring.directionX = layout.directionX
            ring.directionY = layout.directionY
            let path = ring.pointerPath()
            var first = NSPoint.zero
            guard path.element(at: 0, associatedPoints: &first) == .moveTo, first == layout.tip,
                  abs(path.bounds.height - PointerMetrics.pointerHeight) < 0.001,
                  abs(path.bounds.width - PointerMetrics.pointerWidth) < 0.001 else { throw Failure("path_tip_or_size") }
            cases.append(["actionPoint": [point.x, point.y], "tipErrorPt": 0,
                          "badgeOnTargetDisplay": true, "pointerHeightPt": path.bounds.height,
                          "pointerWidthPt": path.bounds.width,
                          "glowContainedByPanel": true, "glowDiameterPt": glow.width,
                          "mirrorX": layout.directionX, "mirrorY": layout.directionY])
        }
        return ["fixture": true, "coordinateCases": cases, "physicalMultipleDisplaysTested": false,
                "pointerHeightPt": PointerMetrics.pointerHeight, "badgeTitlePt": PointerMetrics.titleSize,
                "pointerWidthPt": PointerMetrics.pointerWidth, "glowRadiusPt": PointerMetrics.glowRadius,
                "glowCenterAlpha": PointerMetrics.glowAlpha, "shape": "stemless-dart",
                "badgeStatusPt": PointerMetrics.statusSize, "moveSeconds": PointerMetrics.moveSeconds,
                "arrowWhiteOutlineContrast": arrowContrast, "badgeTextContrast": badgeContrast,
                "source": "Marker.layout / Marker.Ring.pointerPath"]
    }

    @MainActor static func native() throws -> [String: Any] {
        guard let screen = NSScreen.screens.first else { throw Failure("screen_missing") }
        let before = CGEvent(source: nil)?.location
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let point = CGPoint(x: screen.frame.midX, y: screen.frame.maxY - screen.frame.midY)
        let rect = CGRect(x: point.x - 24, y: point.y - 24, width: 48, height: 48)
        let began = ProcessInfo.processInfo.systemUptime
        guard let first = Marker.show(around: rect, window: 0, from: CGPoint(x: point.x - 120, y: point.y),
                                      target: "Pointer fixture", status: "表示確認中", animate: false),
              let ring = first.contentView as? Marker.Ring else { throw Failure("native_marker_missing") }
        let duration = ProcessInfo.processInfo.systemUptime - began
        defer { Marker.hide() }
        let second = Marker.show(around: rect, window: 0, target: "Pointer fixture", status: "表示確認中", animate: false)
        guard first === second, first.ignoresMouseEvents, !first.canBecomeKey, !first.canBecomeMain,
              ring.hitTest(ring.tip) == nil else { throw Failure("overlay_intercepts_input") }
        guard CGEvent(source: nil)?.location == before,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == front else { throw Failure("human_workspace_changed") }
        guard duration < 0.1 else { throw Failure("marker_show_blocked") }
        let moved = CGRect(x: rect.minX + 100, y: rect.minY, width: rect.width, height: rect.height)
        let animationBegan = ProcessInfo.processInfo.systemUptime
        _ = Marker.show(around: moved, window: 0, from: point, target: "Pointer fixture", status: "移動確認中")
        let animationDispatch = ProcessInfo.processInfo.systemUptime - animationBegan
        guard animationDispatch < 0.1 else { throw Failure("animation_blocks_dispatch") }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        RunLoop.main.run(until: Date().addingTimeInterval(PointerMetrics.moveSeconds / 3))
        let intermediateTipX = first.frame.minX + (first.contentView as! Marker.Ring).tip.x
        if !reduceMotion {
            guard intermediateTipX > point.x, intermediateTipX < moved.midX else { throw Failure("no_intermediate_movement") }
        }
        RunLoop.main.run(until: Date().addingTimeInterval(PointerMetrics.moveSeconds + 0.08))
        // Verify WindowServer actually lists our displayed panel, rather than
        // relying only on AppKit's desired visibility flags. No pixels are read.
        let onScreen = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]]
        let ownPanelOnScreen = onScreen?.contains { info in
            (info[kCGWindowOwnerPID as String] as? Int32) == getpid()
                && (info[kCGWindowNumber as String] as? Int) == first.windowNumber
                && (info[kCGWindowAlpha as String] as? Double ?? 0) > 0
        } == true
        guard ownPanelOnScreen else { throw Failure("pointer_not_on_screen") }
        guard let finalRing = first.contentView as? Marker.Ring else { throw Failure("animation_view_missing") }
        let finalTipX = first.frame.minX + finalRing.tip.x
        guard abs(finalTipX - moved.midX) < 0.01 else {
            throw Failure("animation_did_not_arrive_actual_\(finalTipX)_expected_\(moved.midX)_frame_\(first.frame.minX)")
        }
        guard CGEvent(source: nil)?.location == before,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == front else { throw Failure("animation_changed_human_workspace") }
        _ = Marker.show(around: moved, window: 0, from: point, target: "Pointer fixture", status: "停止後の長い状態を表示中")
        guard let updatedRing = first.contentView as? Marker.Ring,
              abs(first.frame.minX + updatedRing.tip.x - moved.midX) < 0.01 else { throw Failure("state_update_restarted_movement") }
        // Hiding the panel also removes the halo; no independent glow window exists.
        Marker.hide()
        RunLoop.main.run(until: Date().addingTimeInterval(0.04))
        let afterHide = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]]
        let stillVisible = afterHide?.contains { info in
            (info[kCGWindowOwnerPID as String] as? Int32) == getpid()
                && (info[kCGWindowNumber as String] as? Int) == first.windowNumber
        } == true
        guard !first.isVisible, !stillVisible else { throw Failure("pointer_remained_after_hide") }
        return ["samePanelReused": true, "clickThrough": true, "nonactivating": true,
                "systemPointerUnchanged": true, "foregroundUnchanged": true,
                "showSeconds": duration, "animatedShowSeconds": animationDispatch,
                "animationArrivedAtExactTip": true,
                "intermediateAnimationTipX": intermediateTipX,
                "intermediateAnimationObserved": !reduceMotion,
                "ownPanelListedOnScreenByWindowServer": ownPanelOnScreen,
                "panelAbsentFromWindowServerAfterHide": !stillVisible,
                "samePointStateChangeDoesNotRestartTravel": true,
                "reduceMotionAtTest": reduceMotion]
    }

    @MainActor final class Fixture: NSView {
        let dark: Bool
        let covered: Bool
        init(dark: Bool, covered: Bool) {
            self.dark = dark; self.covered = covered
            super.init(frame: NSRect(x: 0, y: 0, width: 760, height: 360))
        }
        required init?(coder: NSCoder) { fatalError("fixture only") }
        override func draw(_ dirtyRect: NSRect) {
            (dark ? NSColor(calibratedWhite: 0.07, alpha: 1) : NSColor(calibratedWhite: 0.96, alpha: 1)).setFill()
            bounds.fill()
            let text = dark ? NSColor.white : NSColor.black
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 18, weight: .medium), .foregroundColor: text]
            let heading = covered ? "手前のアプリで、自分の作業を続けられます" : "Genie computer use · 表示検証用フォーム"
            (heading as NSString).draw(at: NSPoint(x: 32, y: 300), withAttributes: attrs)
            ("これは操作結果を再現しない表示専用の fixture です。" as NSString)
                .draw(at: NSPoint(x: 32, y: 270), withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: text])
            let field = NSRect(x: 32, y: 150, width: 356, height: 56)
            (dark ? NSColor(calibratedWhite: 0.18, alpha: 1) : .white).setFill()
            NSBezierPath(roundedRect: field, xRadius: 6, yRadius: 6).fill()
            (covered ? "手前の文書" : "下書きを入力する欄" as NSString)
                .draw(at: NSPoint(x: 48, y: 170), withAttributes: [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: text])
            ("人のマウスとは別の青い矢印で、Genie の操作先を表示。" as NSString)
                .draw(at: NSPoint(x: 32, y: 42), withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: text])
        }
    }

    @MainActor static func render(output: String) throws {
        for (name, dark, compact, status) in [("light", false, false, "入力中"),
                                             ("dark", true, false, "入力中"),
                                             ("covered", false, true, "背面 · 画面を確認中"),
                                             ("paused", true, true, "背面 · 操作が終わるのを待っています") ] {
            let fixture = Fixture(dark: dark, covered: compact)
            let label = "Genie · Google Chrome"
            let plan = Marker.layout(rect: CGRect(x: 272, y: 162, width: 112, height: 36), primaryMaxY: 360,
                                     screens: [fixture.bounds], badgeSize: Marker.Ring.badgeSize(label, status: status),
                                     compact: compact)!
            let ring = Marker.Ring(frame: plan.frame)
            ring.compact = compact; ring.label = label; ring.status = status
            ring.focus = plan.focus; ring.badge = plan.badge; ring.tip = plan.tip
            ring.directionX = plan.directionX; ring.directionY = plan.directionY
            fixture.addSubview(ring)
            guard let bitmap = fixture.bitmapImageRepForCachingDisplay(in: fixture.bounds) else { throw Failure("bitmap_missing") }
            fixture.cacheDisplay(in: fixture.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { throw Failure("png_missing") }
            try png.write(to: URL(fileURLWithPath: output).appendingPathComponent("\(name).png"))
        }
    }
}
