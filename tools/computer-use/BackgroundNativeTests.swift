//  背景ネイティブ入力の回帰テスト。製品コードではない。
//  見るもの: 重複が無いこと・押下と解放が対応すること・AXPress の無い面を押せること・
//            入力の途中で止めたときに鍵を残さないこと・修飾キーが残らないこと。
import AppKit
import ScreenCaptureKit

@main struct NativeTests {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await run(); exit(0) } catch { print("FAIL \(error)"); exit(1) }
        }
        app.run()
    }
    struct Rect: Decodable { let x: Double; let y: Double; let width: Double; let height: Double
        var cg: CGRect { CGRect(x: x, y: y, width: width, height: height) } }
    struct Readback: Decodable { let plateClicks: Int; let keyDowns: Int; let keyUps: Int; let text: String
        let plateRect: Rect; let fieldRect: Rect; let buttonClicks: Int; let pictureClicks: Int
        let otherText: String; let otherRect: Rect
        let searchSubmits: Int; let searchText: String; let searchRect: Rect }
    /// capture が返す操作候補。位置は含まれない。
    struct Candidate: Decodable { let id: String; let role: String; let name: String }
    struct CaptureReply: Decodable { let elements: [Candidate]? }

    @MainActor static func run() async throws {
        guard #available(macOS 14.4, *) else { throw Failure("unsupported") }
        let pid = Int32(CommandLine.arguments[1])!
        let root = URL(fileURLWithPath: CommandLine.arguments[2])
        let readbackPath = CommandLine.arguments[3]
        let bundle = CommandLine.arguments[4]
        func readback() throws -> Readback {
            try JSONDecoder().decode(Readback.self, from: Data(contentsOf: URL(fileURLWithPath: readbackPath)))
        }
        guard PrivateSPI.available else { throw Failure("background_spi_unavailable") }
        /*
         * fixture は窓を 2 つ持つ（鍵の宛先を試すため）ので、**どれを対象にするかを決めておく。**
         * `first` のままでは並び順に依存し、2 つ目を掴んだ回だけ
         * `background_window_ambiguous` で落ちていた（今日この窓を足して入り込んだ）。
         * 広い方＝操作対象の窓を選ぶ。
         */
        guard let onScreen = Helper.onScreenWindows(pid: pid)
            .max(by: { $0.1.width * $0.1.height < $1.1.width * $1.1.height })
        else { throw Failure("window_missing") }
        let target = Target(bundleId: bundle, windowId: onScreen.0, pid: pid, bounds: onScreen.1)
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let cursor = CGEvent(source: nil)!.location
        let flagsBefore = CGEventSource.flagsState(.combinedSessionState).rawValue & 0xFFFF0000

        let session = UUID().uuidString.lowercased()
        let sessionPath = try BackgroundAX.sessionPath(root, session)
        let grant = BackgroundAX.Grant(pid: target.pid, window: target.windowId, bundle: target.bundleId,
                                       generation: try BackgroundAX.generation(target.pid, bundle: target.bundleId),
                                       // 実物と同じ 20 分。1 回の依頼ぶん（5 分）が残っている状態。
                                       expires: Date().timeIntervalSince1970 + 1200, recipient: "local")
        try BackgroundAX.privateFile(JSONEncoder().encode(grant), sessionPath)
        try BackgroundAX.watch(sessionPath)

        func frame(_ scope: String? = nil) async throws -> (Frame, String) {
            let session = scope ?? session
            let id = "cv-\(UUID().uuidString.lowercased())"
            let path = root.appendingPathComponent("\(id).png").path
            let request: [String: Any] = ["op": "capture", "id": id, "outputPath": path,
                "scope": ["id": id, "bundleId": target.bundleId, "windowId": target.windowId, "pid": target.pid,
                          "capturedAt": Date().timeIntervalSince1970 * 1000, "width": 1, "height": 1,
                          "bounds": ["x": target.bounds.x, "y": target.bounds.y,
                                     "width": target.bounds.width, "height": target.bounds.height],
                          "sha256": "", "deliveryMode": "background", "backgroundSession": session]]
            let out = try await BackgroundAX.respond(
                JSONDecoder().decode(Request.self, from: try JSONSerialization.data(withJSONObject: request)))
            lastCandidates = (try? JSONDecoder().decode(CaptureReply.self, from: out))?.elements ?? []
            return (try JSONDecoder().decode(Frame.self, from: out), path)
        }
        /// 要素を名前で選ぶ。テストが「どれか」を決め、位置は製品側に取り直させる。
        func candidate(_ name: String) throws -> String {
            guard let hit = lastCandidates.first(where: { $0.name == name }) else {
                throw Failure("candidate_missing_\(name)_of_\(lastCandidates.count)")
            }
            return hit.id
        }
        /// element_id で指す apply。座標は一切渡さない。
        func applyElement(_ f: Frame, _ path: String, _ action: String, id: String, text: String? = nil) async throws -> String {
            var a: [String: Any] = ["action": action, "frameId": f.id, "confidence": 1, "element_id": id,
                "elementId": id, "risk": action == "click" ? "navigation" : "draft",
                "expectation": "element selection regression"]
            if let text { a["text"] = text }
            let request: [String: Any] = ["op": "apply", "action": a, "referencePath": path,
                "scope": try JSONSerialization.jsonObject(with: JSONEncoder().encode(f)),
                "authorizationExpiresAt": Date().timeIntervalSince1970 * 1000 + 60000]
            let out = try await BackgroundAX.respond(
                JSONDecoder().decode(Request.self, from: try JSONSerialization.data(withJSONObject: request)))
            return String(data: out, encoding: .utf8) ?? ""
        }
        /// 画面座標の矩形を、そのフレームの画像ピクセルの矩形に直して送る。
        func apply(_ f: Frame, _ path: String, _ action: String, rect: CGRect, text: String? = nil, op: String = "apply",
                   key: String? = nil) async throws -> String {
            let sx = Double(f.width) / f.bounds.width, sy = Double(f.height) / f.bounds.height
            var a: [String: Any] = ["action": action, "frameId": f.id, "confidence": 1,
                "risk": action == "click" ? "navigation" : "draft", "expectation": "native input regression",
                "target": [(rect.minX - f.bounds.x) * sx, (rect.minY - f.bounds.y) * sy,
                           (rect.maxX - f.bounds.x) * sx, (rect.maxY - f.bounds.y) * sy]]
            if let text { a["text"] = text }
            if let key { a["key"] = key; a["risk"] = "navigation" }
            let request: [String: Any] = ["op": op, "action": a, "referencePath": path,
                "scope": try JSONSerialization.jsonObject(with: JSONEncoder().encode(f)),
                "authorizationExpiresAt": Date().timeIntervalSince1970 * 1000 + 60000]
            let out = try await BackgroundAX.respond(
                JSONDecoder().decode(Request.self, from: try JSONSerialization.data(withJSONObject: request)))
            return String(data: out, encoding: .utf8) ?? ""
        }
        /*
         * 対象の位置は fixture 自身が書く。AXPress を持たない面は **AX ツリーに現れない**
         * （実測: 素の NSView は要素として出ない）ので、AX で探す前提にはできない。
         */
        func element(_ which: String) throws -> CGRect {
            let r = try readback()
            switch which {
            case "native-plate": return r.plateRect.cg
            case "native-other": return r.otherRect.cg
            case "native-search": return r.searchRect.cg
            default: return r.fieldRect.cg
            }
        }

        var evidence: [String: Any] = [:]
        var lastCandidates: [Candidate] = []
        guard try readback().keyDowns == 0, try readback().text.isEmpty, try readback().plateClicks == 0,
              try readback().otherText.isEmpty
        else { throw Failure("fixture_not_clean") }
        evidence["startedClean"] = true

        // ① 文字キーは 1 度だけ届く。押下と解放が対応する。
        let (f1, p1) = try await frame()
        let typed = try await apply(f1, p1, "type_keys", rect: try element("native-field"), text: "kakiku")
        guard typed.contains("\"route\":\"native_key\"") else { throw Failure("wrong_route_for_keys") }
        try await Task.sleep(nanoseconds: 600_000_000)
        let afterKeys = try readback()
        guard afterKeys.keyDowns == 6, afterKeys.keyUps == 6 else { throw Failure("key_count_\(afterKeys.keyDowns)_\(afterKeys.keyUps)") }
        evidence["keyDowns"] = afterKeys.keyDowns
        evidence["keyUps"] = afterKeys.keyUps
        evidence["typedOnce"] = !afterKeys.text.contains("kk") && !afterKeys.text.isEmpty
        evidence["typedText"] = afterKeys.text
        /*
         * 鍵は窓の中の**焦点のある所**へ届く。fixture は別の欄に焦点を置いて始めるので、
         * 指した欄に入っていれば「送る前に焦点を移した」ことになる。
         * 移さなければ、ここが空でなくなる（実機でも、自動で焦点の当たる欄に助けられていた）。
         */
        guard afterKeys.otherText.isEmpty else { throw Failure("keys_went_to_focused_not_named") }
        evidence["keysFollowedTheNamedField"] = true

        /*
         * ⑤ Return は検索を走らせるときだけ。**ふつうの文字欄では押さない。**
         * いま焦点は ① で打った欄（ふつうの NSTextView）にある。ここで Return を頼んでも送らない。
         */
        let (fr1, pr1) = try await frame()
        let downsBefore = try readback().keyDowns
        var returnCode = ""
        do { returnCode = try await apply(fr1, pr1, "key", rect: try element("native-field"), key: "RETURN") }
        catch let error as Failure { returnCode = error.code }
        guard returnCode == "policy_return_not_search" else { throw Failure("return_outside_search_\(returnCode)") }
        try await Task.sleep(nanoseconds: 300_000_000)
        guard try readback().keyDowns == downsBefore, try readback().searchSubmits == 0
        else { throw Failure("return_sent_outside_search") }
        evidence["returnRefusedOutsideSearch"] = true
        // 検索欄に打ってから Return。検索が 1 回だけ走る。
        let (fr2, pr2) = try await frame()
        let typedSearch = try await apply(fr2, pr2, "type_keys", rect: try element("native-search"), text: "genie")
        guard typedSearch.contains("\"route\":\"native_key\"") else { throw Failure("search_not_typed_\(typedSearch)") }
        try await Task.sleep(nanoseconds: 400_000_000)
        let (fr3, pr3) = try await frame()
        let ranSearch = try await apply(fr3, pr3, "key", rect: try element("native-search"), key: "RETURN")
        guard ranSearch.contains("\"route\":\"native_key\"") else { throw Failure("return_in_search_\(ranSearch)") }
        try await Task.sleep(nanoseconds: 500_000_000)
        let searched = try readback()
        guard searched.searchSubmits == 1, searched.searchText == "genie"
        else { throw Failure("search_submits_\(searched.searchSubmits)_\(searched.searchText)") }
        evidence["returnRanSearchOnce"] = true

        // ② AXPress を持たない面は、座標を指定した背景マウスで押す。
        let (f2, p2) = try await frame()
        let clicked = try await apply(f2, p2, "click", rect: try element("native-plate"))
        guard clicked.contains("\"route\":\"native_mouse\"") else { throw Failure("wrong_route_for_plate") }
        try await Task.sleep(nanoseconds: 400_000_000)
        guard try readback().plateClicks == 1 else { throw Failure("plate_clicks_\(try readback().plateClicks)") }
        evidence["axlessClickDelivered"] = true

        /*
         * 配送途中の停止。許可の関門だけを試験で閉じ、実際の fixture の受信件数を読む。
         * hover 後の待ち時間で止まったクリックは押下しない。文字を一部送った場合は
         * 「全部送った」「何も送っていない」のどちらにもせず、再送禁止の結果を返す。
         */
        try BackgroundAX.privateFile(Data("acting".utf8), sessionPath + ".acting")
        let clickBeforeStop = try readback().plateClicks
        let plate = try element("native-plate")
        let clickPoint = CGPoint(x: plate.midX, y: plate.midY)
        var clickChecks = 0
        let stoppedClick = await NativeInput.click(pid: target.pid, window: target.windowId,
            screen: clickPoint,
            local: CGPoint(x: clickPoint.x - target.bounds.x, y: clickPoint.y - target.bounds.y),
            stillAllowed: {
                clickChecks += 1
                return clickChecks < 3 // hover の送信後、mouseDown の直前で停止。
            })
        guard case .notSent("session_stopped") = stoppedClick else { throw Failure("click_stop_not_reported") }
        try await Task.sleep(nanoseconds: 250_000_000)
        guard try readback().plateClicks == clickBeforeStop else { throw Failure("mouse_down_after_stop") }
        evidence["stopBetweenHoverAndMouseDownRefused"] = true

        var interruptedClickChecks = 0
        let interruptedClick = await NativeInput.click(pid: target.pid, window: target.windowId,
            screen: clickPoint,
            local: CGPoint(x: clickPoint.x - target.bounds.x, y: clickPoint.y - target.bounds.y),
            stillAllowed: {
                interruptedClickChecks += 1
                return interruptedClickChecks <= 3 // 押下の後に止まったクリックは再送できない。
            })
        guard case .interrupted = interruptedClick else { throw Failure("sent_click_reported_as_unsent") }
        try await Task.sleep(nanoseconds: 250_000_000)
        guard try readback().plateClicks == clickBeforeStop + 1 else { throw Failure("interrupted_click_not_delivered_once") }
        evidence["clickInterruptedAfterDispatchReportsUnknown"] = true

        let partialBefore = try readback()
        var keyChecks = 0
        let partialKeys = await NativeInput.keys([0, 1, 2], pid: target.pid, window: target.windowId,
            stillAllowed: {
                keyChecks += 1
                return keyChecks <= 2 // 1 打の押下・解放後に停止。後続の 2 打は配送しない。
            })
        guard case .interrupted = partialKeys else { throw Failure("partial_keys_reported_as_complete") }
        try await Task.sleep(nanoseconds: 250_000_000)
        let partialAfter = try readback()
        guard partialAfter.keyDowns == partialBefore.keyDowns + 1,
              partialAfter.keyUps == partialBefore.keyUps + 1 else { throw Failure("partial_keys_not_balanced") }
        evidence["partialKeysReportInterruption"] = true
        evidence["partialKeysReleasedWithoutSendingRemainder"] = true

        // 呼び出し元の取消も、関門が true のままでも入力を止める。
        let cancelledBefore = try readback()
        let cancelledKeys = Task { @MainActor in
            await NativeInput.keys([0], pid: target.pid, window: target.windowId, stillAllowed: { true })
        }
        cancelledKeys.cancel()
        guard case .notSent("session_stopped") = await cancelledKeys.value else {
            throw Failure("cancelled_keys_reported_as_sent")
        }
        try await Task.sleep(nanoseconds: 150_000_000)
        guard try readback().keyDowns == cancelledBefore.keyDowns else { throw Failure("key_after_task_cancel") }
        evidence["cancelledTaskSendsNoKeys"] = true
        try FileManager.default.removeItem(atPath: sessionPath + ".acting")

        // ③ 要素で指す経路。位置はモデルではなく製品が決める。
        let (f4, p4) = try await frame()
        guard !lastCandidates.isEmpty else { throw Failure("no_candidates_returned") }
        evidence["candidateCount"] = lastCandidates.count

        let buttonBefore = try readback().buttonClicks
        let pressed = try await applyElement(f4, p4, "click", id: try candidate("native-button"))
        guard pressed.contains("\"route\":\"ax_press\"") else { throw Failure("wrong_route_for_button") }
        try await Task.sleep(nanoseconds: 400_000_000)
        guard try readback().buttonClicks == buttonBefore + 1 else { throw Failure("button_not_pressed") }
        evidence["elementPressUsedAX"] = true

        // AXPress を持たない絵。枠は取れているので、座標を当てさせずに押せる。
        let (f5, p5) = try await frame()
        let pictureBefore = try readback().pictureClicks
        let picked = try await applyElement(f5, p5, "click", id: try candidate("native-picture"))
        guard picked.contains("\"route\":\"native_mouse\"") else { throw Failure("wrong_route_for_picture") }
        try await Task.sleep(nanoseconds: 400_000_000)
        guard try readback().pictureClicks == pictureBefore + 1 else { throw Failure("picture_not_clicked") }
        evidence["axlessElementClickedById"] = true

        // 知らない id は受け付けない。
        let (f6, p6) = try await frame()
        do { _ = try await applyElement(f6, p6, "click", id: "e999-999"); throw Failure("unknown_element_allowed") }
        catch let e as Failure where e.code == "background_target_unresolved" { evidence["unknownElementRefused"] = true }

        // 文字を入れられない役割へは書かない。
        let (f7, p7) = try await frame()
        do {
            _ = try await applyElement(f7, p7, "type", id: try candidate("native-picture"), text: "no")
            throw Failure("type_into_picture_allowed")
        } catch let e as Failure where e.code == "policy_action_not_allowed" { evidence["typeIntoNonTextRefused"] = true }

        /*
         * ⑤ 一度の許可が使い回せること。**毎回聞き直さないための保証。**
         * 生きている許可はそのまま返る。
         */
        guard let live = BackgroundAX.reusableGrant(root, recipient: "local") else { throw Failure("live_grant_not_reused") }
        guard live.0.pid == target.pid, live.0.windowId == target.windowId, live.1 == session
        else { throw Failure("reused_grant_mismatch") }
        evidence["liveGrantReused"] = true
        // A simulator's pinned target must not inherit another app/process's grant.
        func expected(_ expectedPID: Int32, _ expectedBundle: String) throws -> ExpectedTarget {
            let data = try JSONSerialization.data(withJSONObject:["pid":expectedPID,"bundleId":expectedBundle])
            return try JSONDecoder().decode(ExpectedTarget.self,from:data)
        }
        let exactTarget = try expected(target.pid, target.bundleId)
        let otherPID = try expected(target.pid == Int32.max ? target.pid - 1 : target.pid + 1, target.bundleId)
        let otherBundle = try expected(target.pid, "org.genie.other-test-target")
        guard BackgroundAX.reusableGrant(root, recipient:"local", expectedTarget:exactTarget)?.1 == session,
              BackgroundAX.reusableGrant(root, recipient:"local", expectedTarget:otherPID) == nil,
              BackgroundAX.reusableGrant(root, recipient:"local", expectedTarget:otherBundle) == nil
        else { throw Failure("constrained_grant_widened") }
        let narrowedRequest = try JSONDecoder().decode(Request.self, from:JSONSerialization.data(withJSONObject:[
            "op":"begin", "expectedTarget":["pid":target.pid,"bundleId":target.bundleId]]))
        guard narrowedRequest.expectedTarget?.matches(pid:target.pid,bundleId:target.bundleId) == true else {
            throw Failure("constraint_request_lost")
        }
        for bad: [String:Any] in [["pid":0,"bundleId":bundle], ["pid":pid,"bundleId":""], ["pid":pid], ["bundleId":bundle]] {
            do { _ = try JSONDecoder().decode(Request.self,from:JSONSerialization.data(withJSONObject:["op":"begin","expectedTarget":bad]));throw Failure("bad_constraint_allowed") }
            catch let e as Failure where e.code == "bad_constraint_allowed" { throw e }
            catch { }
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
        let ownedWindows = content.windows.filter { $0.owningApplication?.processID == pid }
        guard !ownedWindows.isEmpty else { throw Failure("constraint_fixture_not_visible") }
        // Use real SCWindow objects; the accessory must retain the constraint on
        // initial population and every refresh, even if a caller supplies a broad list.
        let consent = BackgroundAX.ConsentAccessoryView(goal:"Safari",initialWindows:content.windows,alert:NSAlert(),expectedTarget:exactTarget)
        defer { consent.cleanUp() }
        guard consent.currentWindows.count == ownedWindows.count,
              consent.currentWindows.allSatisfy({ $0.owningApplication?.processID == pid && $0.owningApplication?.bundleIdentifier == bundle }),
              consent.launchBtn.isHidden else { throw Failure("constrained_consent_initial_widened") }
        consent.updateWindows(content.windows)
        guard consent.currentWindows.count == ownedWindows.count else { throw Failure("constrained_consent_refresh_widened") }
        let excludedConsent = BackgroundAX.ConsentAccessoryView(goal:"",initialWindows:content.windows,alert:NSAlert(),expectedTarget:otherBundle)
        defer { excludedConsent.cleanUp() }
        guard excludedConsent.currentWindows.isEmpty,
              BackgroundAX.selectableWindows(content,expectedTarget:otherBundle).isEmpty,
              BackgroundAX.selectableWindows(content,expectedTarget:exactTarget).allSatisfy({ $0.owningApplication?.processID == pid && $0.owningApplication?.bundleIdentifier == bundle })
        else { throw Failure("constrained_candidates_widened") }
        evidence["consentTargetConstraintPreserved"] = true
        evidence["otherTargetGrantNotReused"] = true
        /*
         * 画像の送信先が変わったら使い回さない。選択画面で見せた送信先と違う所へ、
         * 新しい送信先を一度も見せないまま画像を送ることになる。分からない送信先も同じ。
         */
        guard BackgroundAX.reusableGrant(root, recipient: "openai") == nil,
              BackgroundAX.reusableGrant(root, recipient: nil) == nil
        else { throw Failure("grant_reused_for_new_recipient") }
        evidence["grantNotReusedForNewRecipient"] = true
        /*
         * 残りが 1 回ぶんに足りない許可は使い回さない。**途中で切れる方が悪い。**
         * 実測: 残り 95 秒の許可を引き継ぎ、モデルの返事に 119 秒かかって、
         * 送る直前に許可が消えた。訊き直していれば通っていた。
         */
        let shortPath = try BackgroundAX.sessionPath(root, UUID().uuidString.lowercased())
        let shortGrant = BackgroundAX.Grant(pid: target.pid, window: target.windowId, bundle: target.bundleId,
                                            generation: grant.generation,
                                            expires: Date().timeIntervalSince1970 + 95, recipient: "local")
        try BackgroundAX.privateFile(JSONEncoder().encode(shortGrant), shortPath)
        try BackgroundAX.watch(shortPath)
        defer { try? FileManager.default.removeItem(atPath: shortPath) }
        guard BackgroundAX.reusableGrant(root, recipient: "local")?.1 == session else { throw Failure("expiring_grant_reused") }
        evidence["expiringGrantNotReused"] = true

        /*
         * 鍵の行き先。**窓を選べないのに選んだつもりで送らない。**
         * 実測（Chrome 153 / macOS 26.6.2）: `focusWithoutRaise` は true を返しながら
         * 同じアプリの別の窓へは切り替わらず、打った文字が別の窓へ落ちていた。
         * ここでは 2 つ目の窓を鍵の受け手にしてから、許可された窓へ打とうとする。
         * 送らずに断ること、そして**どちらの窓にも文字が増えていないこと**を見る。
         */
        try Data().write(to: URL(fileURLWithPath: readbackPath + ".focus-second"))
        defer { try? FileManager.default.removeItem(atPath: readbackPath + ".focus-second") }
        try await Task.sleep(nanoseconds: 500_000_000)
        let beforeKeys = try readback()
        let (f8, p8) = try await frame()
        do {
            _ = try await apply(f8, p8, "type_keys", rect: try element("native-field"), text: "lost")
            throw Failure("keys_sent_to_wrong_window")
        } catch let e as Failure where e.code == "background_key_window_not_focused" {
            evidence["keysRefusedWhenAnotherWindowHasFocus"] = true
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        let afterRefusal = try readback()
        guard afterRefusal.text == beforeKeys.text, afterRefusal.otherText == beforeKeys.otherText,
              afterRefusal.keyDowns == beforeKeys.keyDowns
        else { throw Failure("keys_leaked_on_refusal") }
        evidence["nothingTypedOnRefusal"] = true
        // 打った結果が頼んだ文字であることまで見る。fixture は素直に受け取るので、確認済みになる。
        guard typed.contains("\"effect\":\"confirmed\"") else { throw Failure("keys_effect_not_confirmed") }
        evidence["keysConfirmedLiterally"] = true

        /*
         * 依頼の終了（op: end）を経ても、許可は残ること。
         * ここが消えていたせいで、続けて頼むたびに選択画面が出ていた。
         */
        let endRequest: [String: Any] = ["op": "end", "referencePath": p4,
            "scope": try JSONSerialization.jsonObject(with: JSONEncoder().encode(f4))]
        _ = try await BackgroundAX.respond(
            JSONDecoder().decode(Request.self, from: try JSONSerialization.data(withJSONObject: endRequest)))
        guard BackgroundAX.reusableGrant(root, recipient: "local") != nil else { throw Failure("grant_lost_on_run_end") }
        evidence["grantSurvivesRunEnd"] = true

        // ④ 入力の途中で止める。鍵を残さない。
        let (f3, p3) = try await frame()
        let before = try readback()
        try BackgroundAX.privateFile(Data("session_stopped".utf8), sessionPath + ".interrupted")
        do {
            _ = try await apply(f3, p3, "type_keys", rect: try element("native-field"), text: "stopped")
            throw Failure("stopped_session_accepted")
        } catch let e as Failure where e.code == "session_stopped" { evidence["stoppedSessionRefused"] = true }
        try await Task.sleep(nanoseconds: 300_000_000)
        let after = try readback()
        guard after.keyDowns == before.keyDowns, after.keyUps == before.keyUps else { throw Failure("input_after_stop") }
        guard after.keyDowns == after.keyUps else { throw Failure("key_left_pressed") }
        evidence["noInputAfterStop"] = true
        evidence["pressReleaseBalanced"] = true
        // 停止した許可は、期限が残っていても使い回さない。次は必ず聞き直す。
        evidence["stoppedGrantNotReused"] = BackgroundAX.reusableGrant(root, recipient: "local") == nil

        /*
         * ⑥ 小さな対象でも札が出ること。
         * 以前は窓＝対象の枠だったので、寿司の絵ほどの対象では札が枠に入らず
         * `drawBadge` の guard で**黙って消えていた**。操作中の相手が分からなくなる。
         * 対象の大きさに関わらず、札の文字が出ていることを画素で確かめる。
         */
        let anchor = try element("native-plate")
        let tiny = CGRect(x: anchor.minX, y: anchor.minY, width: 40, height: 40)
        guard let badged = Marker.show(around: tiny, window: target.windowId, target: "Genie Native Fixture"),
              let ring = badged.contentView as? Marker.Ring else { throw Failure("marker_not_shown") }
        defer { badged.orderOut(NSApp) }
        guard ring.badge.width > 40, ring.badge.height > 10,
              badged.frame.width >= ring.badge.width,
              NSRect(origin: .zero, size: badged.frame.size).contains(ring.badge) else { throw Failure("badge_clipped") }
        guard ring.label.contains("Genie Native Fixture") else { throw Failure("badge_label_missing") }
        guard let bitmap = ring.bitmapImageRepForCachingDisplay(in: ring.bounds) else { throw Failure("badge_not_drawn") }
        ring.cacheDisplay(in: ring.bounds, to: bitmap)
        var inked = 0
        for x in stride(from: Int(ring.badge.minX) + 4, to: Int(ring.badge.maxX) - 4, by: 2) {
            for y in stride(from: Int(ring.badge.minY) + 4, to: Int(ring.badge.maxY) - 4, by: 2) {
                // ビューは下が 0、ビットマップは上が 0。
                let row = Int(ring.bounds.height) - 1 - y
                if let c = bitmap.colorAt(x: x, y: row), c.alphaComponent > 0.5 { inked += 1 }
            }
        }
        evidence["badgeDrawnOnSmallTarget"] = inked > 40
        guard inked > 40 else { throw Failure("badge_blank") }

        // ⑦ 人の側を乱していないこと。
        evidence["frontmostUnchanged"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == front
        evidence["cursorUnchanged"] = CGEvent(source: nil)!.location == cursor
        /*
         * 修飾キーを**こちらが残していない**こと。絶対値が 0 かではなく、始まりと同じか。
         * 実機では人が Option を押したままのことがあり（IME でも起きる）、
         * 0 を期待すると、こちらの落ち度でないものを落ちたことにしてしまう。
         * こちらは修飾キーを一度も押さない（送る事象の flags は必ず空にしている）。
         */
        let flagsAfter = CGEventSource.flagsState(.combinedSessionState).rawValue & 0xFFFF0000
        evidence["noModifierResidue"] = flagsAfter == flagsBefore
        if flagsBefore != 0 { evidence["modifierHeldByHuman"] = true }
        /*
         * ⑧ 実行世代。**人が割り込んだら、それ以前の判断は送れない。**
         *
         * モデルは 1 回の判断に数秒から数十秒かかる。その間に人が対象を触れば、
         * 返ってきた操作は既に存在しない画面に向けたものになる。ここで見るのは、
         * 世代が進んだあとに古い写真で送ろうとしても**入力が 1 つも出ない**こと。
         * 走行中の許可を汚さないよう、この節は自前のセッションで行う。
         */
        let sessionGen = UUID().uuidString.lowercased()
        let pathGen = try BackgroundAX.sessionPath(root, sessionGen)
        try BackgroundAX.privateFile(JSONEncoder().encode(grant), pathGen)
        try BackgroundAX.watch(pathGen)
        // 見張りの鼓動が立つまで待つ。立つ前の apply は monitor 不在として断られる。
        for _ in 0..<40 where !FileManager.default.fileExists(atPath: pathGen + ".watching") {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        evidence["epochStartsAtZero"] = BackgroundAX.epoch(pathGen) == 0
        let (fGen, pGen) = try await frame(sessionGen)
        // 撮った写真は、そのときの世代を持って返る。
        evidence["frameCarriesEpoch"] = (fGen.backgroundEpoch ?? -1) == 0
        guard (fGen.backgroundEpoch ?? -1) == 0 else { throw Failure("frame_without_epoch") }

        // 人が割り込んだことにして世代を進める（見張りが割り込みで行うのと同じ操作）。
        try BackgroundAX.advanceEpoch(pathGen)
        try BackgroundAX.privateFile(Data("human_takeover:pointer-over-target".utf8), pathGen + ".interrupted")
        BackgroundAX.markHumanInput(pathGen)
        let beforeStale = try readback()
        var staleCode = ""
        do { _ = try await apply(fGen, pGen, "type_keys", rect: try element("native-field"), text: "zzz") }
        catch let error as Failure { staleCode = error.code }
        try await Task.sleep(nanoseconds: 300_000_000)
        let afterStale = try readback()
        // 割り込みが先に見えるので human_takeover、見えなくなっても stale_generation。
        // **どちらでも「送っていない」ことが要件**なので、そこを見る。
        evidence["staleGenerationRefused"] = ["human_takeover", "stale_generation"].contains(staleCode)
        evidence["nothingSentOnStaleGeneration"] =
            afterStale.keyDowns == beforeStale.keyDowns && afterStale.text == beforeStale.text
        guard ["human_takeover", "stale_generation"].contains(staleCode),
              afterStale.keyDowns == beforeStale.keyDowns, afterStale.text == beforeStale.text
        else { throw Failure("stale_generation_not_enforced_\(staleCode)") }

        func resume(_ f: Frame, _ path: String) async throws -> String {
            let request: [String: Any] = ["op": "resume", "referencePath": path,
                "scope": try JSONSerialization.jsonObject(with: JSONEncoder().encode(f))]
            let out = try await BackgroundAX.respond(
                JSONDecoder().decode(Request.self, from: try JSONSerialization.data(withJSONObject: request)))
            return String(data: out, encoding: .utf8) ?? ""
        }
        // 人の手がまだ動いているうちは再開しない。急かす操作も一切しない。
        var activeCode = ""
        do { _ = try await resume(fGen, pGen) } catch let error as Failure { activeCode = error.code }
        evidence["resumeWaitsWhileHumanActive"] = activeCode == "human_active"
        guard activeCode == "human_active" else { throw Failure("resumed_while_human_active_\(activeCode)") }
        evidence["interruptionKeptWhileWaiting"] = FileManager.default.fileExists(atPath: pathGen + ".interrupted")

        // 手が止まったら再開できる。**再開は必ず世代を進める**ので、古い写真は失効したまま。
        try await Task.sleep(nanoseconds: UInt64(BackgroundAX.quietPeriod * 1_000_000_000) + 300_000_000)
        let epochBeforeResume = BackgroundAX.epoch(pathGen)
        let resumed = try await resume(fGen, pGen)
        evidence["resumedAfterQuiet"] = resumed.contains("\"status\":\"resumed\"")
        evidence["resumeAdvancesEpoch"] = BackgroundAX.epoch(pathGen) > epochBeforeResume
        evidence["interruptionClearedOnResume"] = !FileManager.default.fileExists(atPath: pathGen + ".interrupted")
        guard resumed.contains("\"status\":\"resumed\""), BackgroundAX.epoch(pathGen) > epochBeforeResume,
              !FileManager.default.fileExists(atPath: pathGen + ".interrupted")
        else { throw Failure("resume_failed") }
        // 再開後も、古い世代の写真では送れない。
        var afterResumeCode = ""
        do { _ = try await apply(fGen, pGen, "type_keys", rect: try element("native-field"), text: "zzz") }
        catch let error as Failure { afterResumeCode = error.code }
        evidence["oldFrameStillRefusedAfterResume"] = afterResumeCode == "stale_generation"
        guard afterResumeCode == "stale_generation" else { throw Failure("old_frame_accepted_\(afterResumeCode)") }
        // The caller cannot relabel an old screenshot with the new live epoch.
        var forgedEpoch = fGen
        forgedEpoch.backgroundEpoch = BackgroundAX.epoch(pathGen)
        for op in ["apply", "preview_target"] {
            do {
                _ = try await apply(forgedEpoch, pGen, "type_keys", rect: try element("native-field"), text: "zzz", op: op)
                throw Failure("old_snapshot_relabelled_\(op)")
            } catch let error as Failure where error.code == "stale_frame" { }
        }
        evidence["oldSnapshotCannotRelabelEpoch"] = true
        // 撮り直せば、新しい世代の写真で続きができる。
        let (fGenB, _) = try await frame(sessionGen)
        evidence["freshFrameCarriesNewEpoch"] = (fGenB.backgroundEpoch ?? -1) == BackgroundAX.epoch(pathGen)

        // 明示的な取り下げは再開しない。割り込み（順番の交代）とは意味が違う。
        try BackgroundAX.privateFile(Data("session_stopped".utf8), pathGen + ".interrupted")
        var stoppedCode = ""
        do { _ = try await resume(fGenB, pGen) } catch let error as Failure { stoppedCode = error.code }
        evidence["explicitStopNotResumable"] = stoppedCode == "session_stopped"
        guard stoppedCode == "session_stopped" else { throw Failure("stopped_session_resumed_\(stoppedCode)") }

        evidence["status"] = "PASS"
        print(String(data: try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]),
                     encoding: .utf8)!)
    }
}
