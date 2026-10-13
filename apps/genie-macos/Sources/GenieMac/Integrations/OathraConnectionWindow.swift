import AppKit
import SwiftUI
import Security

/// Oathra is a separate service. This window is a human-controlled handoff, not an LLM tool.
@MainActor final class OathraConnectionWindow {
    static let shared = OathraConnectionWindow()
    private var window: NSWindow?
    func show() {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "Oathraとの連携"
            window.contentView = NSHostingView(rootView: OathraConnectionView())
            window.minSize = NSSize(width: 520, height: 500)
            window.isReleasedWhenClosed = false
            window.center(); self.window = window
        }
        window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
}

private enum OathraKeychain {
    static func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.reachmade.genie.oathra", kSecAttrAccount as String: origin]
    }
    static func get(_ origin: String) throws -> String? {
        var q = query(origin); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else { throw OathraConnectionError.invalidToken }
        return value
    }
    static func save(_ token: String, origin: String) throws {
        let attributes = [kSecValueData as String: Data(token.utf8)]
        let update = SecItemUpdate(query(origin) as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw OathraConnectionError.invalidToken }
        var q = query(origin); q.merge(attributes) { _, new in new }
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw OathraConnectionError.invalidToken }
    }
}

@MainActor private final class OathraConnectionModel: ObservableObject {
    @Published var origin = UserDefaults.standard.string(forKey: "genie.oathra.origin") ?? "http://127.0.0.1:4244"
    @Published var tokenInput = ""
    @Published var phone = ""
    @Published var recipient = ""
    @Published var purpose = ""
    @Published var caller = ""
    @Published var conversationMode = "message"
    @Published var preset = ""
    @Published var engine = ""
    @Published var existingID = UserDefaults.standard.string(forKey: "genie.oathra.lastMission") ?? ""
    @Published var status = "未接続"
    @Published var error: String?
    @Published var working = false
    @Published var acknowledged = false
    @Published var bootstrap: OathraValue = .null
    @Published var capabilities: OathraValue = .null
    @Published var mission: OathraValue = .null
    @Published var record: OathraValue = .null
    @Published var reviewing = false
    @Published var showTranscript = false
    private var client: OathraGatewayClient?
    private var grant: String?, expiresAt = Date.distantPast, startKey = "", consentVersion = ""
    private var polling: Task<Void, Never>?
    private var dispatchUncertain = false

    var connected: Bool { client != nil }
    var currentID: String { mission["id"].text }
    var canonicalState: String { mission["status"].text }
    var busyCall: Bool { dispatchUncertain || ["QUEUED", "DIALING", "ACTIVE", "CANCEL_REQUESTED", "UNKNOWN"].contains(canonicalState) }
    var canReview: Bool { connected && canonicalState == "DRAFT" && !working && !dispatchUncertain }
    var canStart: Bool { canReview && reviewing && acknowledged && grant != nil && expiresAt > Date() && (capabilities["ready"].flag || mission["mode"].text == "simulator") }
    var engineOptions: [OathraValue] { capabilities["engines"].values.filter { $0["ready"].flag } }
    var presetOptions: [(String, String)] { capabilities["voicePresets"].fields.map { ($0.key, $0.value.text) }.sorted { $0.0 < $1.0 } }

