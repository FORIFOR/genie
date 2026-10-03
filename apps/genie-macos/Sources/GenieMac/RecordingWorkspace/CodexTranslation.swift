import Foundation
import Darwin

/// Uses Codex's own login. Genie never opens, copies, or exports its credentials.
final class CodexTranslation: @unchecked Sendable {
    struct Invocation: Sendable {
        let executable: URL
        let arguments: [String]
        let directory: URL
        let environment: [String: String]
        let input: Data
        let timeout: TimeInterval
        let outputLimit: Int
    }
    struct Output: Sendable {
        let status: Int32
        let stdout: Data
        let stderr: Data
    }
    typealias Runner = @Sendable (Invocation) async throws -> Output
    private let environment: [String: String]
    private let runner: Runner
    private let executable: ([String: String]) throws -> URL
    private static let serial = TranslationPermit()

    init(environment: [String: String] = ProcessInfo.processInfo.environment,
         executable: @escaping ([String: String]) throws -> URL = CodexTranslation.findExecutable,
         runner: @escaping Runner = CodexTranslationProcess.run) {
        self.environment = environment; self.executable = executable; self.runner = runner
    }

    static func model(in environment: [String: String]) -> String {
        let value = environment["ASTRA_CODEX_MODEL"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value! : "gpt-6-sol"
    }
    var model: String { Self.model(in: environment) }

    /// Normal application exit waits for its owned CLI and temporary context to disappear.
    static func shutdown() async {
        await serial.beginShutdown()
        CodexTranslationProcess.cancelAll()
        await serial.waitUntilIdle()
    }

    func translate(_ text: String, language: TranslationLanguage) async throws -> String {
        guard environment["ASTRA_RUNTIME_CONFIGURATION_ERROR"] != "1" else { throw TranslationFailure(message: DesktopConnectionBootstrap.issueMessage) }
        return try await Self.serial.withPermit {
            try Task.checkCancellation()
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("genie-translation-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: directory) }
            var arguments = ["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only",
                             "--skip-git-repo-check", "-C", directory.path, "--json", "-c", "approval_policy=\"never\""]
            // Keep aligned with workers/agent-host/src/codex.ts. Transcript instructions are data.
            for feature in ["shell_tool", "apps", "plugins", "multi_agent", "computer_use", "browser_use",
                            "browser_use_external", "in_app_browser", "image_generation", "view_image", "goals"] {
                arguments += ["-c", "features.\(feature)=false"]
            }
            arguments += ["-c", "web_search=\"disabled\"", "--model", self.model, "-"]
            let quoted = String(data: try JSONEncoder().encode(text), encoding: .utf8)!
            let input = MeetingTranslationClient.instructions(language) + "\nQuoted transcript:\n" + quoted
            let timeout = self.environment["ASTRA_CODEX_TIMEOUT_MS"].flatMap(Double.init).map { $0 / 1000 } ?? 120
            guard timeout.isFinite, (1...600).contains(timeout) else {
                throw TranslationFailure(message: "Codex の待ち時間設定を確認してください。")
            }
            // Pass directory/config locations, never API keys or an app session token.
            let allowed = Set(["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "CODEX_HOME"])
            let invocation = Invocation(executable: try self.executable(self.environment), arguments: arguments,
                                        directory: directory, environment: self.environment.filter { allowed.contains($0.key) },
                                        input: Data(input.utf8), timeout: timeout, outputLimit: 32 * 1024 * 1024)
            let output = try await self.runner(invocation)
            try Task.checkCancellation()
            guard output.stdout.count <= invocation.outputLimit,
                  output.stderr.count <= invocation.outputLimit - output.stdout.count else {
                throw TranslationFailure(message: "Codex の応答が上限を超えたため、翻訳を停止しました。")
            }
            guard output.status == 0 else {
                // Diagnose locally but never show raw CLI output (it may contain transcript data).
                let diagnostic = String(decoding: output.stderr + output.stdout, as: UTF8.self).lowercased()
                let message = diagnostic.contains("429") || diagnostic.contains("limit")
                    ? "Codex の利用上限に達しました。時間をおいて再試行してください。"
                    : diagnostic.contains("login") || diagnostic.contains("auth") || diagnostic.contains("401")
                        ? "Codex にサインインしてから翻訳を再試行してください。"
                        : "Codex が翻訳を完了できませんでした。接続を確認して再試行してください。"
                throw TranslationFailure(message: message)
            }
            return try Self.decode(output.stdout)
        }
    }

    static func findExecutable(_ environment: [String: String]) throws -> URL {
        let configured = environment["ASTRA_CODEX_PATH"]
        let command = configured ?? "codex"
        let paths: [String]
        if command.hasPrefix("/") { paths = [command] }
        else if command.contains("/") { paths = [] }
        else {
            let search = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
                + ["/opt/homebrew/bin", "/usr/local/bin", "/Applications/Codex.app/Contents/Resources",
                   "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS"]
            paths = search.filter { $0.hasPrefix("/") }.map { URL(fileURLWithPath: $0).appendingPathComponent(command).path }
        }
        guard let path = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw TranslationFailure(message: "この端末に Codex が見つかりません。Codex を設定して再試行してください。")
        }
        return URL(fileURLWithPath: path)
    }

    static func decode(_ data: Data) throws -> String {
        var answer: String?, complete = false
        for line in data.split(separator: 10) where !line.isEmpty {
            guard let event = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  let type = event["type"] as? String else { throw unreadable() }
            if type == "turn.failed" || type == "error" { throw unreadable() }
            if type == "turn.completed" { complete = true }
            if type == "item.completed", let item = event["item"] as? [String: Any] {
                guard let kind = item["type"] as? String,
                      ["agent_message", "reasoning"].contains(kind) else { throw unreadable() }
                if kind == "agent_message" { answer = item["text"] as? String }
            }
        }
        guard complete, var body = answer?.trimmingCharacters(in: .whitespacesAndNewlines) else { throw unreadable() }
        if body.hasPrefix("```json\n"), body.hasSuffix("```") { body = String(body.dropFirst(8).dropLast(3)) }
        else if body.hasPrefix("```\n"), body.hasSuffix("```") { body = String(body.dropFirst(4).dropLast(3)) }
        guard let payload = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
              Set(payload.keys) == ["translation"], let text = payload["translation"] as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw unreadable() }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func unreadable() -> TranslationFailure {
        TranslationFailure(message: "Codex から完全な訳文を取得できませんでした。再試行してください。")
    }
}

/// One Codex translation process across all client instances. Cancelled queued work never starts.
private actor TranslationPermit {
    private var busy = false
    private var closing = false
    private var waiting: [(UUID, CheckedContinuation<Void, Error>)] = []
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    func withPermit<T>(_ body: () async throws -> T) async throws -> T {
        let id = UUID()
        try Task.checkCancellation()
        guard !closing else { throw CancellationError() }
        if busy {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { waiting.append((id, $0)) }
            } onCancel: { Task { await self.cancel(id) } }
        } else { busy = true }
        defer { release() }
        try Task.checkCancellation()
        return try await body()
    }
    private func cancel(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.0 == id }) else { return }
        waiting.remove(at: index).1.resume(throwing: CancellationError())
    }
    private func release() {
        if waiting.isEmpty {
            busy = false
            let completed = idleWaiters; idleWaiters = []
            for waiter in completed { waiter.resume() }
        }
        else { waiting.removeFirst().1.resume() }
    }
    func beginShutdown() {
        closing = true
        let queued = waiting; waiting = []
        for (_, waiter) in queued { waiter.resume(throwing: CancellationError()) }
    }
    func waitUntilIdle() async {
        guard busy else { return }
        await withCheckedContinuation { idleWaiters.append($0) }
    }
}

