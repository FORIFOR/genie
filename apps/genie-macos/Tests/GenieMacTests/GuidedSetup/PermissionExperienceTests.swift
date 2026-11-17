import AppKit
import XCTest
@testable import GenieMac

@MainActor
final class PermissionExperienceTests: XCTestCase {
    func testExplanationHasNoOSRequestsAndLaterDoesNothing() {
        for permission in GuidePermission.capabilityOrder {
            let h = Harness(states: [:])
            var continued = 0
            h.coordinator.explain(permission) { continued += 1 }
            XCTAssertEqual(h.coordinator.state, .intro(for: permission))
            XCTAssertEqual(h.permissions.prompts, 0)
            XCTAssertEqual(h.permissions.screenRequests, 0)
            XCTAssertTrue(h.permissions.opened.isEmpty)
            XCTAssertFalse(h.coordinator.hasLiveWatchers)
            XCTAssertNil(h.overlay.applicationToAdd)
            XCTAssertEqual(h.overlay.avatarAction, permission.enableTitle)
            XCTAssertTrue(h.overlay.explanationLabel?.contains(permission.systemPermissionName) == true)
            h.overlay.secondaryAction?.run()
            XCTAssertEqual(continued, 0)
            XCTAssertEqual(h.coordinator.state, .idle)
            XCTAssertEqual(h.overlay.visiblePanelCount, 0)
        }
    }

    func testEnableOnlyRequestsSelectedPermissionAndTryContinuesOnce() {
        let h = Harness(states: [:])
        var continued = 0
        h.coordinator.explain(.screenCapture) { continued += 1 }
        let enable = h.overlay.avatarRun
        enable?(); enable?()
        XCTAssertEqual(h.permissions.screenRequests, 1)
        XCTAssertEqual(h.permissions.prompts, 0)
        XCTAssertEqual(h.permissions.opened, [.screenCapture])
        h.permissions.states[.screenCapture] = .granted
        h.coordinator.recheckPermissions()
        h.coordinator.recheckPermissions()
        XCTAssertEqual(h.coordinator.state, .ready(.screenCapture))
        XCTAssertFalse(h.coordinator.hasLiveWatchers)
        XCTAssertNil(h.overlay.applicationToAdd)
        XCTAssertEqual(continued, 0, "grant alone must not capture or execute anything")
        let tryIt = h.overlay.avatarRun
        tryIt?(); tryIt?()
        XCTAssertEqual(continued, 1)
        XCTAssertEqual(h.coordinator.state, .idle)
    }

    func testRevokedGrantNeverRunsContinuation() {
        let h = Harness(states: [.accessibility: .granted])
        var continued = 0
        h.coordinator.explain(.accessibility) { continued += 1 }
        XCTAssertEqual(h.coordinator.state, .ready(.accessibility))
        h.permissions.states[.accessibility] = .denied
        h.overlay.avatarRun?()
        XCTAssertEqual(continued, 0)
        XCTAssertEqual(h.coordinator.state, .accessibilityIntro)
        XCTAssertEqual(h.permissions.prompts, 0)
        h.coordinator.stop()
    }

    func testCancelRestoresOnlySuspendedWindowsAndDiscardsContinuation() {
        let h = Harness(states: [:])
        var suspended = 0, restored = 0, continued = 0
        var deps = PermissionGuideCoordinator.Dependencies(
            permissions: h.permissions, tree: h.tree, makeObserver: { h.observer }, overlay: h.overlay,
            openSettings: { h.permissions.opened.append($0) }, settingsPID: { 4242 })
        deps.fallbackInterval = 0
        deps.suspendWindows = { suspended += 1; return { restored += 1 } }
        let guide = PermissionGuideCoordinator(dependencies: deps)
        guide.explain(.accessibility) { continued += 1 }
        XCTAssertEqual(suspended, 0)
        h.overlay.avatarRun?()
        XCTAssertEqual(suspended, 1)
        h.overlay.onClose?()
        guide.stop()
        XCTAssertEqual(restored, 1)
        h.permissions.states[.accessibility] = .granted
        guide.recheckPermissions()
        XCTAssertEqual(continued, 0)
        XCTAssertFalse(guide.hasLiveWatchers)
    }

    func testPendingMicrophoneReplyCannotCompleteNewExperience() {
        final class PendingMic: PermissionProviding {
            var reply: ((Bool) -> Void)?
            var states: [GuidePermission: Permissions.State] = [:]
            func state(of p: GuidePermission) -> Permissions.State { states[p] ?? .notDetermined }
            func promptAccessibility() -> Bool { false }
            func requestScreenCapture() -> Bool { false }
            func requestMicrophone(_ done: @escaping (Bool) -> Void) { reply = done }
            func openSettings(for p: GuidePermission) {}
        }
        let h = Harness(states: [:]), permissions = PendingMic()
        var deps = PermissionGuideCoordinator.Dependencies(
            permissions: permissions, tree: h.tree, makeObserver: { h.observer }, overlay: h.overlay,
            openSettings: { _ in }, settingsPID: { nil })
        deps.fallbackInterval = 0
        let guide = PermissionGuideCoordinator(dependencies: deps)
        guide.explain(.microphone) {}
        h.overlay.avatarRun?()
        let oldReply = permissions.reply
        guide.explain(.microphone) {}
        oldReply?(true)
        XCTAssertEqual(guide.state, .microphoneIntro)
        XCTAssertEqual(h.overlay.avatarAction, GuidePermission.microphone.enableTitle)
        guide.stop()
    }

    func testVoiceDoesNotEnterListeningBeforeMicrophonePermission() {
        let previous = Permissions.simulatedMicrophone
        defer { Permissions.simulatedMicrophone = previous; PermissionGuideCoordinator.shared.stop() }
        Permissions.simulatedMicrophone = .denied
        let voice = VoiceHUDState.shared
        let mode = voice.mode
        voice.beginDictation()
        XCTAssertEqual(voice.mode, mode)
        XCTAssertEqual(PermissionGuideCoordinator.shared.state, .microphoneIntro)
        PermissionGuideCoordinator.shared.stop()
        voice.beginConversation()
        XCTAssertFalse(voice.conversation.isActive, "許可が無いのに会話を始めた")
        XCTAssertEqual(voice.mode, mode)
        XCTAssertEqual(PermissionGuideCoordinator.shared.state, .microphoneIntro)
    }

    func testPracticeTargetRejectsApplicationAndOtherProcess() {
        XCTAssertFalse(PermissionPractice.isPracticeTarget(AXUIElementCreateApplication(getpid())))
        XCTAssertFalse(PermissionPractice.isPracticeTarget(AXUIElementCreateApplication(1)))
    }

    func testRecordingPurposeSurvivesRevocationAndCancelRemainsAvailable() {
        let h = Harness(states: [.microphone: .granted])
        var started = 0, cancelled = 0
        h.coordinator.explain(.microphone, purpose: .recording, onCancel: { cancelled += 1 }) { started += 1 }
        XCTAssertEqual(h.overlay.avatarAction, "録音を開始")
        h.permissions.states[.microphone] = .notDetermined
        h.overlay.avatarRun?()
        XCTAssertEqual(started, 0)
        XCTAssertEqual(cancelled, 0, "rechecking does not cancel the original intent")
        XCTAssertEqual(h.overlay.avatarMessage, PermissionGuidePurpose.recording.explanation)
        h.overlay.secondaryAction?.run()
        XCTAssertEqual(cancelled, 1)
        XCTAssertEqual(started, 0)
    }
}
