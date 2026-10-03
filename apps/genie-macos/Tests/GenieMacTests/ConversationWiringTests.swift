import XCTest
@testable import GenieMac

/// 段階 2〜4: VoiceHUDState が会話の「やること」を提供元へ正しく渡すか。偽の提供元で一連を通す。
@MainActor
final class ConversationWiringTests: XCTestCase {
    /// 呼ばれたことを順に記録する偽の提供元。マイク・送信・読み上げの実物は使わない。
    final class FakeProvider: ConversationProvider {
        let name = "fake"
        let capabilities = ConversationCapabilities(bargeIn: false, sendsAudioOffDevice: false,
                                                    synthesizesOffDevice: false, mayNotRespond: false)
        var log: [String] = []
        var firstFrame: (() -> Void)?
        var utterance: ((String) -> Void)?
        var reply: ((ConversationLoop.Reply) -> Void)?
        var finish: (() -> Void)?
        var inputOpens = true

        func openInput(echoCancellation: Bool, onFirstFrame: @escaping () -> Void,
                       onUtterance: @escaping (String) -> Void) -> Bool {
            log.append("open(echo:\(echoCancellation))")
            firstFrame = onFirstFrame; utterance = onUtterance
            return inputOpens
        }
        func closeInput() { log.append("close") }
        func send(_ text: String, onReply: @escaping (ConversationLoop.Reply) -> Void) { log.append("send(\(text))"); reply = onReply }
        func speak(_ text: String, onFinish: @escaping () -> Void) { log.append("speak(\(text))"); finish = onFinish }
        func stopSpeaking() { log.append("stopSpeaking") }
    }

    private var headless = false
    private let hud = VoiceHUDState.shared

    override func setUp() {
        super.setUp()
        headless = WindowCoordinator.headless
        WindowCoordinator.headless = true
        GenieStateStore.shared.reset()
        hud.endConversation(.user)
    }

    override func tearDown() {
        hud.endConversation(.user)
        GenieStateStore.shared.reset()
        WindowCoordinator.headless = headless
        super.tearDown()
    }

    func testTwoTurnsRunThroughTheProviderHalfDuplex() {
        let fake = FakeProvider()
        let t0 = Date()
        hud.startConversation(using: fake, now: t0)
        XCTAssertEqual(fake.log, ["open(echo:false)"])
        XCTAssertEqual(hud.mode, .listening(partial: ""))
        fake.firstFrame?()
        XCTAssertEqual(hud.conversation.phase, .listening)

        fake.utterance?("明日の天気は？")
        XCTAssertEqual(Array(fake.log.suffix(2)), ["close", "send(明日の天気は？)"], "送る前にマイクを閉じる")
        fake.reply?(.settled("明日は雨です。"))
        XCTAssertEqual(fake.log.last, "speak(明日は雨です。)")
        XCTAssertEqual(hud.conversation.phase, .speaking)
        fake.finish?()
        XCTAssertEqual(fake.log.last, "open(echo:false)", "読み終えてから次を聞く")

        fake.utterance?("週末は？")
        fake.reply?(.working)
        guard case .speak(let ack) = ConversationWiringTests.lastSpeak(fake.log) else { return XCTFail() }
        XCTAssertTrue(ack.contains("かしこまりました"))
    }

    func testEndingStopsSpeechAndIgnoresTheLateFinish() {
        let fake = FakeProvider()
        hud.startConversation(using: fake)
        fake.firstFrame?(); fake.utterance?("依頼"); fake.reply?(.settled("長い答え"))
        let lateFinish = fake.finish
        hud.endConversation(.user)
        XCTAssertEqual(Array(fake.log.suffix(2)), ["stopSpeaking", "close"])
        XCTAssertFalse(hud.conversation.isActive)
        let opens = fake.log.filter { $0.hasPrefix("open") }.count
        lateFinish?()
        XCTAssertEqual(fake.log.filter { $0.hasPrefix("open") }.count, opens, "終わった後の読み終えた知らせでマイクを開かない")
    }

    func testAMicrophoneThatCannotOpenEndsTheConversation() {
        let fake = FakeProvider()
        fake.inputOpens = false
        hud.startConversation(using: fake)
        XCTAssertFalse(hud.conversation.isActive, "開けないマイクで会話中を名乗らない")
    }

    func testInjectedMicFixtureSelectsPipelineWhileEnabledProviderLimitsStillFailClosed() {
        let capture = VoiceCaptureFixture()
        let previousCapture = hud.voiceCapture
        let previousMic = Permissions.simulatedMicrophone
        let previousSpeech = Permissions.simulatedSpeechRecognition
        hud.voiceCapture = capture.input
        Permissions.simulatedMicrophone = .granted
        Permissions.simulatedSpeechRecognition = .granted
        let suite = "genie.test.micrelease.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer {
            hud.endConversation(.user)
            hud.voiceCapture = previousCapture
            Permissions.simulatedMicrophone = previousMic
            Permissions.simulatedSpeechRecognition = previousSpeech
            defaults.removePersistentDomain(forName: suite)
        }

