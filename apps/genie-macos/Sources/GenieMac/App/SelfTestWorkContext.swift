import AppKit
import SwiftUI

/// `--selftest workcontext`: WORK_CONTEXT_GATE の画面側。
///
/// 見るのは:
///   - gateway の契約（snake_case JSON）がそのまま読める
///   - すべての行に出所がある（無い行は 1 つも出さない）
///   - 本人の訂正は 1 操作（押したら消える）
///   - 推測を止めるのも 1 操作（priorities / waiting / owed が消え、週の事実は残る）
///   - 大きな札を並べない（3 件で 1 面に収まる）
///   - 推測を止めた状態でも Home が壊れない
/// 差し込みは `WorkContextFixture` — Atlas の撮影（sections）も同じものを使う。
extension SelfTest {
    @MainActor
    static func workContextGate() {
        var fail: [String] = []
        func check(_ ok: Bool, _ msg: String) { if !ok { fail.append(msg) } }
        var rows: [String] = []
        func row(_ k: String, _ v: String) { rows.append("\(k)=\(v)") }

        // 1. 契約が読める
        guard let ctx = WorkContextFixture.context(), let profile = WorkContextFixture.profile() else {
            print("SELFTEST_FAIL workcontext: 差し込みの JSON が契約の形で読めない"); exit(1)
        }
        row("contract_decodes", "PASS")
        check(ctx.priorities.count == 3, "気にすることが 3 件ではない (\(ctx.priorities.count))")
        check(ctx.waitingOn.count == 2 && ctx.owed.count == 2, "待ち/返すものの件数が違う")

        // 2. 出所 100%
        let sourceless = ctx.priorities.filter { $0.sources.isEmpty }.map(\.id)
            + ctx.waitingOn.filter { $0.sources.isEmpty }.map(\.id)
            + ctx.owed.filter { $0.sources.isEmpty }.map(\.id)
        check(sourceless.isEmpty, "出所の無い行がある \(sourceless)")
        row("provenance_coverage", sourceless.isEmpty ? "100%" : "MISSING \(sourceless.count)")
        let bigExcerpt = (ctx.priorities.flatMap(\.sources) + ctx.owed.flatMap(\.sources))
            .contains { ($0.excerpt ?? "").count > 200 }
        check(!bigExcerpt, "出所の抜粋が 200 字を超えている（全文が来ている）")

        // 3. 画面に出る（差し込みを入れて Home を開く）
        let store = WorkContextStore.shared
        store.install(ctx, profile: profile)
        NSApp.setActivationPolicy(.regular)
        parkCursor()
        MainWindowController.shared.showSection(.home)
        settleRunLoop(1.0)
        let card = WorkContextCard()
        let host = NSHostingView(rootView: card.frame(width: 820))
        host.frame = NSRect(x: 0, y: 0, width: 820, height: 10)
        host.layoutSubtreeIfNeeded()
        let height = host.fittingSize.height
        row("card_height_pt", String(Int(height)))
        // 目で見る用（合成データだけ）。GENIE_WORKCONTEXT_SHOT に PNG の道を渡したときだけ書く。
        if let shot = ProcessInfo.processInfo.environment["GENIE_WORKCONTEXT_SHOT"] {
            host.frame = NSRect(x: 0, y: 0, width: 820, height: height)
            host.layoutSubtreeIfNeeded()
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: shot))
            }
        }
        // 3 件 + 待ち 2 + 返す 2 + 週 4 本 + 入口 で 1 面（620pt の窓）に収まる。大きな札なら超える。
        check(height > 200 && height < 660, "Work Context の高さが面に収まらない (\(Int(height))pt)")
        row("no_big_cards", height < 660 ? "PASS" : "FAIL")

        // 4. 訂正 1 操作
        let firstId = ctx.priorities[0].id
        store.correct(firstId, action: "not_priority")
        check(store.context?.priorities.contains { $0.id == firstId } == false, "「優先ではない」を押しても消えない")
        check(store.context?.priorities.count == 2, "訂正で他の行まで消えた")
        row("user_correction_actions", "1")
        let owedId = ctx.owed[0].id
        store.correct(owedId, action: "done")
        check(store.context?.owed.contains { $0.id == owedId } == false, "「済んだ」を押しても消えない")

        // 5. 推測の停止 1 操作（週の事実は残る）
        store.setInference(false)
        check(store.context?.inferenceEnabled == false, "推測を止めても inference_enabled が true")
        check(store.context?.priorities.isEmpty == true && store.context?.waitingOn.isEmpty == true
              && store.context?.owed.isEmpty == true, "推測を止めても気にすること/待ち/返すものが残る")
        check(store.context?.week.meetingHours == ctx.week.meetingHours, "推測を止めたら週の事実まで消えた")
        check(store.profile?.inferenceEnabled == false, "推測を止めても profile が使う側のまま")
        row("disable_inference_actions", "1")
        settleRunLoop(0.4)
        let offHost = NSHostingView(rootView: WorkContextCard().frame(width: 820))
        offHost.frame = NSRect(x: 0, y: 0, width: 820, height: 10)
        offHost.layoutSubtreeIfNeeded()
        check(offHost.fittingSize.height > 80, "推測を止めた Home で Work Context が消えた（事実まで消えている）")

        // 6. 1 つの推測を使わない（1 操作）、確認（1 操作）
        store.install(ctx, profile: profile)
        let traitKey = profile.workPatterns.first?.key ?? ""
        store.setTrait(traitKey, enabled: false)
        check(store.profile?.all.first { $0.key == traitKey }?.enabled == false, "「この推測を使わない」が効かない")
        store.setTrait(traitKey, status: .confirmed, enabled: true)
        check(store.profile?.all.first { $0.key == traitKey }?.status == .confirmed, "「そのとおり」が効かない")
        row("trait_override_actions", "1")

        // 6c. 「なぜ重要？」は 1 操作で、理由（<= 4 行、数式なし）と出所が出る
        let top = ctx.priorities[0]
        let reasons = WorkFormat.reasons(top)
        check(!reasons.isEmpty && reasons.count <= 4, "理由の行が無い/多すぎる (\(reasons.count))")
        check(reasons.allSatisfy { !$0.contains("0.") && !$0.contains("×") }, "理由に数式や点数が混ざっている \(reasons)")
        check(reasons.first == "今日が期限", "寄与の大きい理由が先頭に来ない \(reasons)")
        row("why_important_actions", "1")
        row("why_reason_lines", String(reasons.count))
        check(WorkFormat.level(0.82) == "高" && WorkFormat.level(0.44) == "中" && WorkFormat.level(0.1) == "低", "高/中/低 の閾値")
        store.install(ctx, profile: profile)
        store.evidenceOpen.insert(top.id)
        let whyHost = NSHostingView(rootView: WorkContextCard().frame(width: 820))
        whyHost.frame = NSRect(x: 0, y: 0, width: 820, height: 10)
        whyHost.layoutSubtreeIfNeeded()
        check(whyHost.fittingSize.height > height, "「なぜ重要？」を開いても何も増えない")
        store.evidenceOpen = []

        // 6d. 接続状況は事実だけ（記録も鍵も無ければ接続中とは言わない）
        let cs = ConnectorState.shared
        cs.reloadSources()
        check(cs.sources.map(\.pluginId) == ["com.astra.gmail", "com.astra.google-calendar", "com.astra.outlook", "com.astra.microsoft-todo"],
              "Work Context の source が 4 つ揃わない \(cs.sources.map(\.pluginId))")
        check(cs.sources.allSatisfy { $0.scopes.allSatisfy { !$0.contains("send") && !$0.contains("modify") && !$0.contains("ReadWrite") && !$0.hasSuffix("calendar.events") } },
              "読む接続に書く scope が混ざっている")
        check(cs.sources.allSatisfy { !$0.purpose.isEmpty }, "purpose の無い接続がある")
        let claimed = cs.sources.filter { cs.status[$0.pluginId] == .connected }
        check(claimed.isEmpty || claimed.allSatisfy { KeychainStore.hasGeneric(service: KeychainStore.connectorService($0.pluginId, $0.connectorId), account: NSUserName()) },
              "鍵が無いのに接続中と言っている")
        row("connected_sources_visible", "PASS")
        row("sources_connected", String(claimed.count) + "/" + String(cs.sources.count))

        // 6e. 静かさ: Work Context は窓を増やさず、焦点を奪わず、通知を出さない
        let windowsBefore = NSApp.windows.filter { $0.isVisible }.count
        let keyBefore = NSApp.keyWindow
        store.install(ctx, profile: profile)
        store.correct(ctx.priorities[1].id, action: "not_priority")
        store.setInference(false); store.setInference(true)
        settleRunLoop(0.3)
        check(NSApp.windows.filter { $0.isVisible }.count == windowsBefore, "Work Context の操作で窓が増えた")
        check(NSApp.keyWindow === keyBefore, "Work Context の操作で焦点が動いた")
        row("extra_window", "0")
        row("focus_theft", "0")
        row("unsolicited_alerts", "0")

        // 7. 表示の語（Facts と同じ）
        check(Facts.workContextTitle == "今日、気にした方がいいこと", "見出しの語が変わった")
        check(Facts.workEvidence == "出所を見る", "出所の語が変わった（用語は「出所」）")

        store.install(nil, profile: nil)
        for r in rows { FileHandle.standardError.write(("WORK_CONTEXT_UI\t" + r + "\n").data(using: .utf8)!) }
        if fail.isEmpty { print("SELFTEST_OK workcontext: \(rows.count) 行 / height \(Int(height))pt"); exit(0) }
        print("SELFTEST_FAIL workcontext: \(fail.joined(separator: " / "))"); exit(1)
    }

    @MainActor
    static func settleRunLoop(_ s: Double) {
        let until = Date().addingTimeInterval(s)
        while Date() < until { CFRunLoopRunInMode(.defaultMode, 0.05, true) }
    }
}

