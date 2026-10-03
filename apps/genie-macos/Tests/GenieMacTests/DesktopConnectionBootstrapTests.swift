import XCTest
import Darwin
@testable import GenieMac

final class DesktopConnectionBootstrapTests: XCTestCase {
    private func fixture() throws -> URL {
        let state = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("genie-desktop-choice-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: state.appendingPathComponent("app"), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: state.path)
        addTeardownBlock { try? FileManager.default.removeItem(at: state) }
        return state
    }
    private func object(_ state: URL) -> [String: Any] {
        ["version": 1, "gatewayURL": "http://127.0.0.1:43123", "workspace": state.appendingPathComponent("app").path,
         "desktopIdentity": "11111111-2222-4333-8444-555555555555",
         "model": ["provider": "codex", "name": "gpt-6-sol"],
         "externalAuthorization": ["provider": "codex", "model": "gpt-6-sol"]]
    }
    private func write(_ object: [String: Any], to state: URL) throws {
        let file = state.appendingPathComponent(DesktopConnectionBootstrap.fileName)
        try JSONSerialization.data(withJSONObject: object).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    private func select(_ state: URL) -> DesktopConnectionBootstrap.Selection {
        DesktopConnectionBootstrap.select(state: state, environment: [:], arguments: ["Genie"])
    }

    func testAbsentAndExplicitEnvironmentsDoNotReadSavedChoice() throws {
        let state = try fixture()
        XCTAssertEqual(select(state), .absent)
        try Data("invalid".utf8).write(to: state.appendingPathComponent(DesktopConnectionBootstrap.fileName))
        for args in [["Genie", "--selftest", "facts"], ["Genie", "--native-messaging"]] {
            XCTAssertEqual(DesktopConnectionBootstrap.select(state: state, environment: [:], arguments: args), .ignored)
        }
        for key in ["ASTRA_DATA_ROOT", "ASTRA_GATEWAY_URL", "ASTRA_LLM_CLI", "ASTRA_CODEX_MODEL"] {
            XCTAssertEqual(DesktopConnectionBootstrap.select(state: state, environment: [key: "explicit"], arguments: ["Genie"]), .ignored)
        }
    }

    func testSavedExternalChoiceReachesActualProcessEnvironmentWithoutCredentials() throws {
        let state = try fixture(); try write(object(state), to: state)
        guard case .configured(let values) = select(state) else { return XCTFail("valid selected choice") }
        XCTAssertEqual(values["ASTRA_CODEX_MODEL"], "gpt-6-sol")
        XCTAssertEqual(values["ASTRA_DATA_ROOT"], state.appendingPathComponent("app").path)
        XCTAssertEqual(values["ASTRA_DESKTOP_IDENTITY"], "11111111-2222-4333-8444-555555555555")
        XCTAssertNil(values["ASTRA_COMPUTER_VISION_EXTERNAL"]); XCTAssertNil(values["ASTRA_CODEX_PATH"])
        let old = ProcessInfo.processInfo.environment
        defer { for key in values.keys { if let value = old[key] { setenv(key, value, 1) } else { unsetenv(key) } } }
        try DesktopConnectionBootstrap.apply(values)
        for (key, value) in values {
            XCTAssertEqual(ProcessInfo.processInfo.environment[key], value)
            XCTAssertEqual(String(cString: try XCTUnwrap(getenv(key))), value, "C/Rust sees the same process environment")
        }
        XCTAssertEqual(TranslationEngine.preferred(in: ProcessInfo.processInfo.environment), .codex)
        XCTAssertEqual(VisualEgressPolicy.current, .cloudVision(provider: "OpenAI"))
        XCTAssertFalse(values["ASTRA_MODEL_DISCLOSURE"]!.contains("ready"))
    }

    func testClaudeCodeAndGeminiChoicesNeedTheirOwnAuthorizationAndNameTheirRecipient() throws {
        for (provider, model, recipient, vision) in [("claude_code", "claude-sonnet-5-5", "Anthropic", "Claude"),
                                                     ("gemini_api", "gemini-2.5-flash", "Google", "Google")] {
            let state = try fixture(); var value = object(state)
            value["model"] = ["provider": provider, "name": model]
            value["externalAuthorization"] = ["provider": provider, "model": model]
            try write(value, to: state)
            guard case .configured(let values) = select(state) else { return XCTFail("valid \(provider) choice") }
            XCTAssertEqual(values["ASTRA_LLM_CLI"], provider)
            XCTAssertEqual(values["ASTRA_LOCAL_VISION"], "0")
            XCTAssertNil(values["ASTRA_CODEX_MODEL"]); XCTAssertNil(values["ASTRA_LOCAL_LLM_URL"])
            XCTAssertTrue(values["ASTRA_MODEL_DISCLOSURE"]!.contains("\(recipient) の \(model)"))
            XCTAssertTrue(Set(values.keys).isSubset(of: DesktopConnectionBootstrap.allowedKeys))
            XCTAssertEqual(VisualEgressPolicy.configured(environment: values), .cloudVision(provider: vision))
            // 別の提供元・別のモデルへの許可、許可なしでは通さない。
            let invalid: [Any] = [NSNull(), ["provider": "codex", "model": model], ["provider": provider, "model": "different"]]
            for authorization in invalid {
                value["externalAuthorization"] = authorization
                try write(value, to: state); XCTAssertEqual(select(state), .invalid)
            }
        }
    }

    func testSavedLocalChoiceRemainsLocalAndInvalidExternalScopesFailClosed() throws {
        let state = try fixture(); var local = object(state)
        local["model"] = ["provider": "local", "name": "qwen3.5:9b", "url": "http://127.0.0.1:11434/v1"]
        local["externalAuthorization"] = NSNull(); try write(local, to: state)
        guard case .configured(let values) = select(state) else { return XCTFail("explicit local choice") }
        XCTAssertEqual(values["ASTRA_LLM_CLI"], "local"); XCTAssertNil(values["ASTRA_CODEX_MODEL"])
        let invalidAuthorizations: [Any] = [NSNull(), ["provider": "codex", "model": "different"], ["provider": "other", "model": "gpt-6-sol"]]
        for authorization in invalidAuthorizations {
            var value = object(state); value["externalAuthorization"] = authorization
            try write(value, to: state); XCTAssertEqual(select(state), .invalid)
        }
        local["model"] = ["provider": "local", "name": "remote:cloud", "url": "http://127.0.0.1:11434/v1"]
        try write(local, to: state); XCTAssertEqual(select(state), .invalid)
    }

    func testUnknownKeysURLsTypesAndWrongWorkspaceAreRejected() throws {
        let state = try fixture()
        let invalidFields: [(String, Any)] = [("privateKey", "not allowed"), ("version", true), ("gatewayURL", "https://example.com"),
            ("gatewayURL", "http://127.0.0.1:80"), ("workspace", "/different/workspace"), ("desktopIdentity", "not-a-uuid")]
        for (key, value) in invalidFields {
            var item = object(state); item[key] = value; try write(item, to: state)
            XCTAssertEqual(select(state), .invalid, key)
        }
        var item = object(state); item["model"] = ["provider": "codex", "name": "gpt-6-sol", "arguments": "untrusted"]
        try write(item, to: state); XCTAssertEqual(select(state), .invalid)
        XCTAssertThrowsError(try DesktopConnectionBootstrap.apply(["PATH": "/untrusted"]))
    }

    func testMalformedOversizedTrailingAndDuplicateJSONAreNotAbsent() throws {
        let state = try fixture(), file = state.appendingPathComponent(DesktopConnectionBootstrap.fileName)
        let valid = String(decoding: try JSONSerialization.data(withJSONObject: object(state)), as: UTF8.self)
        let duplicate = "{\"version\":1," + valid.dropFirst()
        for value in ["{}", "{\"version\":1,\"selectionPending\":true}", valid + "false", duplicate, String(repeating: " ", count: 16_385), "{broken"] {
            try Data(value.utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            XCTAssertEqual(select(state), .invalid)
        }
    }

    func testUnsafeModesAndSymlinksAreNotAbsent() throws {
        let state = try fixture(), file = state.appendingPathComponent(DesktopConnectionBootstrap.fileName)
        try write(object(state), to: state)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        XCTAssertEqual(select(state), .invalid)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: state.path)
        XCTAssertEqual(select(state), .invalid)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: state.path)
        let other = state.appendingPathComponent("other.json"); try FileManager.default.moveItem(at: file, to: other)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: other)
        XCTAssertEqual(select(state), .invalid)
        try FileManager.default.removeItem(at: file); try FileManager.default.moveItem(at: other, to: file)
        let app = state.appendingPathComponent("app"); try FileManager.default.removeItem(at: app)
        try FileManager.default.createSymbolicLink(at: app, withDestinationURL: state)
        XCTAssertEqual(select(state), .invalid)
    }

