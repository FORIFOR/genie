import XCTest
import GenieCore
@testable import GenieMac

@MainActor final class TaskOutcomeTests: XCTestCase {
    func testRequestAndResultSurviveRestartAndExportWithoutModel() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        let store = LocalStore(path: path)
        var record = TaskRequestRecord(request: "動画の構成を3案\n予算は0円", base: "http://localhost:3000")
        record.conversationID = "conversation"; record.backendTaskID = "existing-job"
        record.phase = .complete; record.result = "## 案1\n撮影した素材から組み立てる。\n日本語・引用\"と\u{1}制御文字"
        let task = AgentTask(requestRecord: record, id: UUID(), title: "動画の構成を3案", status: .success, steps: [], startedAt: Date(), context: ContextBundle())
        XCTAssertTrue(store.save(task)); store.close()
        XCTAssertTrue(store.open(path))
        let restored = try XCTUnwrap(store.loadTasks().first)
        XCTAssertEqual(restored.requestRecord, record)
        XCTAssertTrue(restored.document.contains(record.result))
        XCTAssertTrue(restored.document.contains(record.request))
        XCTAssertTrue(TaskHistoryFilter.finished.includes(restored, query: "予算は0円"))
        XCTAssertTrue(TaskHistoryFilter.finished.includes(restored, query: "撮影した素材"))
        XCTAssertFalse(record.canRefresh)
        store.close()
    }

    func testLegacyDatabaseMigratesWithoutRemovingHistory() throws {
        let store = LocalStore(path: ":memory:")
        defer { store.close() }
        XCTAssertTrue(store.exec("DROP TABLE task_requests"))
        XCTAssertTrue(store.exec("INSERT INTO tasks VALUES ('\(UUID())','以前の仕事','success',1,'read\u{1}資料を読む\u{1}success')"))
        XCTAssertTrue(store.migrate())
        let old = try XCTUnwrap(store.loadTasks().first)
        XCTAssertNil(old.requestRecord)
        XCTAssertEqual(old.steps.first?.title, "資料を読む")
        XCTAssertEqual(old.document, "")
    }

    func testAtomicSaveRollsBackIfResultCannotBeSaved() {
        let store = LocalStore(path: ":memory:")
        defer { store.close() }
        XCTAssertTrue(store.exec("DROP TABLE task_requests"))
        let task = AgentTask(requestRecord: TaskRequestRecord(request: "依頼", base: "test"), id: UUID(), title: "依頼", status: .running, steps: [], startedAt: Date(), context: ContextBundle())
        XCTAssertFalse(store.save(task))
        XCTAssertTrue(store.migrate())
        XCTAssertTrue(store.loadTasks().isEmpty)
    }

    func testBackendFailureCancellationAndEmptyOutputAreNeverSuccess() {
        var reads = 0
        for status in ["FAILED", "CANCELLED", "WAITING_APPROVAL", "RUNNING"] {
            let reply = VoiceHUDState.taskReply(status: status, artifactID: "") { reads += 1; return "unexpected" }
            XCTAssertNotEqual(reply.phase, .complete)
        }
        XCTAssertEqual(reads, 0)
        XCTAssertEqual(VoiceHUDState.taskReply(status: "COMPLETED", artifactID: "") { "" }.phase, .needsInput)
        XCTAssertEqual(VoiceHUDState.taskReply(status: "COMPLETED", artifactID: "artifact") { " \n" }.phase, .needsInput)
        XCTAssertEqual(VoiceHUDState.taskReply(status: "COMPLETED", artifactID: "artifact") { "実際の成果物" }.text, "実際の成果物")
    }

    func testOnlyKnownUnfinishedJobsCanBeRefreshed() {
        var record = TaskRequestRecord(request: "依頼", base: "test")
        record.phase = .unknown
        XCTAssertFalse(record.canRefresh, "Unknown submission must never be automatically resent")
        record.backendTaskID = "existing-job"
        XCTAssertTrue(record.canRefresh)
        record.phase = .failed
        XCTAssertFalse(record.canRefresh)
        record.phase = .waiting
        XCTAssertTrue(record.canRefresh)
    }

    func testReceiptIdentitySurvivesRestartAndEnablesReadOnlyRecovery() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        let store = LocalStore(path: path)
        var record = TaskRequestRecord(request: "依頼", base: "http://127.0.0.1:3000")
        record.turnRequestID = UUID().uuidString; record.conversationID = UUID().uuidString
        record.phase = .unknown
        XCTAssertTrue(record.canRefresh)
        let task = AgentTask(requestRecord: record, id: UUID(), title: "受付照合", status: .failed, steps: [], startedAt: Date(), context: ContextBundle())
        XCTAssertTrue(store.save(task)); store.close(); XCTAssertTrue(store.open(path))
        let restored = try XCTUnwrap(store.loadTasks().first?.requestRecord)
        XCTAssertEqual(restored, record); XCTAssertTrue(restored.canRefresh)
        XCTAssertTrue(restored.backendTaskID.isEmpty)
        store.close()
    }

    func testClarificationIsNotReportedAsACompletedArtifact() throws {
        let result = try VoiceHUDState.followUp(TurnOutcome(needsClarification: true, answer: "対象を教えてください", taskId: "", notice: "", replyJson: ""), base: "unreachable", token: "unused", waitMs: 1)
        XCTAssertEqual(result.phase, .needsInput)
        XCTAssertEqual(result.text, "対象を教えてください")
    }
    func testEditedDocumentPersistsWithoutChangingOriginalOrIdentity() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite").path
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        let store = LocalStore(path: path)
        var record = TaskRequestRecord(request: TaskRequestRecord.firstExample, base: "fixture")
        record.phase = .complete; record.result = "元の生成文"; record.backendTaskID = "existing-job"
        let task = AgentTask(requestRecord: record, id: UUID(), title: "確認", status: .success, steps: [], startedAt: Date(), context: ContextBundle())
        XCTAssertNil(task.editingDocument(" \n"))
        let text = "- [ ] テスト（担当: 未定）\n日本語👩‍💻"
        let edited = try XCTUnwrap(task.editingDocument(text))
        XCTAssertTrue(store.save(edited)); store.close(); XCTAssertTrue(store.open(path))
        let restored = try XCTUnwrap(store.loadTasks().first)
        XCTAssertEqual(restored.id, task.id)
        XCTAssertEqual(restored.requestRecord?.result, "元の生成文")
        XCTAssertEqual(restored.requestRecord?.documentText, text)
        XCTAssertEqual(restored.requestRecord?.backendTaskID, "existing-job")
        XCTAssertEqual(restored.document, edited.document)
        XCTAssertTrue(TaskHistoryFilter.finished.includes(restored, query: "担当: 未定"))
        XCTAssertFalse(TaskHistoryFilter.finished.includes(restored, query: "元の生成文"))
        XCTAssertTrue(restored.summary.contains("担当: 未定"))
        XCTAssertTrue(restored.document.contains(text)); store.close()
    }

    func testOlderRecordWithoutEditsStillDecodes() throws {
        let record = TaskRequestRecord(request: "旧形式", base: "fixture")
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any])
        json.removeValue(forKey: "editedResult")
        json.removeValue(forKey: "turnRequestID")
        let decoded = try JSONDecoder().decode(TaskRequestRecord.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(decoded.editedResult)
        XCTAssertNil(decoded.turnRequestID)
        XCTAssertEqual(decoded.documentText, decoded.result)
    }

    func testFailedUpdateKeepsResultUntilLocalSaveCanRecover() throws {
        let store = LocalStore(path: ":memory:")
        defer { store.close() }
        let voice = VoiceHUDState()
        let task = AgentTask(requestRecord: TaskRequestRecord(request: "依頼", base: "fixture"), id: UUID(), title: "依頼", status: .running, steps: [], startedAt: Date(), context: ContextBundle())
        XCTAssertTrue(store.save(task))
        XCTAssertTrue(store.exec("CREATE TRIGGER reject_result BEFORE UPDATE ON tasks BEGIN SELECT RAISE(FAIL, 'disk failure'); END"))
        // LocalStore uses INSERT OR REPLACE: deny inserts as well.
        XCTAssertTrue(store.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON tasks BEGIN SELECT RAISE(FAIL, 'disk failure'); END"))
        voice.updateRequest(task.id, store: store) { $0.backendTaskID = "same-job"; $0.phase = .complete; $0.result = "失いたくない結果" }
        XCTAssertEqual(voice.unsavedRequests[task.id]?.requestRecord?.result, "失いたくない結果")
        XCTAssertNotEqual(store.loadTasks().first?.requestRecord?.phase, .complete)
        XCTAssertTrue(store.exec("DROP TRIGGER reject_result")); XCTAssertTrue(store.exec("DROP TRIGGER reject_insert"))
        voice.savePendingRequest(task.id, store: store)
        XCTAssertNil(voice.unsavedRequests[task.id])
        XCTAssertEqual(store.loadTasks().first?.requestRecord?.backendTaskID, "same-job")
        XCTAssertEqual(store.loadTasks().first?.requestRecord?.result, "失いたくない結果")
    }
}
