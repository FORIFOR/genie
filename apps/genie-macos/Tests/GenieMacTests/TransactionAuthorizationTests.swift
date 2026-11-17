import XCTest
import AppKit
import SwiftUI
@testable import GenieMac

@MainActor final class TransactionAuthorizationTests: XCTestCase {
    let approvalID = "01a0f833-323e-7000-8e7f-7985ad9370f3"
    let grantID = "01a0f833-323e-7000-8e7f-7985ad9370f4"
    private func contextData(mode: String = "simulation", expiry: Date = Date().addingTimeInterval(300)) throws -> Data {
        let item: [String: Any] = ["id": "pizza", "label": "模擬マルゲリータ", "quantity": 2, "options": ["チーズ"]]
        let intent: [String: Any] = ["kind": "delivery", "mode": mode, "provider": "local-simulation", "account": "demo-account", "orderKey": "order-1", "currency": "JPY", "destination": ["id": "home", "label": "模擬配送先"], "paymentMethodRef": "simulation-payment", "requestedTime": "asap", "items": [item], "maxTotalMinor": 3000]
        var quote = intent; quote.removeValue(forKey: "maxTotalMinor")
        quote["quoteId"] = "quote-1"; quote["expiresAt"] = ISO8601DateFormatter().string(from: expiry)
        quote["items"] = [item.merging(["unitMinor": 1000, "lineMinor": 2000]) { _, new in new }]
        quote["totals"] = ["subtotalMinor": 2000, "taxMinor": 200, "feeMinor": 100, "tipMinor": 0, "totalMinor": 2300]
        return try JSONSerialization.data(withJSONObject: ["intent": intent, "quote": quote, "quoteHash": String(repeating: "a", count: 64)])
    }
    private func approval() -> BackendApproval {
        BackendApproval(id: approvalID, summary: "この内容で注文をシミュレーションします", risk: "FINANCIAL",
            details: [.init(label: "商品・数量", value: "模擬マルゲリータ × 2"), .init(label: "合計（税・手数料・チップ込み）", value: "JPY 2300")],
            impact: .init(primaryActionLabel: "注文をシミュレーションする", affectedCount: 1, external: false,
                          reversible: false, recoveryNote: "実際の注文や支払いは発生しません"))
    }
    private func response(_ request: URLRequest, data: Data, status: Int = 200) -> (Data, HTTPURLResponse) {
        (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
    private func created(_ request: URLRequest) throws -> Data {
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        return try JSONSerialization.data(withJSONObject: ["approvalId": approvalID, "authorization": ["id": grantID,
            "createdBy": approvalID, "createdAt": "2026-10-02T00:00:00Z", "status": "ACTIVE", "revokedAt": NSNull(),
            "spec": body["spec"]!, "usedOrders": 1, "usedTotalMinor": 2300]])
    }

    func testContextIsSimulationOnlyAndScopePreservesExactFixedFields() throws {
        let context = try TransactionAuthorizationContext.decode(contextData())
        let scope = try JSONSerialization.jsonObject(with: context.scopeJSON) as! [String: Any]
        XCTAssertNil(scope["orderKey"]); XCTAssertNil(scope["maxTotalMinor"])
        XCTAssertEqual(scope["requestedTime"] as? String, "asap")
        XCTAssertEqual(context.scope.items.first?.quantity, 2)
        XCTAssertEqual(context.scope.items.first?.options, ["チーズ"])
        XCTAssertTrue(context.scope.review.contains("simulation-payment"))
        XCTAssertThrowsError(try TransactionAuthorizationContext.decode(contextData(mode: "live")))
        XCTAssertThrowsError(try TransactionAuthorizationContext.decode(contextData(expiry: .distantPast)))
    }
    func testMoneyNeverRoundsOrGuessesAnUnknownCurrencyExponent() {
        XCTAssertEqual(TransactionMoney.parse("23.01", currency: "USD"), 2301)
        XCTAssertNil(TransactionMoney.parse("23.011", currency: "USD"))
        XCTAssertNil(TransactionMoney.parse("23.5", currency: "JPY"))
        XCTAssertNil(TransactionMoney.parse("-1", currency: "JPY"))
        XCTAssertNil(TransactionMoney.parse("9007199254740992", currency: "JPY"))
        XCTAssertEqual(TransactionMoney.parse("2301", currency: "KWD"), 2301)
        XCTAssertEqual(TransactionMoney.display(2301, currency: "KWD"), "KWD minor units 2301")
    }
    func testOnceIsDefaultAndMerelyReadingTheContextNeverCreatesPermission() async throws {
        let state = TransactionAuthorizationState(), data = try contextData()
        var methods: [String] = []
        var api = TransactionAuthorizationAPI(base: "http://localhost:8787", token: "test")
        api.send = { request in methods.append(request.httpMethod!); return self.response(request, data: data) }
        let card = await state.prepare(ActionConfirmation(backendApproval: approval()), approval: approval(), api: api)
        XCTAssertNotNil(card.transactionAuthorization)
        XCTAssertEqual(state.drafts[card.id]?.recurring, false)
        XCTAssertEqual(state.drafts[card.id]?.orders, "3")
        XCTAssertEqual(state.drafts[card.id]?.total, "9000")
        let submitted = await state.submit(card.id)
        XCTAssertFalse(submitted)
        XCTAssertEqual(methods, ["GET"])
    }
    func testUnknownWriteFreezesTheExactRequestAndNeverFallsBackToOnce() async throws {
        let state = TransactionAuthorizationState(), data = try contextData()
        var posted: [Data] = []
        var api = TransactionAuthorizationAPI(base: "http://localhost:8787", token: "test")
        api.send = { request in
            if request.httpMethod == "GET" { return self.response(request, data: data) }
            posted.append(request.httpBody!)
            if posted.count == 1 { throw URLError(.timedOut) }
            return self.response(request, data: try self.created(request))
        }
        let card = await state.prepare(ActionConfirmation(backendApproval: approval()), approval: approval(), api: api)
        state.update(card.id) { $0.recurring = true }
        let first = await state.submit(card.id)
        XCTAssertFalse(first)
        state.update(card.id) { $0.recurring = false; $0.total = "99999" }
        XCTAssertTrue(state.drafts[card.id]?.recurring == true)
        XCTAssertEqual(state.drafts[card.id]?.total, "9000")
        let second = await state.submit(card.id)
        XCTAssertTrue(second)
        XCTAssertEqual(posted.count, 2)
        XCTAssertEqual(posted[0], posted[1], "通信不明の再確認で requestId/body が変わった")
        XCTAssertEqual(state.drafts[card.id]?.created?.usedOrders, 1, "現在の注文も上限に含む")
        XCTAssertEqual(state.drafts[card.id]?.created?.remainingOrders, 2)
    }
    func testInvalidLimitsCannotSubmitAndReturnedDifferentApprovalCannotCloseCard() async throws {
        let state = TransactionAuthorizationState(), data = try contextData()
        var writes = 0
        var api = TransactionAuthorizationAPI(base: "http://localhost:8787", token: "test")
        api.send = { request in
            if request.httpMethod == "GET" { return self.response(request, data: data) }
            writes += 1
            var value = try JSONSerialization.jsonObject(with: self.created(request)) as! [String: Any]
            value["approvalId"] = self.grantID
            return self.response(request, data: try JSONSerialization.data(withJSONObject: value))
        }
        let card = await state.prepare(ActionConfirmation(backendApproval: approval()), approval: approval(), api: api)
        state.update(card.id) { $0.recurring = true; $0.orders = "1001" }
        let invalid = await state.submit(card.id)
        XCTAssertFalse(invalid); XCTAssertEqual(writes, 0)
        state.update(card.id) { $0.orders = "3" }
        let mismatched = await state.submit(card.id)
        XCTAssertFalse(mismatched); XCTAssertEqual(writes, 1)
        XCTAssertNil(state.drafts[card.id]?.created)
    }
    func testDelegatedAnswerDoesNotSendTheOldApproveEndpoint() async throws {
        let first = TaskFollowUp(reply: TaskReply(text: "", phase: .waiting), pendingApprovals: [approval()])
        var followed = false
        let result = try await VoiceHUDState.settleApprovals(first, waitMs: 1,
            ask: { _ in .delegated }, approve: { _, _ in XCTFail("委任で承認済みの注文へ二重承認した") },
            reject: { _ in XCTFail() }, follow: { _ in followed = true; return TaskFollowUp(reply: TaskReply(text: "模擬注文受付", phase: .complete)) })
        XCTAssertTrue(followed); XCTAssertEqual(result.reply.phase, .complete)
    }
    func testUnknownAuthorizationNeverClaimsTheOrderWasNotExecuted() async throws {
        let first = TaskFollowUp(reply: TaskReply(text: "", phase: .waiting), pendingApprovals: [approval()])
        let result = try await VoiceHUDState.settleApprovals(first, waitMs: 1,
            ask: { _ in .authorizationUnknown }, approve: { _, _ in XCTFail() }, reject: { _ in XCTFail() }, follow: { _ in XCTFail(); return first })
        XCTAssertEqual(result.reply.phase, .unknown)
        XCTAssertTrue(result.reply.text.contains("未確認"))
        XCTAssertFalse(result.reply.text.contains("実行していません"))
    }
    func testBothChoicesFitTheExistingConfirmationCapAndRenderFixtures() async throws {
        let state = TransactionAuthorizationState.shared, data = try contextData()
        let wasHeadless = WindowCoordinator.headless
        WindowCoordinator.headless = true
        defer { WindowCoordinator.headless = wasHeadless }
        var api = TransactionAuthorizationAPI(base: "http://localhost:8787", token: "test")
        api.send = { request in self.response(request, data: data) }
        let card = await state.prepare(ActionConfirmation(backendApproval: approval()), approval: approval(), api: api)
        defer { state.remove(card.id) }
        var geometry: [String: Double] = [:]
        for recurring in [false, true] {
            state.update(card.id) { $0.recurring = recurring }
            let height = try XCTUnwrap(DockContentMeasure.height(of: .confirmation(card), width: Metrics.dockConfirmWidth))
            XCTAssertLessThanOrEqual(height, 360, "確認ボタンが既存の面から切れる")
            geometry[recurring ? "bounded" : "once"] = height
            if let folder = ProcessInfo.processInfo.environment["GENIE_TRANSACTION_GOLDEN_DIR"] {
                for dark in [false, true] {
                    let view = ConfirmationDock(confirmation: card).frame(width: Metrics.dockConfirmWidth, height: height)
                        .background(dark ? Color.black : Color.white).environment(\.colorScheme, dark ? .dark : .light)
                    let host = NSHostingView(rootView: view)
                    host.frame = NSRect(x: 0, y: 0, width: Metrics.dockConfirmWidth, height: height)
                    var nativePanel: NSPanel?
                    if ProcessInfo.processInfo.environment["GENIE_TRANSACTION_NATIVE"] == "1" {
                        let before = NSWorkspace.shared.frontmostApplication?.processIdentifier
                        let panel = GeniePanel(size: host.frame.size, level: .floating, canKey: false, content: view)
                        panel.contentView = host
                        panel.center(); panel.orderFrontRegardless()
                        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
                        XCTAssertEqual(NSWorkspace.shared.frontmostApplication?.processIdentifier, before, "fixture が前面アプリを奪った")
                        let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
                        XCTAssertTrue(windows.contains { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == panel.windowNumber })
                        XCTAssertGreaterThanOrEqual(panel.contentView?.bounds.height ?? 0, height)
                        geometry[recurring ? "boundedNativeHeight" : "onceNativeHeight"] = Double(panel.frame.height)
                        nativePanel = panel
                    }
                    defer { nativePanel?.orderOut(nil); nativePanel?.close() }
                    host.layoutSubtreeIfNeeded()
                    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                    host.cacheDisplay(in: host.bounds, to: bitmap)
                    let path = URL(fileURLWithPath: folder).appendingPathComponent("\(recurring ? "bounded" : "once")-\(dark ? "dark" : "light").png")
                    try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: path)
                }
            }
        }
        if let folder = ProcessInfo.processInfo.environment["GENIE_TRANSACTION_GOLDEN_DIR"] {
            try JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: folder).appendingPathComponent("geometry.json"))
        }
    }

    func testManagementUsesConfirmedServerUsageAndRevokeStateAndClearsOnCredentialChange() async throws {
        let context = try TransactionAuthorizationContext.decode(contextData())
        let spec = try XCTUnwrap(TransactionAuthorizationState.Draft(context: context, approvalID: approvalID).spec())
        let specObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(spec))
        var object: [String: Any] = ["id": grantID, "createdBy": approvalID, "createdAt": "2026-10-02T00:00:00Z", "status": "ACTIVE", "revokedAt": NSNull(), "spec": specObject, "usedOrders": 1, "usedTotalMinor": 2300]
        var calls: [String] = []
        var api = TransactionAuthorizationAPI(base: "http://localhost:8787", token: "old-test")
        api.send = { request in
            calls.append(request.httpMethod!)
            if request.httpMethod == "POST" { object["status"] = "REVOKED"; object["revokedAt"] = "2026-10-02T00:01:00Z" }
            let payload = request.httpMethod == "POST" ? ["authorization": object] : ["items": [object]]
            return self.response(request, data: try JSONSerialization.data(withJSONObject: payload))
        }
        let state = TransactionAuthorizationState(api: api)
        await state.load()
        XCTAssertEqual(state.records.first?.remainingOrders, 2)
        XCTAssertEqual(state.records.first?.remainingMinor, 6700)
        await state.revoke(grantID)
        XCTAssertEqual(state.records.first?.status, "REVOKED")
        XCTAssertEqual(state.records.first?.usedOrders, 1, "取消は注文や予約量を取り消さない")
        XCTAssertEqual(calls, ["GET", "POST"])
        state.configure(base: api.base, token: "new-test")
        XCTAssertTrue(state.records.isEmpty, "別のcredentialの前に古い一覧を表示した")
    }

    func testSafetyCopyRendersAtScrollEndAndInManagement() async throws {
        let state = TransactionAuthorizationState.shared, data = try contextData()
        var writes = 0
        let wasHeadless = WindowCoordinator.headless
        WindowCoordinator.headless = true
        defer { WindowCoordinator.headless = wasHeadless }
        var api = TransactionAuthorizationAPI(base: "http://localhost:8787", token: "test")
        api.send = { request in
            if request.httpMethod != "GET" { writes += 1 }
            XCTAssertEqual(request.httpMethod, "GET", "Rendering must not create a grant")
            return self.response(request, data: data)
        }
        let card = await state.prepare(ActionConfirmation(backendApproval: approval()), approval: approval(), api: api)
        defer { state.remove(card.id) }
        for invalid in [false, true] {
            state.update(card.id) { $0.recurring = true; $0.orders = invalid ? "1001" : "3" }
            let height = try XCTUnwrap(DockContentMeasure.height(of: .confirmation(card), width: Metrics.dockConfirmWidth))
            XCTAssertLessThanOrEqual(height, 360)
            for dark in [false, true] {
                let view = ConfirmationDock(confirmation: card).frame(width: Metrics.dockConfirmWidth, height: height)
                    .background(dark ? Color.black : Color.white).environment(\.colorScheme, dark ? .dark : .light)
                try await DisclosureCopyFixture.capture(view,
                    name: "transaction-\(invalid ? "invalid" : "scope")-bottom-\(dark ? "dark" : "light")",
                    width: Metrics.dockConfirmWidth, height: height, scrollToBottom: true,
                    verify: { _ in
                        guard invalid else { return }
                        // Exercise the rendered button's real action after the arm delay.
                        // UIProbe is not a physical click; it must also respect disabled input.
                        try await Task.sleep(nanoseconds: UInt64((ActionConfirmation.proceedArmDelay + 0.1) * 1_000_000_000))
                        XCTAssertTrue(UIProbe.tap("confirmProceed"))
                        try await Task.sleep(nanoseconds: 20_000_000)
                        XCTAssertEqual(writes, 0)
                        XCTAssertNil(state.drafts[card.id]?.frozenBody)
                        XCTAssertEqual(state.drafts[card.id]?.message, "", "Disabled action entered submission")
                    })
            }
        }
        state.update(card.id) { $0.orders = "3" }
        XCTAssertNotNil(state.drafts[card.id]?.spec(), "Corrected input must restore the valid state")
        let context = try TransactionAuthorizationContext.decode(data)
        let spec = try XCTUnwrap(TransactionAuthorizationState.Draft(context: context, approvalID: approvalID).spec())
        let object: [String: Any] = ["id": grantID, "createdBy": approvalID, "createdAt": "2026-10-02T00:00:00Z",
            "status": "ACTIVE", "revokedAt": NSNull(), "spec": try JSONSerialization.jsonObject(with: JSONEncoder().encode(spec)),
            "usedOrders": 1, "usedTotalMinor": 2300]
        var listAPI = TransactionAuthorizationAPI(base: "http://localhost:8787", token: "test")
        listAPI.send = { request in
            XCTAssertEqual(request.httpMethod, "GET", "Rendering must not revoke a grant")
            return self.response(request, data: try JSONSerialization.data(withJSONObject: ["items": [object]]))
        }
        let listState = TransactionAuthorizationState(api: listAPI)
        await listState.load()
        XCTAssertEqual(listState.records.count, 1)
        for dark in [false, true] {
            let view = TransactionAuthorizationListView(state: listState)
                .background(dark ? Color.black : Color.white).environment(\.colorScheme, dark ? .dark : .light)
            try await DisclosureCopyFixture.capture(view, name: "transaction-list-\(dark ? "dark" : "light")",
                width: Metrics.dockConfirmWidth, height: Metrics.dockMeetingExpandedHeight)
        }
    }
}
