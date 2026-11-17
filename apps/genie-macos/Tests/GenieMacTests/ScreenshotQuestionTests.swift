import AppKit
import XCTest
@testable import GenieMac

@MainActor
final class ScreenshotQuestionTests: XCTestCase {
    func testChosenImageAndTextSurviveNewCaptureAndNavigation() throws {
        try withStore { store, directory in
            let first = try capture(store, directory, "first")
            let nav = MainNav()
            nav.intentDraft = "原因と対処方法を教えて"
            nav.select(.library)
            nav.prepareScreenshotQuestion(first)
            XCTAssertEqual(nav.section, .home)
            let second = try capture(store, directory, "second")
            XCTAssertEqual(store.offeredCapture?.id, second.id)
            XCTAssertEqual(nav.intentVisualContext?.map(\.id), [first.id])
            nav.select(.work)
            nav.select(.home)
            XCTAssertEqual(nav.intentDraft, "原因と対処方法を教えて")
            XCTAssertEqual(store.attachCount, 0, "Opening the question must not submit an image")
            XCTAssertTrue(HandoverCache.entries(in: VisualContextStore.handoverDirectory).isEmpty)
            nav.removeIntentScreenshot()
            XCTAssertEqual(nav.intentVisualContext, [], "Removing must disable implicit reattachment")
            XCTAssertEqual(nav.intentDraft, "原因と対処方法を教えて")
            nav.finishIntentSubmission()
            XCTAssertNil(nav.intentVisualContext)
            XCTAssertTrue(nav.intentDraft.isEmpty)
        }
    }

    func testNewConversationPreservesOnlySubmittedImageAndItsFile() throws {
        try withStore { store, directory in
            store.bind(conversationID: "previous")
            let unrelated = try capture(store, directory, "unrelated", kind: .clipboardImage)
            let selected = try capture(store, directory, "selected", kind: .clipboardImage)
            let result = store.attach([selected])
            XCTAssertEqual(result.map(\.id), [selected.id.uuidString.lowercased()])
            let handover = store.handoverURL(selected.id)
            let original = try Data(contentsOf: selected.imageURL)
            store.bind(conversationID: "question", preserving: [selected.id])
            XCTAssertEqual(try Data(contentsOf: handover), original)
            XCTAssertTrue(FileManager.default.fileExists(atPath: selected.imageURL.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: unrelated.imageURL.path))
            XCTAssertEqual(store.recent.map(\.id), [selected.id])
            XCTAssertEqual(store.recent.first?.conversationID, "question")
            store.closeConversation("question")
            XCTAssertFalse(FileManager.default.fileExists(atPath: handover.path))
        }
    }

    func testDismissDoesNotRevealAnOlderOfferOrDeleteUserScreenshot() throws {
        try withStore { store, directory in
            _ = try capture(store, directory, "older")
            let current = try capture(store, directory, "current")
            store.remove(current.id)
            XCTAssertNil(store.justCaptured)
            XCTAssertNil(store.offeredCapture)
            XCTAssertTrue(FileManager.default.fileExists(atPath: current.imageURL.path))
            XCTAssertEqual(store.recent.count, 1)
        }
    }

    func testMissingOrExpiredSelectedImageStopsBeforeAnyRequestIsAccepted() throws {
        try withStore { store, directory in
            let selected = try capture(store, directory, "missing")
            try FileManager.default.removeItem(at: selected.imageURL)
            let voice = VoiceHUDState()
            voice.configureBackend(base: "http://127.0.0.1:1", token: "test-unused")
            XCTAssertFalse(voice.ask("原因を教えて", newConversation: true, visualContext: [selected]))
            XCTAssertNil(voice.latestRequestID)
            XCTAssertFalse(voice.requestInFlight)
            XCTAssertTrue(voice.answer.contains("画像を読み込めません"))
            XCTAssertEqual(store.attachCount, 0)
            let expired = try capture(store, directory, "expired")
            store.purgeExpired(now: Date().addingTimeInterval(VisualContextStore.ttl + 1))
            XCTAssertFalse(voice.ask("説明して", visualContext: [expired]))
            XCTAssertNil(voice.latestRequestID)
        }
    }