    private func invalidateReview() { grant = nil; reviewing = false; acknowledged = false; expiresAt = .distantPast }
    private func report(_ e: Error) { error = e.localizedDescription }
    func connect() async {
        guard !working && !busyCall else { return }; working = true; error = nil; invalidateReview()
        defer { working = false }
        do {
            let normalized = try OathraGatewayClient.originURL(origin).absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let token = tokenInput.isEmpty ? try OathraKeychain.get(normalized) ?? "" : tokenInput
            let next = try OathraGatewayClient(origin: normalized, token: token)
            let b = try await next.request("/bootstrap"), c = try await next.request("/phone/status")
            guard !b["user"]["id"].text.isEmpty else { throw OathraConnectionError.invalidResponse }
            try OathraKeychain.save(token, origin: normalized)
            polling?.cancel(); client = next; bootstrap = b; capabilities = c; origin = normalized; tokenInput = ""
            mission = .null; record = .null; engine = ""; preset = ""; status = "接続済み：" + b["user"]["id"].text
            UserDefaults.standard.set(normalized, forKey: "genie.oathra.origin")
        } catch { client = nil; report(error) }
    }
    /// Drafting transmits only the fields the user entered. It does not start a call.
    func draft() async {
        guard let client, !working, !busyCall else { return }; working = true; error = nil; invalidateReview()
        defer { working = false }
        do {
            var values: [String: OathraValue] = ["phone": .string(phone), "name": .string(recipient), "instruction": .string(purpose), "conversationMode": .string(conversationMode)]
            if !caller.isEmpty { values["callerName"] = .string(caller) }
            if !preset.isEmpty { values["voicePreset"] = .string(preset) }
            if !engine.isEmpty { values["engine"] = .string(engine) }
            let value = try await client.request("/phone/draft", method: "POST", body: .object(values))
            let m = value["mission"]
            guard UUID(uuidString: m["id"].text) != nil, m["kind"].text == "phone-request", m["status"].text == "DRAFT" else { throw OathraConnectionError.invalidResponse }
            // Discard /phone/draft's approvalToken. A human must open a fresh review below.
            mission = m; record = .null; existingID = m["id"].text; dispatchUncertain = false
            UserDefaults.standard.set(existingID, forKey: "genie.oathra.lastMission")
            status = "下書き保存済み。まだ発信していません。"
        } catch { report(error); status = "下書きの保存結果を確認してください。自動再試行はしていません。" }
    }
    func openExisting() async {
        guard let client, !working, !busyCall else { return }; working = true; error = nil; invalidateReview()
        defer { working = false }
        do {
            let m = try await client.mission(existingID)
            mission = m; record = try await client.record(m["id"].text); dispatchUncertain = false
            UserDefaults.standard.set(m["id"].text, forKey: "genie.oathra.lastMission")
            status = "Oathraの依頼を読み込みました。"; startPolling()
        } catch { report(error) }
    }
    func prepareReview() async {
        guard let client, canReview else { return }; working = true; error = nil; invalidateReview()
        defer { working = false }
        do {
            let id = try OathraGatewayClient.missionID(currentID)
            let b = try await client.request("/bootstrap"), c = try await client.request("/phone/status")
            let r = try await client.request("/missions/" + id + "/review", method: "POST", body: .object([:]))
            guard r["mission"]["id"].text == id, r["mission"]["status"].text == "DRAFT", !r["approvalToken"].text.isEmpty,
                  let seconds = r["expiresInSeconds"].number, seconds > 0, seconds <= 300, !b["configuration"]["consentVersion"].text.isEmpty else { throw OathraConnectionError.invalidResponse }
            bootstrap = b; capabilities = c; mission = r["mission"]
            grant = r["approvalToken"].text; expiresAt = Date().addingTimeInterval(seconds); consentVersion = b["configuration"]["consentVersion"].text
            startKey = UUID().uuidString; reviewing = true; acknowledged = false
        } catch { report(error) }
    }
    /// This function is not exported as a model/MCP tool; only the explicit native button invokes it.
    func humanStart() async {
        guard let client, canStart, let grant else { invalidateReview(); return }
        let id = currentID, key = startKey, consent = consentVersion
        working = true; error = nil
        // A reviewed grant is never reused after an attempted submission.
        invalidateReview()
        defer { working = false }
        do {
            _ = try await client.request("/consent", method: "POST", body: .object(["version": .string(consent)]))
            dispatchUncertain = true
            _ = try await client.request("/missions/" + id + "/start", method: "POST", body: .object(["approvalToken": .string(grant), "acknowledged": .bool(true)]), key: key)
            status = "実行を受け付けました。業務の完了はまだ確認していません。"
            await refreshNow(); startPolling()
        } catch {
            if case OathraConnectionError.rejected(let code, _) = error, (400...499).contains(code), code != 408 { dispatchUncertain = false }
            report(error)
            status = dispatchUncertain ? "発信の結果が不明です。再発信せず状況を更新してください。" : "発信前に停止しました。内容を再確認してください。"
            await refreshNow(); startPolling()
        }
    }
    func refresh() async { guard !working else { return }; working = true; defer { working = false }; await refreshNow() }
    private func refreshNow() async {
        guard let client, !currentID.isEmpty else { return }
        let id = currentID
        do {
            let m = try await client.mission(id), r = try await client.record(id)
            guard currentID == id else { return }; mission = m; record = r
            // A post-timeout DRAFT is not proof that a start request never reached the server.
            if m["status"].text != "DRAFT" { dispatchUncertain = false }
            if canonicalState != "DRAFT" { status = "Oathraの状態：" + canonicalState }
        } catch { report(error) }
    }
    func stop() async {
        guard let client, !working, ["QUEUED", "DIALING", "ACTIVE"].contains(canonicalState) else { return }
        working = true; error = nil; defer { working = false }
        do { _ = try await client.request("/missions/" + currentID + "/cancel", method: "POST", body: .object([:])); await refreshNow() }
        catch { report(error) }
    }
    func closeReview() { invalidateReview() }
    func stopPolling() { polling?.cancel(); polling = nil }
    private func startPolling() {
        stopPolling()
        polling = Task { [weak self] in
            // Bounded foreground convenience polling, never an automatic retry of a mutation.
            for _ in 0..<180 {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                guard let self, !Task.isCancelled, self.busyCall else { return }
                if !self.working { await self.refreshNow() }
            }
        }
    }
    var copyableResult: String {
        ["Oathra依頼ID：" + currentID, "実行状態：" + canonicalState, "結果：" + mission["result"]["caveat"].text,
         "会話で確認した内容は、外部システムへの予約登録を保証しません。"].joined(separator: "\n")
    }
}

