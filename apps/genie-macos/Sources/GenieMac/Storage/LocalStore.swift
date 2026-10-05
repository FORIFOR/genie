import Foundation
import SQLite3

/// §24 ローカル保存。SQLite 1 ファイル。
///
/// 仕様書がはっきり書いている 2 つの「保存しないもの」を、ここで**構造として**守る:
///   - Raw screenshot は原則保存しない → 画像を入れる列を作らない
///   - Meeting audio も既定では永続保存しない → 音声を入れる列を作らない
///   - Context は **metadata だけ**（§25 の source / sensitivity / 期限）。本文は入れない
///
/// 列が無ければ、後から「つい入れてしまう」ことができない。
final class LocalStore {
    static let shared = LocalStore()
    static let tasksChanged = Notification.Name("GenieLocalTasksChanged")

    private var db: OpaquePointer?
    private(set) var path: String = ""

    /// データの置き場所。既定は Application Support/Astra（改名前の保存先を維持）。
    ///
    /// `ASTRA_DATA_ROOT` で差し替えられる。**初回起動を試すため**の口
    /// —— macOS の `applicationSupportDirectory` は HOME を見ずに実ユーザーから
    /// 解決するので、HOME を変えても隔離できず、まっさらな状態を作れなかった。
    /// 利用者のデータを退避させずに「何も無いところから始める」を確かめられるようにする。
    static var dataRoot: URL {
        if let override = ProcessInfo.processInfo.environment["ASTRA_DATA_ROOT"], !override.isEmpty {
            let url = URL(fileURLWithPath: override)
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return url
        }
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Astra")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    static var defaultPath: String {
        dataRoot.appendingPathComponent("astra.sqlite").path
    }

    private init() {}

    /// テスト用に別ファイルを開けるようにしてある。
    init(path: String) { open(path) }

    @discardableResult
    func open(_ path: String = LocalStore.defaultPath) -> Bool {
        close()
        self.path = path
        guard sqlite3_open(path, &db) == SQLITE_OK else { return false }
        // 別の処理が書いている間は、すぐ断らずに少し待つ（同じ DB を開く検査や復旧の処理と重なっても、依頼を落とさない）。
        sqlite3_busy_timeout(db, 2_000)
        return migrate()
    }

    func close() {
        if db != nil { sqlite3_close(db); db = nil }
    }

    /// §24 のテーブル一式。画像・音声・本文の列は**意図的に無い**。
    static let tables = [
        "tasks", "task_requests", "conversations", "context_metadata",
        "meetings", "transcripts", "meeting_notes", "artifacts", "plugin_permissions",
    ]

