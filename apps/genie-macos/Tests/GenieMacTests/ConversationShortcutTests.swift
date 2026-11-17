import Carbon.HIToolbox
import CoreGraphics
import XCTest
@testable import GenieMac

/// ⌥⇧Space（会話）と ⌥Space（録音）を取り違えない。
@MainActor
final class ConversationShortcutTests: XCTestCase {
    func testConversationKeyIsDistinctFromRecordingKey() {
        let space = Int64(kVK_Space)
        let conversation = GlobalShortcut.conversationCombo
        XCTAssertTrue(GlobalShortcut.matches(combo: conversation, keyCode: space, flags: [.maskAlternate, .maskShift]))
        XCTAssertFalse(GlobalShortcut.matches(combo: conversation, keyCode: space, flags: [.maskAlternate]))
        XCTAssertFalse(GlobalShortcut.matches(combo: GlobalShortcut.Combo(), keyCode: space, flags: [.maskAlternate, .maskShift]))
        XCTAssertTrue(GlobalShortcut.matches(combo: GlobalShortcut.Combo(), keyCode: space, flags: [.maskAlternate]))
        XCTAssertEqual(GlobalShortcut.label(conversation), "⌥⇧Space")
    }
}