    func testCaptureReplacesOpenQuickActionsWithExplanationOffer() throws {
        try withStore { store, directory in
            for (index, mode) in [DockPresentation.quickActions, .idle, .appContext(.none)].enumerated() {
                VoiceHUDState.shared.mode = mode
                let shot = try capture(store, directory, "passive-capture-\(index)")
                XCTAssertEqual(VoiceHUDState.shared.mode, .idle)
                XCTAssertEqual(store.offeredCapture?.id, shot.id)
                XCTAssertEqual(VoiceHUDState.shared.mode.size(), CGSize(width: Metrics.dockContextWidth, height: Metrics.dockContextHeight))
            }
            XCTAssertEqual(store.attachCount, 0, "Capturing must not invoke a model")
        }
    }

    func testCapturePreservesActiveDockControlsAndKeepsImageAvailable() throws {
        try withStore { store, directory in
            let protected: [DockPresentation] = [
                .listening(partial: "書きかけの質問"), .thinking, .agent,
                .meeting(expanded: .notes), .enteringRecording, .contextDetail, .appContextExpanded(.none),
                .confirmation(ActionConfirmation(title: "メールを送信", details: [], risk: .r2, confirmLabel: "送信する")),
                .result(AgentResult(title: "作業結果", actions: [.copy]))
            ]
            for (index, mode) in protected.enumerated() {
                // 仕事の面と確認は頼むものではなく、仕事・確認の状態から出る（One Continuous Surface）。
                let genie = GenieStateStore.shared
                genie.reset()
                switch mode {
                case .agent:
                    genie.apply(genie.event(UUID(), .started(title: "作業", step: "作業中")))
                case .confirmation(let c):
                    genie.requireConfirmation(c)
                default:
                    VoiceHUDState.shared.mode = mode
                }
                let shot = try capture(store, directory, "protected-\(index)")
                XCTAssertEqual(VoiceHUDState.shared.mode, mode)
                XCTAssertEqual(store.offeredCapture?.id, shot.id)
            }
            XCTAssertEqual(store.attachCount, 0)
        }
    }

    private func withStore(_ body: (VisualContextStore, URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let previousMode = VoiceHUDState.shared.mode
        let previousHeadless = WindowCoordinator.headless
        let previousDirectory = VisualContextStore.handoverDirectoryOverride
        let previousDisclosure = VisualContextStore.disclosedOverride
        WindowCoordinator.headless = true
        VisualContextStore.handoverDirectoryOverride = directory.appendingPathComponent("handover")
        VisualContextStore.disclosedOverride = false
        let store = VisualContextStore.shared
        store.reset()
        defer {
            store.reset()
            VoiceHUDState.shared.mode = previousMode
            WindowCoordinator.headless = previousHeadless
            VisualContextStore.handoverDirectoryOverride = previousDirectory
            VisualContextStore.disclosedOverride = previousDisclosure
            try? FileManager.default.removeItem(at: directory)
        }
        try body(store, directory)
    }

    private func capture(_ store: VisualContextStore, _ directory: URL, _ name: String,
                         kind: VisualKind = .screenshot) throws -> VisualContextArtifact {
        let image = NSImage(size: NSSize(width: 160, height: 100))
        image.lockFocus(); NSColor.systemBlue.setFill(); NSRect(x: 0, y: 0, width: 160, height: 100).fill(); image.unlockFocus()
        let rep = try XCTUnwrap(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        let path = directory.appendingPathComponent(name + ".png")
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: path)
        return try XCTUnwrap(store.ingest(url: path, kind: kind, confidence: 1,
            pixelSize: CGSize(width: 160, height: 100), capturedAt: Date(), app: "Test", window: nil))
    }
}