    @discardableResult
    func migrate() -> Bool {
        let sql = """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
          started_at REAL NOT NULL, steps_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS task_requests (task_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, started_at REAL NOT NULL, last_turn_at REAL);
        -- 文脈は **metadata だけ**。summary/本文の列は作らない（§25）。
        CREATE TABLE IF NOT EXISTS context_metadata (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, application TEXT NOT NULL,
          sensitivity TEXT NOT NULL, captured_at REAL NOT NULL, expires_at REAL NOT NULL);
        -- 会議 1 回分＝Session。音声そのものは入れない（§24）。
        -- 「録音ファイル」ではなく「会議」を持つので、題・要約・件数が列になる。
        CREATE TABLE IF NOT EXISTS meetings (
          id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'ready',
          started_at REAL NOT NULL, ended_at REAL,
          calendar_event_id TEXT, project_id TEXT,
          visibility TEXT NOT NULL DEFAULT 'mySpace',
          participant_count INTEGER NOT NULL DEFAULT 0,
          summary TEXT, action_count INTEGER NOT NULL DEFAULT 0,
          decision_count INTEGER NOT NULL DEFAULT 0,
          source TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS transcripts (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT,
          text TEXT NOT NULL, at REAL NOT NULL);
        -- 拾ったもの（決まったこと・やること・質問・懸念・メモ）。出所（誰が・いつ）ごと残す。
        -- 止めたあとに Library から同じ発言へ戻るための正本。件数だけでは戻れない。
        CREATE TABLE IF NOT EXISTS meeting_notes (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, kind TEXT NOT NULL,
          text TEXT NOT NULL, speaker TEXT, at REAL, position INTEGER NOT NULL);
        -- 画像バイト列は入れない。参照だけ（§24 raw screenshot は保存しない）。
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY, meeting_id TEXT, kind TEXT NOT NULL,
          ref TEXT NOT NULL, created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS plugin_permissions (
          plugin TEXT NOT NULL, capability TEXT NOT NULL, granted INTEGER NOT NULL,
          decided_at REAL NOT NULL, PRIMARY KEY (plugin, capability));
        """
        guard exec(sql) else { return false }

        // **古い表に列を足す。**
        //
        // `CREATE TABLE IF NOT EXISTS` は、既に在る表には何もしない。Session を
        // 持つより前の版で作られた `meetings` は列が足りず、書き込みが黙って失敗する
        // —— 実際、実機の DB は古い列のままで 0 件だった。会議が 1 件も残らない。
        // 検査は毎回まっさらな一時 DB を使っていたので、この経路を通っていなかった。
        for (table, columns) in Self.addedColumns {
            guard tableNames().contains(table) else { continue }
            let have = Set(columnNames(table))
            for (name, decl) in columns where !have.contains(name) {
                // 既定値を持たせる。既存の行にも値が要る。
                _ = exec("ALTER TABLE \(table) ADD COLUMN \(name) \(decl);")
            }
        }
        return true
    }

    /// 後から足した列。古い DB を開いたときに継ぎ足す。
    /// **`NOT NULL` は付けない**（既存の行を埋められないため）。既定値で補う。
    private static let addedColumns: [String: [(String, String)]] = [
        "meetings": [
            ("status", "TEXT NOT NULL DEFAULT 'ready'"),
            ("calendar_event_id", "TEXT"),
            ("project_id", "TEXT"),
            ("visibility", "TEXT NOT NULL DEFAULT 'mySpace'"),
            ("participant_count", "INTEGER NOT NULL DEFAULT 0"),
            ("summary", "TEXT"),
            ("action_count", "INTEGER NOT NULL DEFAULT 0"),
            ("decision_count", "INTEGER NOT NULL DEFAULT 0"),
            ("source", "TEXT"),
            ("created_at", "REAL NOT NULL DEFAULT 0"),
            ("updated_at", "REAL NOT NULL DEFAULT 0"),
        ],
    ]

    @discardableResult
    func exec(_ sql: String) -> Bool {
        sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
    }