@MainActor private struct OathraConnectionView: View {
    @StateObject private var model = OathraConnectionModel()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Oathraに電話を任せる").font(.title2).bold()
                Text("Genieで依頼を用意し、あなたが内容・料金・データの扱いを確認してから実行します。AIの返答だけで予約完了とは判定しません。")
                    .foregroundStyle(.secondary)
                GroupBox("接続") {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Gateway URL（ArenaのURLではありません）", text: $model.origin)
                        SecureField("Oathraの利用者用トークン（保存済みなら空欄）", text: $model.tokenInput)
                        Text("トークンはこのMacのKeychainに保存します。電話会社や音声モデルのAPIキーは貼り付けません。")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("保存して接続") { Task { await model.connect() } }.disabled(model.working || model.busyCall)
                    }.disabled(model.working || model.busyCall || model.reviewing)
                }
                Text(model.status).font(.callout).accessibilityLabel("連携状態：" + model.status)
                if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                if model.connected {
                    GroupBox("新しい電話依頼") {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("相手の電話番号", text: $model.phone)
                            TextField("相手の名前", text: $model.recipient)
                            TextField("あなたの名前（誰の代わりか伝えます）", text: $model.caller)
                            Text("伝えること・確認すること")
                            TextEditor(text: $model.purpose).frame(minHeight: 90).accessibilityLabel("電話の目的")
                            Picker("会話", selection: $model.conversationMode) { Text("伝言・確認").tag("message"); Text("雑談").tag("chat") }
                            Picker("音声AI", selection: $model.engine) {
                                Text("Oathraの標準").tag("")
                                ForEach(Array(model.engineOptions.enumerated()), id: \.offset) { _, item in Text(item["label"].text).tag(item["id"].text) }
                            }
                            Picker("話し方", selection: $model.preset) {
                                Text("指定しない").tag("")
                                ForEach(model.presetOptions, id: \.0) { item in Text(item.1).tag(item.0) }
                            }
                            Text("表示される音声は接続したGatewayの対応範囲です。Arena専用のcharacter-ttsへ自動で切り替えません。")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("Oathraに下書きを保存（発信しない）") { Task { await model.draft() } }
                                .disabled(model.phone.isEmpty || model.recipient.isEmpty || model.purpose.isEmpty)
                        }.disabled(model.working || model.busyCall || model.reviewing)
                    }
                    GroupBox("ほかのAI・MCPで作った依頼を開く") {
                        HStack { TextField("Oathraの依頼ID", text: $model.existingID)
                            Button("開く") { Task { await model.openExisting() } }
                        }.disabled(model.working || model.busyCall || model.reviewing)
                    }
                    if !model.currentID.isEmpty {
                        GroupBox("依頼と結果") {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("ID：" + model.currentID).font(.caption).textSelection(.enabled)
                                Text("Oathraの状態：" + model.canonicalState).bold()
                                Text("相手：" + model.mission["target"]["name"].text + " · " + model.mission["target"]["phone"].text)
                                Text(model.mission["request"].text).textSelection(.enabled)
                                Text("通話の終了と、予約・商談の成立は別です。会話の合意は外部システムの登録証明ではありません。")
                                    .font(.caption).foregroundStyle(.secondary)
                                if !model.mission["result"]["caveat"].text.isEmpty { Text(model.mission["result"]["caveat"].text) }
                                ForEach(Array(model.record["memory"]["notes"].values.enumerated()), id: \.offset) { _, note in
                                    Text(note["field"].text + "：" + note["value"].display + "（" + note["status"].text + "）\n" + note["quote"].text).textSelection(.enabled)
                                }
                                HStack {
                                    Button("状況を更新") { Task { await model.refresh() } }.disabled(model.working)
                                    Button("結果をコピー") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.copyableResult, forType: .string) }
                                    if model.canReview { Button("この下書きの内容・料金を確認") { Task { await model.prepareReview() } } }
                                    if ["QUEUED", "DIALING", "ACTIVE"].contains(model.canonicalState) { Button("停止を要求") { Task { await model.stop() } }.disabled(model.working) }
                                }
                                DisclosureGroup("会話本文を表示", isExpanded: $model.showTranscript) {
                                    ForEach(Array(model.record["transcript"].values.enumerated()), id: \.offset) { _, line in Text(line["source"].text + "：" + line["text"].text).textSelection(.enabled) }
                                }
                            }
                        }
                    }
                    if model.reviewing { reviewView }
                }
                Text("このウインドウを閉じても、開始済みの電話はOathra側で続きます。実行中は停止操作かOathraの管理画面で終了を確認してください。")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }.onDisappear { model.stopPolling() }
    }
    private var reviewView: some View {
        GroupBox("発信前の確認") {
            VStack(alignment: .leading, spacing: 10) {
                Text("相手：" + model.mission["target"]["name"].text + " · " + model.mission["target"]["phone"].text).bold()
                Text("依頼内容：" + model.mission["request"].text).textSelection(.enabled)
                Text("依頼者名：" + (model.mission["phoneRequest"]["callerName"].text.isEmpty ? "指定なし" : model.mission["phoneRequest"]["callerName"].text))
                Text("音声：" + model.mission["phoneRequest"]["engine"].text + " / " + model.mission["phoneRequest"]["voicePreset"].text + " / " + model.mission["phoneRequest"]["voice"].text)
                Text("時間上限：" + model.mission["maxSeconds"].display + "秒 · 設定上限：$" + model.mission["maxUsd"].display)
                Text("クレジット：" + model.mission["creditQuote"]["amount"].display + " · 算定方式：" + model.mission["creditQuote"]["policy"].text)
                Text("上限額・停止は通信会社の最終請求額の保証ではありません。返却・精算待ちを含む条件はOathraの方針が適用されます。")
                    .font(.caption)
                Text(model.capabilities["disclosure"].text).textSelection(.enabled)
                Text("選択した音声AIがGeminiの場合はGoogleにも会話データが送られます。本人から依頼された目的の範囲に限って利用してください。")
                    .font(.caption)
                if !model.capabilities["ready"].flag && model.mission["mode"].text != "simulator" { Text("実発信の準備ができていません。").foregroundStyle(.red) }
                Toggle("宛先・内容・費用・データの送信と保存を確認しました", isOn: $model.acknowledged)
                HStack {
                    Button("確認を閉じる") { model.closeReview() }
                    Button(model.mission["mode"].text == "simulator" ? "確認用シミュレーターを実行（発信なし）" : "同意してこの番号に電話する") { Task { await model.humanStart() } }
                        .disabled(!model.canStart)
                }.disabled(model.working)
            }
        }
    }
}