        let isolated = GeminiLiveSettings(defaults: defaults, initialHasKey: false)
        XCTAssertFalse(isolated.checkingKey, "the fixture must not schedule a Keychain presence read")
        hud.beginConversation(geminiSettings: isolated)
        XCTAssertEqual(hud.conversationProvider.name, "pipeline")
        XCTAssertEqual(capture.opens, 1)
        XCTAssertTrue(hud.conversation.isActive)
        hud.endConversation(.user)
        XCTAssertFalse(capture.listening)

        // An enabled provider with no budget must still explain the constraint;
        // dependency injection cannot turn a normal user's limit into fallback.
        let limited = GeminiLiveSettings(defaults: defaults, initialHasKey: true)
        limited.setEnabled(true)
        limited.setMonthlyMinutes(0)
        hud.beginConversation(geminiSettings: limited)
        XCTAssertEqual(capture.opens, 1, "must not open the pipeline after a paid-provider refusal")
        XCTAssertFalse(hud.conversation.isActive)
        XCTAssertFalse(hud.answer.isEmpty)
    }

    func testTheClockEndsTheConversationAfterFiveMinutes() {
        let fake = FakeProvider()
        let t0 = Date()
        hud.startConversation(using: fake, now: t0)
        hud.tickConversation(now: t0.addingTimeInterval(275))
        XCTAssertTrue(hud.conversationEnding)
        hud.tickConversation(now: t0.addingTimeInterval(300))
        XCTAssertFalse(hud.conversation.isActive)
        XCTAssertFalse(hud.conversationEnding)
        XCTAssertEqual(hud.mode, .idle, "聞いている姿を片付ける")
    }

    func testTheAnswerCardStaysWhileListeningForTheNextTurn() {
        let fake = FakeProvider()
        hud.startConversation(using: fake)
        fake.firstFrame?(); fake.utterance?("明日の天気は？")
        hud.mode = .answer("明日は雨です。")          // 答えが面に出た（ask が出す姿）
        fake.reply?(.settled("明日は雨です。"))
        fake.finish?()
        XCTAssertEqual(fake.log.last, "open(echo:false)", "読み終えたら次を聞く")
        XCTAssertEqual(hud.mode, .answer("明日は雨です。"), "カードは残す（見返せる）")
        hud.updatePartial("週末は")
        XCTAssertEqual(hud.mode, .listening(partial: "週末は"), "話し始めたら聞く面へ")
    }

    func testDictationNeverAsksGenieAndPointsToConversation() {
        let capture = VoiceCaptureFixture()
        let previousCapture = hud.voiceCapture
        let previousMic = Permissions.simulatedMicrophone
        let previousSpeech = Permissions.simulatedSpeechRecognition
        hud.voiceCapture = capture.input
        Permissions.simulatedMicrophone = .granted
        Permissions.simulatedSpeechRecognition = .granted
        defer {
            hud.cancelListening()
            hud.voiceCapture = previousCapture
            Permissions.simulatedMicrophone = previousMic
            Permissions.simulatedSpeechRecognition = previousSpeech
        }
        var inserted: [String] = []
        Dictation.dryRun = { _ in false }            // 入れる欄が無い
        defer { Dictation.dryRun = nil }
        hud.beginDictation()
        XCTAssertEqual(capture.opens, 1)
        let before = hud.latestRequestID
        _ = hud.speak("明日の天気教えて")
        XCTAssertEqual(hud.latestRequestID, before, "音声入力は Genie に送らない")
        XCTAssertEqual(hud.mode, .answer(Facts.dictationNoField))
        Dictation.dryRun = { inserted.append($0); return true }
        _ = hud.speak("議事録に追記")
        XCTAssertEqual(inserted, ["議事録に追記"])
        XCTAssertEqual(hud.mode, .idle)
    }

    func testClosingTheCardDuringAConversationKeepsTheListeningView() {
        let fake = FakeProvider()
        hud.startConversation(using: fake)
        hud.mode = .answer("明日は雨です。")
        GenieStateStore.shared.dismissResult()
        XCTAssertEqual(hud.mode, .listening(partial: ""), "会話中はカードを閉じてもマイクの姿を隠さない")
        hud.endConversation(.user)
        hud.mode = .answer("答え")
        GenieStateStore.shared.dismissResult()
        XCTAssertEqual(hud.mode, .idle, "会話でなければ従来どおり閉じる")
    }

    enum Spoken: Equatable { case speak(String), none }
    static func lastSpeak(_ log: [String]) -> Spoken {
        guard let entry = log.last(where: { $0.hasPrefix("speak(") }) else { return .none }
        return .speak(String(entry.dropFirst(6).dropLast()))
    }
}