    /// 実際に在るテーブル名。migrate の検査に使う。
    func tableNames() -> [String] {
        var out: [String] = []
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT name FROM sqlite_master WHERE type='table'", -1, &stmt, nil) == SQLITE_OK
        else { return out }
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let c = sqlite3_column_text(stmt, 0) { out.append(String(cString: c)) }
        }
        sqlite3_finalize(stmt)
        return out
    }

    /// あるテーブルの列名。「画像や本文の列を作っていない」ことの検査に使う。
    func columnNames(_ table: String) -> [String] {
        var out: [String] = []
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(table))", -1, &stmt, nil) == SQLITE_OK else { return out }
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let c = sqlite3_column_text(stmt, 1) { out.append(String(cString: c)) }
        }
        sqlite3_finalize(stmt)
        return out
    }

    // MARK: - tasks（§23 UI を閉じても消えない）

    @discardableResult
    func save(_ task: AgentTask) -> Bool {
        // Preserve the actual step details. The legacy delimiter format silently
        // discarded failures and work results on relaunch, and broke on control characters.
        let rows = task.steps.map { ["tool": $0.tool, "title": $0.title, "state": $0.state.rawValue, "detail": $0.detail] }
        guard let data = try? JSONSerialization.data(withJSONObject: rows),
              let steps = String(data: data, encoding: .utf8) else { return false }
        guard exec("BEGIN IMMEDIATE") else { return false }
        var committed = false
        defer { if !committed { _ = exec("ROLLBACK") } }
        let sql = "INSERT OR REPLACE INTO tasks (id,title,status,started_at,steps_json) VALUES (?,?,?,?,?)"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
        bind(stmt, 1, task.id.uuidString)
        bind(stmt, 2, task.title)
        bind(stmt, 3, task.status.rawValue)
        sqlite3_bind_double(stmt, 4, task.startedAt.timeIntervalSince1970)
        bind(stmt, 5, steps)
        let saved = sqlite3_step(stmt) == SQLITE_DONE
        sqlite3_finalize(stmt)
        guard saved else { return false }
        if let record = task.requestRecord {
            guard let data = try? JSONEncoder().encode(record), let json = String(data: data, encoding: .utf8) else { return false }
            var recordStmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO task_requests (task_id,record_json) VALUES (?,?)", -1, &recordStmt, nil) == SQLITE_OK else { return false }
            bind(recordStmt, 1, task.id.uuidString); bind(recordStmt, 2, json)
            let savedRecord = sqlite3_step(recordStmt) == SQLITE_DONE
            sqlite3_finalize(recordStmt)
            guard savedRecord else { return false }
        }
        guard exec("COMMIT") else { return false }
        committed = true
        NotificationCenter.default.post(name: Self.tasksChanged, object: self)
        return true
    }

    /// 走っていた task を読み戻す（§23 Dock を開き直したら状態が戻る）。
    func loadTasks(status: AgentRunState? = nil) -> [AgentTask] {
        var sql = "SELECT t.id,t.title,t.status,t.started_at,t.steps_json,r.record_json FROM tasks t LEFT JOIN task_requests r ON r.task_id=t.id"
        if status != nil { sql += " WHERE status = ?" }
        sql += " ORDER BY started_at DESC"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        if let status { bind(stmt, 1, status.rawValue) }
        var out: [AgentTask] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let idText = sqlite3_column_text(stmt, 0).map({ String(cString: $0) }),
                  let id = UUID(uuidString: idText),
                  let title = sqlite3_column_text(stmt, 1).map({ String(cString: $0) }),
                  let statusText = sqlite3_column_text(stmt, 2).map({ String(cString: $0) }),
                  let run = AgentRunState(rawValue: statusText) else { continue }
            let started = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 3))
            let stepsText = sqlite3_column_text(stmt, 4).map { String(cString: $0) } ?? ""
            let steps: [AgentStep]
            if let rows = (try? JSONSerialization.jsonObject(with: Data(stepsText.utf8))) as? [[String: String]] {
                steps = rows.compactMap { row in
                    guard let title = row["title"], let tool = row["tool"],
                          let raw = row["state"], let state = AgentRunState(rawValue: raw) else { return nil }
                    return AgentStep(title: title, tool: tool, detail: row["detail"] ?? "", state: state)
                }
            } else {
                steps = stepsText.split(separator: "\u{2}").compactMap { chunk in
                let parts = chunk.split(separator: "\u{1}", omittingEmptySubsequences: false)
                guard parts.count == 3, let st = AgentRunState(rawValue: String(parts[2])) else { return nil }
                return AgentStep(title: String(parts[1]), tool: String(parts[0]), state: st)
                }
            }
            let record = sqlite3_column_text(stmt, 5).flatMap { json in
                try? JSONDecoder().decode(TaskRequestRecord.self, from: Data(String(cString: json).utf8))
            }
            out.append(AgentTask(requestRecord: record, id: id, title: title, status: run, steps: steps,
                                 startedAt: started, context: ContextBundle()))
        }
        sqlite3_finalize(stmt)
        return out
    }

    // MARK: - meeting sessions（§9 録音開始で insert、状態変化ごとに update）

    func saveSession(_ s: MeetingSession) {
        let sql = """
        INSERT OR REPLACE INTO meetings
        (id,title,status,started_at,ended_at,calendar_event_id,project_id,visibility,
         participant_count,summary,action_count,decision_count,source,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        bind(stmt, 1, s.id)
        bind(stmt, 2, s.title)
        bind(stmt, 3, s.status.rawValue)
        sqlite3_bind_double(stmt, 4, s.startedAt.timeIntervalSince1970)
        if let e = s.endedAt { sqlite3_bind_double(stmt, 5, e.timeIntervalSince1970) } else { sqlite3_bind_null(stmt, 5) }
        if let v = s.calendarEventId { bind(stmt, 6, v) } else { sqlite3_bind_null(stmt, 6) }
        if let v = s.projectId { bind(stmt, 7, v) } else { sqlite3_bind_null(stmt, 7) }
        bind(stmt, 8, s.visibility.rawValue)
        sqlite3_bind_int(stmt, 9, Int32(s.participantCount))
        if let v = s.summary { bind(stmt, 10, v) } else { sqlite3_bind_null(stmt, 10) }
        sqlite3_bind_int(stmt, 11, Int32(s.actionCount))
        sqlite3_bind_int(stmt, 12, Int32(s.decisionCount))
        if let v = s.source { bind(stmt, 13, v) } else { sqlite3_bind_null(stmt, 13) }
        sqlite3_bind_double(stmt, 14, s.createdAt.timeIntervalSince1970)
        sqlite3_bind_double(stmt, 15, s.updatedAt.timeIntervalSince1970)
        sqlite3_step(stmt)
        sqlite3_finalize(stmt)
    }

    func loadSessions() -> [MeetingSession] {
        let sql = """
        SELECT id,title,status,started_at,ended_at,calendar_event_id,project_id,visibility,
               participant_count,summary,action_count,decision_count,source,created_at,updated_at
        FROM meetings ORDER BY started_at DESC
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        func text(_ i: Int32) -> String? {
            sqlite3_column_text(stmt, i).map { String(cString: $0) }
        }
        var out: [MeetingSession] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let id = text(0) else { continue }
            let status = MeetingSession.Status(rawValue: text(2) ?? "ready") ?? .ready
            var session = MeetingSession(
                id: id,
                title: text(1) ?? "会議",
                status: status,
                startedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 3)))
            if sqlite3_column_type(stmt, 4) != SQLITE_NULL {
                session.endedAt = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 4))
            }
            session.calendarEventId = text(5)
            session.projectId = text(6)
            session.visibility = MeetingSession.Visibility(rawValue: text(7) ?? "mySpace") ?? .mySpace
            session.participantCount = Int(sqlite3_column_int(stmt, 8))
            session.summary = text(9)
            session.actionCount = Int(sqlite3_column_int(stmt, 10))
            session.decisionCount = Int(sqlite3_column_int(stmt, 11))
            session.source = text(12)
            session.createdAt = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 13))
            session.updatedAt = Date(timeIntervalSince1970: sqlite3_column_double(stmt, 14))
            out.append(session)
        }
        return out
    }

    // MARK: - transcripts（会議 id で引く。Library から同じ発言へ戻るための正本）

    /// 確定行を 1 つ書く。**確定のたびに書く**（止めたときにまとめて書くと、落ちたら全部消える）。
    /// `index` は文字起こしの中の位置。同じ位置を書き直せば置き換わる。
    func saveTranscriptRow(meetingId: String, index: Int, _ seg: TranscriptSegment) {
        let sql = "INSERT OR REPLACE INTO transcripts (id,meeting_id,speaker,text,at) VALUES (?,?,?,?,?)"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        bind(stmt, 1, "\(meetingId)#\(index)")
        bind(stmt, 2, meetingId)
        bind(stmt, 3, seg.speaker)
        bind(stmt, 4, seg.text)
        sqlite3_bind_double(stmt, 5, seg.at)
        sqlite3_step(stmt)
        sqlite3_finalize(stmt)
    }

    /// 拾ったものを丸ごと書き直す（抽出のたびに全体が変わるので、差分は取らない）。
    func saveNotes(meetingId: String, _ canvas: MeetingCanvas) {
        var del: OpaquePointer?
        if sqlite3_prepare_v2(db, "DELETE FROM meeting_notes WHERE meeting_id = ?", -1, &del, nil) == SQLITE_OK {
            bind(del, 1, meetingId); sqlite3_step(del)
        }
        sqlite3_finalize(del)
        let groups: [(String, [CanvasItem])] = [
            ("decision", canvas.decisions), ("action", canvas.actions),
            ("question", canvas.questions), ("concern", canvas.concerns), ("note", canvas.notes),
        ]
        let sql = "INSERT INTO meeting_notes (id,meeting_id,kind,text,speaker,at,position) VALUES (?,?,?,?,?,?,?)"
        for (kind, items) in groups {
            for (i, item) in items.enumerated() {
                var stmt: OpaquePointer?
                guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { continue }
                bind(stmt, 1, "\(meetingId)#\(kind)#\(i)")
                bind(stmt, 2, meetingId)
                bind(stmt, 3, kind)
                bind(stmt, 4, item.text)
                if let sp = item.speaker { bind(stmt, 5, sp) } else { sqlite3_bind_null(stmt, 5) }
                if let at = item.at { sqlite3_bind_double(stmt, 6, at) } else { sqlite3_bind_null(stmt, 6) }
                sqlite3_bind_int(stmt, 7, Int32(i))
                sqlite3_step(stmt)
                sqlite3_finalize(stmt)
            }
        }
    }

    /// その会議の拾ったもの。無ければ空の Canvas。
    func loadNotes(meetingId: String) -> MeetingCanvas {
        let sql = "SELECT kind,text,speaker,at FROM meeting_notes WHERE meeting_id = ? ORDER BY kind, position"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return MeetingCanvas() }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, meetingId)
        var out = MeetingCanvas()
        while sqlite3_step(stmt) == SQLITE_ROW {
            let kind = sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? ""
            let text = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
            let speaker = sqlite3_column_text(stmt, 2).map { String(cString: $0) }
            let at: TimeInterval? = sqlite3_column_type(stmt, 3) == SQLITE_NULL ? nil : sqlite3_column_double(stmt, 3)
            let item = CanvasItem(text, at: at, speaker: speaker)
            switch kind {
            case "decision": out.decisions.append(item)
            case "action": out.actions.append(item)
            case "question": out.questions.append(item)
            case "concern": out.concerns.append(item)
            default: out.notes.append(item)
            }
        }
        return out
    }

    /// その会議の確定行。`at` は録音開始からの秒。
    func loadTranscript(meetingId: String) -> [TranscriptSegment] {
        let sql = "SELECT speaker,text,at FROM transcripts WHERE meeting_id = ? ORDER BY at ASC"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, meetingId)
        var out: [TranscriptSegment] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let speaker = sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? ""
            let text = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
            out.append(TranscriptSegment(speaker: speaker, text: text, interim: false,
                                         at: sqlite3_column_double(stmt, 2)))
        }
        return out
    }

    // MARK: - context metadata（§25 本文は保存しない）

    func saveContextMetadata(_ fact: ContextFact) {
        let sql = """
        INSERT OR REPLACE INTO context_metadata
        (id,source,application,sensitivity,captured_at,expires_at) VALUES (?,?,?,?,?,?)
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        bind(stmt, 1, fact.id.uuidString)
        bind(stmt, 2, String(fact.source.rawValue))
        bind(stmt, 3, fact.application)
        bind(stmt, 4, fact.sensitivity.rawValue)
        sqlite3_bind_double(stmt, 5, fact.capturedAt.timeIntervalSince1970)
        sqlite3_bind_double(stmt, 6, fact.expiresAt.timeIntervalSince1970)
        sqlite3_step(stmt)
        sqlite3_finalize(stmt)
    }

    func countRows(_ table: String) -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM \(table)", -1, &stmt, nil) == SQLITE_OK else { return -1 }
        defer { sqlite3_finalize(stmt) }
        return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : -1
    }

    private func bind(_ stmt: OpaquePointer?, _ index: Int32, _ value: String) {
        sqlite3_bind_text(stmt, index, (value as NSString).utf8String, -1, nil)
    }
}
