import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Model-only evidence. The crop is taken from the supplied screenshot at the
/// native resolver's exact source-pixel rectangle, never chosen by the model.
enum TargetPreview {
    static func render(_ png: Data, frame: Frame, rect: CGRect) throws -> (data: Data, width: Int, height: Int) {
        func unavailable() -> Failure { Failure("target_preview_unavailable") }
        let coordinates = [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height]
        guard coordinates.allSatisfy({ $0.isFinite && $0.rounded(.towardZero) == $0 }),
              rect.origin.x >= 0, rect.origin.y >= 0, rect.width >= 1, rect.height >= 1,
              rect.maxX.isFinite, rect.maxY.isFinite,
              frame.width > 0, frame.height > 0,
              rect.maxX <= CGFloat(frame.width), rect.maxY <= CGFloat(frame.height),
              let source = CGImageSourceCreateWithData(png as CFData, nil),
              CGImageSourceGetCount(source) == 1,
              CGImageSourceGetType(source) == UTType.png.identifier as CFString,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width == frame.width, image.height == frame.height,
              let crop = image.cropping(to: rect),
              crop.width == Int(rect.width), crop.height == Int(rect.height) else { throw unavailable() }

        // Keep the entire source and the enlarged selection together in one
        // bounded image. Crop dimensions stay exact before display scaling.
        let margin: CGFloat = 24
        let maxWidth: CGFloat = 1504
        let contextScale = min(1, maxWidth / CGFloat(image.width), 650 / CGFloat(image.height))
        let contextSize = CGSize(width: floor(CGFloat(image.width) * contextScale),
                                 height: floor(CGFloat(image.height) * contextScale))
        let cropScale = min(3, maxWidth / rect.width, 700 / rect.height)
        let cropSize = CGSize(width: max(1, floor(rect.width * cropScale)),
                              height: max(1, floor(rect.height * cropScale)))
        let width = Int(max(640, max(contextSize.width, cropSize.width) + 2 * margin))
        let contextTop: CGFloat = 80
        let cropTitleTop = contextTop + contextSize.height + 28
        let cropTop = cropTitleTop + 56
        let height = Int(cropTop + cropSize.height + margin)
        guard width <= 1600, height <= 1600, contextSize.width >= 1, contextSize.height >= 1,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw unavailable() }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))

        func label(_ text: String, top: CGFloat, size: CGFloat, bold: Bool = false) {
            let font = CTFontCreateWithName((bold ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
            let attributed = NSAttributedString(string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.08, alpha: 1),
            ])
            let line = CTLineCreateWithAttributedString(attributed)
            let available = CGFloat(width) - 2 * margin
            let natural = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
            context.saveGState()
            context.textMatrix = .identity
            context.translateBy(x: margin, y: CGFloat(height) - top - size)
            // Source-coordinate labels must remain complete; scale a long label
            // down instead of truncating the exact coordinates.
            if natural > available { context.scaleBy(x: available / natural, y: available / natural) }
            context.textPosition = .zero
            CTLineDraw(line, context)
            context.restoreGState()
        }
        label("EXACT INPUT TARGET", top: margin, size: 22, bold: true)
        label("Full screenshot: the red outline marks the exact selected region.", top: 54, size: 15)
        let fullRect = CGRect(x: margin, y: CGFloat(height) - contextTop - contextSize.height,
                              width: contextSize.width, height: contextSize.height)
        context.interpolationQuality = .none
        context.draw(image, in: fullRect)

        // Screenshot coordinates have a top-left origin. CGContext's drawing
        // origin is bottom-left; invert exactly once at the annotation boundary.
        let sx = fullRect.width / CGFloat(image.width), sy = fullRect.height / CGFloat(image.height)
        let selected = CGRect(x: fullRect.minX + rect.minX * sx,
                              y: fullRect.maxY - rect.maxY * sy,
                              width: rect.width * sx, height: rect.height * sy)
        context.setStrokeColor(CGColor(gray: 1, alpha: 1))
        context.setLineWidth(8)
        context.stroke(selected)
        context.setStrokeColor(CGColor(srgbRed: 0.84, green: 0.02, blue: 0.02, alpha: 1))
        context.setLineWidth(4)
        context.stroke(selected)

        label("SELECTED REGION ONLY — enlarged exact crop", top: cropTitleTop, size: 19, bold: true)
        label("Source pixels: x=\(Int(rect.minX)), y=\(Int(rect.minY)), width=\(Int(rect.width)), height=\(Int(rect.height)) (top-left origin)",
              top: cropTitleTop + 28, size: 14)
        let cropRect = CGRect(x: margin, y: CGFloat(height) - cropTop - cropSize.height,
                              width: cropSize.width, height: cropSize.height)
        context.draw(crop, in: cropRect)
        // Outline outside the crop, keeping every displayed crop pixel intact.
        context.setLineWidth(2)
        context.stroke(cropRect.insetBy(dx: -2, dy: -2))

        guard let output = context.makeImage() else { throw unavailable() }
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded, UTType.png.identifier as CFString, 1, nil) else { throw unavailable() }
        CGImageDestinationAddImage(destination, output, nil)
        guard CGImageDestinationFinalize(destination) else { throw unavailable() }
        return (encoded as Data, width, height)
    }
}