    func testInvalidConfigurationStopsTranslationBeforeAnyRunnerOrHTTPWork() async throws {
        let old = ProcessInfo.processInfo.environment["ASTRA_RUNTIME_CONFIGURATION_ERROR"]
        setenv("ASTRA_RUNTIME_CONFIGURATION_ERROR", "1", 1)
        defer { if let old { setenv("ASTRA_RUNTIME_CONFIGURATION_ERROR", old, 1) } else { unsetenv("ASTRA_RUNTIME_CONFIGURATION_ERROR") } }
        let client = MeetingTranslationClient(configuration: { _ in XCTFail("invalid descriptor must not select local/API"); throw DesktopConnectionBootstrap.Invalid.configuration })
        do { _ = try await client.translate("Synthetic text", to: .japanese, engine: .local); XCTFail("must fail") }
        catch { XCTAssertEqual((error as? TranslationFailure)?.message, DesktopConnectionBootstrap.issueMessage) }
        let codex = CodexTranslation(environment: ["ASTRA_RUNTIME_CONFIGURATION_ERROR": "1"], executable: { _ in
            XCTFail("invalid descriptor must not locate/launch a model"); throw DesktopConnectionBootstrap.Invalid.configuration
        })
        do { _ = try await codex.translate("Synthetic text", language: .japanese); XCTFail("must fail") }
        catch { XCTAssertEqual((error as? TranslationFailure)?.message, DesktopConnectionBootstrap.issueMessage) }
        XCTAssertEqual(VisualEgressPolicy.current, .unavailable)
    }
}