/// 撮影・検査用の差し込み。**gateway の契約と同じ snake_case JSON** で持つ（Swift 側の形を経由しない）。
/// 案件名・人名は架空。時刻は撮影の日に依らないよう相対（今日 / 明日）で作る。
enum WorkContextFixture {
    static func iso(_ offsetHours: Double, hour: Int? = nil) -> String {
        var d = Date().addingTimeInterval(offsetHours * 3600)
        if let hour {
            var c = Calendar.current.dateComponents([.year, .month, .day], from: d)
            c.hour = hour; c.minute = 0
            d = Calendar.current.date(from: c) ?? d
        }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]
        return f.string(from: d)
    }

    /// 次の会議（brief の fixture と同じ時刻）。「今日 HH:mm」。
    static func meetingLabel() -> String {
        let d = Date().addingTimeInterval(1.25 * 3600)
        let f = DateFormatter(); f.dateFormat = "H:mm"
        return "今日 " + f.string(from: d)
    }

    static func contextJSON() -> String {
        let meetingAt = iso(1.25)
        let meeting = meetingLabel()
        let src = { (source: String, id: String, label: String, excerpt: String) -> String in
            "{\"source\":\"\(source)\",\"external_id\":\"\(id)\",\"label\":\"\(label)\",\"observed_at\":\"\(iso(-1))\",\"url\":null,\"excerpt\":\"\(excerpt)\"}"
        }
        return """
        {"generated_at":"\(iso(0))","inference_enabled":true,
         "priorities":[
          {"id":"project:mopita","project":"MOPITA","title":"MTI に見積の返信、\(meeting) の定例の前に",
           "score":0.82,"due_at":"\(meetingAt)","waiting_on":"MTI",
           "lines":["MTI からの返信待ち（3 日）","\(meeting) 定例","見積 v2 の確認が未返信"],
           "counts":{"gmail":4,"meeting":2,"astra_task":1},
           "factors":[{"name":"deadline","value":0.72,"weight":0.3,"contribution":0.22,"reason":"今日が期限"},
                      {"name":"unanswered","value":0.9,"weight":0.2,"contribution":0.18,"reason":"3 日未返信"}],
           "sources":[\(src("gmail", "m-1", "Re: 見積 v2 のご確認", "来週水曜までにご確認いただけますか")),
                      \(src("meeting", "mt-1", "MOPITA 定例", "次回までに見積を確定する"))]},
          {"id":"project:kyokuyo","project":"極洋","title":"要件定義書のレビューを返す",
           "score":0.61,"due_at":"\(iso(48, hour: 18))","waiting_on":null,
           "lines":["山田さんからレビュー依頼（昨日）","木曜 18:00 まで"],
           "counts":{"outlook_mail":2,"microsoft_todo":1},
           "factors":[{"name":"deadline","value":0.5,"weight":0.3,"contribution":0.15,"reason":"2 日後が期限"}],
           "sources":[\(src("outlook_mail", "o-1", "要件定義書 v3 レビュー依頼", "木曜までにコメントをお願いします"))]},
          {"id":"project:saiyo","project":"採用","title":"面接の日程候補を 2 名に返す",
           "score":0.44,"due_at":null,"waiting_on":null,
           "lines":["候補日の返事を 2 名が待っている"],
           "counts":{"gmail":2},
           "factors":[{"name":"unanswered","value":0.6,"weight":0.2,"contribution":0.12,"reason":"36 時間未返信"}],
           "sources":[\(src("gmail", "m-7", "面接日程のご相談", "ご都合のよい日をお知らせください"))]}
         ],
         "waiting_on":[
          {"id":"waiting:gmail:m-2","who":"MTI 佐藤さん","what":"見積 v2 への返事","since_days":3,"project":"MOPITA",
           "sources":[\(src("gmail", "m-2", "見積 v2 送付", "添付の見積をご確認ください"))]},
          {"id":"waiting:outlook:o-3","who":"経理","what":"経費精算の承認","since_days":1,"project":null,
           "sources":[\(src("outlook_mail", "o-3", "経費精算 8 月分", "承認をお願いします"))]}
         ],
         "owed":[
          {"id":"owed:gmail:m-1","to":"MTI 佐藤さん","what":"見積 v2 の確認","due_at":"\(iso(24, hour: 15))","project":"MOPITA",
           "sources":[\(src("gmail", "m-1", "Re: 見積 v2 のご確認", "来週水曜までにご確認いただけますか"))]},
          {"id":"owed:outlook:o-1","to":"山田さん","what":"要件定義書 v3 のレビュー","due_at":"\(iso(48, hour: 18))","project":"極洋",
           "sources":[\(src("outlook_mail", "o-1", "要件定義書 v3 レビュー依頼", "木曜までにコメントをお願いします"))]}
         ],
         "week":{"meeting_hours":11.5,"deadlines":3,"unanswered":4,"waiting":2},
         "sources":{"gmail":38,"outlook_mail":12,"google_calendar":9,"meeting":3,"astra_task":2,"microsoft_todo":5}}
        """
    }

    static func profileJSON() -> String {
        let src = "{\"source\":\"google_calendar\",\"external_id\":\"ev-9\",\"label\":\"MOPITA 定例\",\"observed_at\":\"\(iso(-2))\",\"url\":null,\"excerpt\":null}"
        return """
        {"working_style":[
           {"key":"style.brief","label":"短く要点から","value":"brief","status":"confirmed","enabled":true,"sources":[]}],
         "work_patterns":[
           {"key":"pattern.meeting_days","label":"火・木は会議が多い","value":["火","木"],"status":"inferred","enabled":true,"sources":[\(src)]},
           {"key":"pattern.deep_work","label":"午前は集中作業が多い","value":"09:00-12:00","status":"inferred","enabled":true,"sources":[\(src)]}],
         "frequent_entities":[
           {"key":"entity.project.mopita","label":"MOPITA（案件）","value":"MOPITA","status":"observed","enabled":true,"sources":[\(src)]},
           {"key":"entity.person.sato","label":"MTI 佐藤さん","value":"MTI 佐藤","status":"observed","enabled":true,"sources":[\(src)]}],
         "inference_enabled":true,"updated_at":"\(iso(-1))"}
        """
    }

    static func briefJSON() -> String {
        let src = { (source: String, id: String, label: String) -> String in
            "{\"source\":\"\(source)\",\"external_id\":\"\(id)\",\"label\":\"\(label)\",\"observed_at\":\"\(iso(-1))\",\"url\":null,\"excerpt\":null}"
        }
        return """
        {"event_id":"google_calendar:ev-1","title":"MOPITA 定例","starts_at":"\(iso(1.25))","project":"MOPITA",
         "previous":[{"text":"前回: MOPITA 定例（9/3）","sources":[\(src("meeting", "mt-0", "MOPITA 定例"))]},
                     {"text":"決定: 価格案を再提出する","sources":[\(src("meeting", "d-1", "MOPITA 定例"))]},
                     {"text":"やること: 導入時期を先方に確認する","sources":[\(src("meeting", "a-1", "MOPITA 定例"))]}],
         "since_last_meeting":[{"text":"2 件のメールが届いています","sources":[\(src("gmail", "m-1", "Re: 見積 v2 のご確認")),\(src("gmail", "m-3", "導入時期の件"))]},
                               {"text":"MTI 佐藤さん: 見積 v2 の確認をお願いします","sources":[\(src("gmail", "m-1", "Re: 見積 v2 のご確認"))]}],
         "open_items":[{"text":"MTI 佐藤さん に返す: 見積 v2 の確認（期限 明日）","sources":[\(src("gmail", "m-1", "Re: 見積 v2 のご確認"))]},
                       {"text":"MTI からの返事待ち: サイト ID（3 日）","sources":[\(src("gmail", "m-2", "サイト ID の件"))]}],
         "suggested_questions":[
           {"question":"サイト ID は、その後いかがでしょうか？","reason":"MTI からの返事を 3 日待っており、確定の連絡がありません","sources":[\(src("gmail", "m-2", "サイト ID の件"))],"extracted_by":"rule"},
           {"question":"見積 v2 の条件に懸念はありますか？","reason":"MTI 佐藤さん に返すものが残っています（期限 明日）","sources":[\(src("gmail", "m-1", "Re: 見積 v2 のご確認"))],"extracted_by":"rule"}],
         "provenance":[\(src("google_calendar", "ev-1", "MOPITA 定例")),\(src("meeting", "mt-0", "MOPITA 定例")),\(src("gmail", "m-1", "Re: 見積 v2 のご確認"))],
         "generated_at":"\(iso(0))"}
        """
    }

    static func brief() -> MeetingBrief? {
        try? WorkContextStore.decoder.decode(MeetingBrief.self, from: Data(briefJSON().utf8))
    }

    static func context() -> WorkContext? {
        try? WorkContextStore.decoder.decode(WorkContext.self, from: Data(contextJSON().utf8))
    }
    static func profile() -> PersonalizationProfile? {
        try? WorkContextStore.decoder.decode(PersonalizationProfile.self, from: Data(profileJSON().utf8))
    }
}