/// Bounded nonblocking pipes avoid both stdout deadlocks and unbounded buffering.
/// Cancellation is checked off the main thread; only this operation's child is terminated.
final class CodexTranslationProcess: @unchecked Sendable {
    private static let registryLock = NSLock()
    private static var operations: [UUID: CodexTranslationProcess] = [:]
    private static var closing = false
    private let lock = NSLock()
    private var cancelled = false
    private func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    private static func register(_ operation: CodexTranslationProcess, id: UUID) throws {
        registryLock.lock(); defer { registryLock.unlock() }
        guard !closing else { throw CancellationError() }
        operations[id] = operation
    }
    private static func unregister(_ id: UUID) {
        registryLock.lock(); defer { registryLock.unlock() }
        operations[id] = nil
    }
    static func cancelAll() {
        registryLock.lock()
        closing = true
        let active = Array(operations.values)
        registryLock.unlock()
        for operation in active { operation.cancel() }
    }

    static func run(_ invocation: CodexTranslation.Invocation) async throws -> CodexTranslation.Output {
        let operation = CodexTranslationProcess()
        let id = UUID()
        try register(operation, id: id)
        defer { unregister(id) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .utility).async {
                    do { continuation.resume(returning: try operation.runBlocking(invocation)) }
                    catch { continuation.resume(throwing: error) }
                }
            }
        } onCancel: { operation.cancel() }
    }

    private func runBlocking(_ invocation: CodexTranslation.Invocation) throws -> CodexTranslation.Output {
        if isCancelled { throw CancellationError() }
        let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
        process.executableURL = invocation.executable; process.arguments = invocation.arguments
        process.currentDirectoryURL = invocation.directory; process.environment = invocation.environment
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        let handles = [input.fileHandleForWriting, output.fileHandleForReading, errors.fileHandleForReading]
        defer {
            for handle in handles { try? handle.close() }
            try? input.fileHandleForReading.close(); try? output.fileHandleForWriting.close(); try? errors.fileHandleForWriting.close()
        }
        for handle in handles {
            let fd = handle.fileDescriptor
            guard fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) != -1 else {
                throw TranslationFailure(message: "Codex の入出力を準備できませんでした。")
            }
        }
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else {
            throw TranslationFailure(message: "Codex の入出力を準備できませんでした。")
        }
        do { try process.run() }
        catch { throw TranslationFailure(message: "Codex を起動できませんでした。設定を確認してください。") }
        try? input.fileHandleForReading.close(); try? output.fileHandleForWriting.close(); try? errors.fileHandleForWriting.close()
        let began = ProcessInfo.processInfo.systemUptime
        var stoppedAt: TimeInterval?, failure: Error?, sent = 0, inputClosed = false
        var stdout = Data(), stderr = Data(), collected = 0
        var buffer = [UInt8](repeating: 0, count: 8192)
        func collect(_ handle: FileHandle, into data: inout Data) {
            while true {
                let count = Darwin.read(handle.fileDescriptor, &buffer, buffer.count)
                if count <= 0 { return }
                if collected + count > invocation.outputLimit {
                    failure = TranslationFailure(message: "Codex の応答が上限を超えたため、翻訳を停止しました。")
                    return
                }
                collected += count
                data.append(buffer, count: count)
            }
        }
        while true {
            collect(output.fileHandleForReading, into: &stdout)
            collect(errors.fileHandleForReading, into: &stderr)
            let now = ProcessInfo.processInfo.systemUptime
            if isCancelled { failure = CancellationError() }
            if failure == nil && now - began >= invocation.timeout {
                failure = TranslationFailure(message: "Codex の翻訳が時間内に終わりませんでした。自動では再送しません。")
            }
            if failure != nil, process.isRunning {
                if stoppedAt == nil { stoppedAt = now; process.terminate() }
                else if now - stoppedAt! >= 2 { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
            }
            if !process.isRunning { break }
            if failure == nil && !inputClosed {
                let count = invocation.input.withUnsafeBytes { bytes in
                    Darwin.write(input.fileHandleForWriting.fileDescriptor, bytes.baseAddress!.advanced(by: sent), bytes.count - sent)
                }
                if count > 0 { sent += count }
                else if count < 0 && errno != EAGAIN && errno != EINTR {
                    failure = TranslationFailure(message: "Codex に翻訳を渡せませんでした。")
                }
                if sent == invocation.input.count { try? input.fileHandleForWriting.close(); inputClosed = true }
            }
            Thread.sleep(forTimeInterval: 0.01)
        }
        process.waitUntilExit()
        collect(output.fileHandleForReading, into: &stdout)
        collect(errors.fileHandleForReading, into: &stderr)
        if let failure { throw failure }
        return .init(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}
