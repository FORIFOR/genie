import CoreMedia
import Foundation
import ScreenCaptureKit
import CoreGraphics

/// 画面文脈の取り込み（ScreenCaptureKit 映像）。「今ユーザーが何を見ているか」を Context Lens /
/// RAG に渡すため、前面ディスプレイの静止フレームを 1 枚取る。
///
/// **注意**: 実フレームの取得は署名済み .app + 画面収録許可(TCC)が要る。`SCScreenshotManager` /
/// `getShareableContent` が許可を要する。**構成（解像度・ピクセル形式）の組み立ては TCC 無しで
/// 検証できる**（`configuration()`）。正本 §3「Screen Context」。UI/UX §5: 見たものだけを映す。
@available(macOS 14.0, *)
enum ScreenContextCapture {
    /// 静止フレーム用の構成。TCC 無しで組み立てられる（検証可能）。
    static func configuration(width: Int = 1280, height: Int = 800) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.capturesAudio = false
        config.showsCursor = false
        // BGRA 8-bit。下流の画像処理・OCR が扱いやすい。
        config.pixelFormat = kCVPixelFormatType_32BGRA
        // 静止 1 枚が目的なので最小フレームレートで十分。
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        return config
    }

    /// メインディスプレイの静止フレームを CGDisplayCreateImage で取る（画面収録許可で動作、
    /// 前面セッションを要さないので headless でも取れる）。取れなければ nil。
    static func captureFrameCG() -> CGImage? {
        try? RegistrationPrivacyGuard.capture { CGDisplayCreateImage(CGMainDisplayID()) }
    }

    /// 前面ディスプレイの静止フレームを 1 枚取る。許可が無ければ throw（.app 側でユーザーが許可）。
    /// 戻りは BGRA の CGImage。文脈抽出（OCR/要約）は下流で行う。
    static func captureFrame(excludingBundleID: String? = nil) async throws -> CGImage {
        try await RegistrationPrivacyGuard.captureAsync {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                throw NSError(domain: "ScreenContextCapture", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "no display to capture"])
            }
            let excluded = content.applications.filter { $0.bundleIdentifier == excludingBundleID }
            let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            let config = configuration(width: display.width, height: display.height)
            return try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config)
        }
    }
}
