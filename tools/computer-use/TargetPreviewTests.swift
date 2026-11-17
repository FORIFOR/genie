import CoreGraphics
import Foundation
import ImageIO

@main struct TargetPreviewTests {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 3 else { throw Failure("expected_source_and_output") }
        let png = try Data(contentsOf: URL(fileURLWithPath: args[1]))
        let source = CGImageSourceCreateWithData(png as CFData, nil)!
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        let frame = Frame(id: "target-preview-fixture", bundleId: "org.genie.nativeinput.fixture", windowId: 1,
                          pid: 1, capturedAt: 0, width: image.width, height: image.height,
                          bounds: Bounds(x: 0, y: 0, width: Double(image.width), height: Double(image.height)), sha256: "fixture")
        let output = URL(fileURLWithPath: args[2])
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var cases: [[String: Any]] = []
        for (name, rect) in [("correct-lower", CGRect(x: 40, y: 212, width: 380, height: 120)),
                              ("wrong-upper", CGRect(x: 40, y: 152, width: 180, height: 50))] {
            let rendered = try TargetPreview.render(png, frame: frame, rect: rect)
            try rendered.data.write(to: output.appendingPathComponent("\(name).png"))
            let crop = image.cropping(to: rect)!
            cases.append(["name": name, "sourceRectTopLeftPixels": [rect.minX, rect.minY, rect.width, rect.height],
                          "exactCropPixels": [crop.width, crop.height],
                          "compositePixels": [rendered.width, rendered.height]])
            guard rendered.width <= 1600, rendered.height <= 1600,
                  crop.width == Int(rect.width), crop.height == Int(rect.height) else { throw Failure("preview_geometry") }
        }
        var rejected = 0
        for rect in [CGRect(x: -1, y: 0, width: 10, height: 10),
                     CGRect(x: 0.5, y: 1, width: 10, height: 10),
                     CGRect(x: 0, y: 0, width: 0, height: 10),
                     CGRect(x: 0, y: 0, width: image.width + 1, height: 10),
                     CGRect(x: CGFloat.infinity, y: 0, width: 10, height: 10),
                     CGRect(x: 0, y: 0, width: 10, height: -10)] {
            do { _ = try TargetPreview.render(png, frame: frame, rect: rect); throw Failure("invalid_rectangle_accepted") }
            catch let failure as Failure where failure.code == "target_preview_unavailable" { rejected += 1 }
        }
        var mismatched = frame
        mismatched = Frame(id: frame.id, bundleId: frame.bundleId, windowId: frame.windowId, pid: frame.pid,
                           capturedAt: 0, width: frame.width + 1, height: frame.height, bounds: frame.bounds, sha256: frame.sha256)
        do { _ = try TargetPreview.render(png, frame: mismatched, rect: CGRect(x: 40, y: 152, width: 180, height: 50)); throw Failure("dimension_mismatch_accepted") }
        catch let failure as Failure where failure.code == "target_preview_unavailable" { rejected += 1 }
        do { _ = try TargetPreview.render(Data("not PNG".utf8), frame: frame, rect: CGRect(x: 40, y: 152, width: 180, height: 50)); throw Failure("invalid_png_accepted") }
        catch let failure as Failure where failure.code == "target_preview_unavailable" { rejected += 1 }
        let evidence: [String: Any] = ["sourcePixels": [image.width, image.height], "cases": cases,
                                        "invalidInputsRejected": rejected, "source": "synthetic native input fixture screenshot"]
        try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("geometry.json"))
        print("GENIE_TARGET_PREVIEW_TEST_OK")
    }
}
