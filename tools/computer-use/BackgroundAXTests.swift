// Test harness only; not linked into the production executable. Uses two disposable apps.
import AppKit
import Foundation
@main struct BackgroundTests {
    @MainActor static func main() {
        let app=NSApplication.shared;app.setActivationPolicy(.accessory)
        Task { @MainActor in
            do { try await run();exit(0) }
            catch { print("FAIL \(error)");exit(1) }
        }
        app.run()
    }
    @MainActor static func run() async throws {
        guard #available(macOS 14.4,*) else { throw Failure("unsupported") }
        let args=CommandLine.arguments
        let targetPID=Int32(args[1])!, sentinelPID=Int32(args[2])!, root=URL(fileURLWithPath:args[3])
        let bundle="org.genie.background.target"
        let passive=ProcessInfo.processInfo.environment["GENIE_FIXTURE_PASSIVE"] == "1"
        let expectedFront=passive ? NSWorkspace.shared.frontmostApplication!.processIdentifier : sentinelPID
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == expectedFront else { throw Failure("sentinel_not_frontmost") }
        let windows=Helper.onScreenWindows(pid:targetPID)
        guard windows.count == 1 else { throw Failure("fixture_window_count") }
        let t=Target(bundleId:bundle,windowId:windows[0].0,pid:targetPID,bounds:windows[0].1)
        let session=UUID().uuidString.lowercased(), path=try BackgroundAX.sessionPath(root,session)
        // Adapter-level test authority, scoped only to this test-owned native app.
        let grant=BackgroundAX.Grant(pid:targetPID,window:t.windowId,bundle:bundle,generation:try BackgroundAX.generation(targetPID,bundle:bundle),expires:Date().timeIntervalSince1970+60)
        try BackgroundAX.privateFile(JSONEncoder().encode(grant),path)
        try BackgroundAX.watch(path)
        let pointBefore=CGEvent(source:nil)!.location, clipboard=NSPasteboard.general.changeCount
        let targetInitial=try json(root.appendingPathComponent("target.json")), sentinelInitial=try json(root.appendingPathComponent("sentinel.json"))
        func frame() async throws -> (Frame,String) {
            let id="cv-"+UUID().uuidString.lowercased(),output=root.appendingPathComponent("\(id).png").path
            var scope=Frame(id:id,bundleId:bundle,windowId:t.windowId,pid:targetPID,capturedAt:Date().timeIntervalSince1970*1000,width:580,height:432,bounds:t.bounds,sha256:"")
            scope.deliveryMode="background";scope.backgroundSession=session
            let data=try JSONSerialization.data(withJSONObject:["op":"capture","id":id,"outputPath":output,"scope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(scope))])
            let result=try await BackgroundAX.respond(JSONDecoder().decode(Request.self,from:data))
            let decoded=try JSONDecoder().decode(Frame.self,from:result)
            let saved=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,output+".snapshot.json")
            guard decoded.capturedAt == saved.frame.capturedAt else {
                print("DIAGNOSTIC capturedAt",decoded.capturedAt,saved.frame.capturedAt)
                throw Failure("fixture_capture_metadata_roundtrip")
            }
            return (decoded,output)
        }
        @discardableResult func apply(_ f:Frame,_ path:String,_ e:BackgroundAX.Element,_ action:String,_ text:String?=nil,mode:String?=nil,direction:String?=nil) async throws -> [String:Any] {
            let sx=Double(f.width)/f.bounds.width,sy=Double(f.height)/f.bounds.height
            var a:[String:Any]=["action":action,"frameId":f.id,"target":[e.x*sx,e.y*sy,(e.x+e.width)*sx,(e.y+e.height)*sy],"confidence":1,"risk":action == "type" ? "draft":"navigation","expectation":"fixture readback"]
            if let text { a["text"]=text }
            if let mode { a["textMode"]=mode }
            if let direction { a["direction"]=direction }
            let data=try JSONSerialization.data(withJSONObject:["op":"apply","scope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(f)),"action":a,"referencePath":path,"authorizationExpiresAt":Date().timeIntervalSince1970*1000+30000])
            return try JSONSerialization.jsonObject(with:await BackgroundAX.respond(JSONDecoder().decode(Request.self,from:data))) as! [String:Any]
        }
        func preview(_ f: Frame, _ reference: String, _ e: BackgroundAX.Element, byId: Bool = false,direction:String?=nil) async throws -> [String: Any] {
            let sx = Double(f.width) / f.bounds.width, sy = Double(f.height) / f.bounds.height
            var action: [String: Any] = ["action":"type", "frameId":f.id, "text":"fixture preview", "confidence":1,
                                         "risk":"draft", "expectation":"fixture readback"]
            if let direction { action["action"]="scroll";action["direction"]=direction;action["risk"]="navigation";action.removeValue(forKey:"text") }
            if byId { action["elementId"] = e.id }
            else { action["target"] = [e.x*sx,e.y*sy,(e.x+e.width)*sx,(e.y+e.height)*sy] }
            let id = "cv-" + UUID().uuidString.lowercased()
            let output = root.appendingPathComponent(id + ".png")
            let data = try JSONSerialization.data(withJSONObject: ["op":"preview_target", "id":id, "outputPath":output.path,
                "scope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(f)), "action":action,
                "referencePath":reference, "authorizationExpiresAt":Date().timeIntervalSince1970*1000+30000])
            let result = try await BackgroundAX.respond(JSONDecoder().decode(Request.self,from:data))
            let metadata = try JSONSerialization.jsonObject(with:result) as! [String:Any]
            let png = try Data(contentsOf:output)
            guard metadata["status"] as? String == "target_preview", metadata["id"] as? String == id,
                  metadata["sourceFrameId"] as? String == f.id, metadata["sourceSha256"] as? String == f.sha256,
                  metadata["elementId"] as? String == e.id, metadata["elementRole"] as? String == e.role,
                  metadata["sha256"] as? String == digest(png),
                  let image = NSBitmapImageRep(data:png), metadata["width"] as? Int == image.pixelsWide,
                  metadata["height"] as? Int == image.pixelsHigh,
                  !FileManager.default.fileExists(atPath:reference + ".used") else { throw Failure("preview_contract") }
            return metadata
        }
        print("TEST capture")
        let (f,p)=try await frame()
        let initialActivity = try BackgroundAX.readPrivate(BackgroundAX.Activity.self, path + ".activity")
        guard initialActivity.phase == "checking", initialActivity.expires > Date().timeIntervalSince1970 else {
            throw Failure("activity_missing_while_planning")
        }
        let display = BackgroundAX.ActivityView(path: path, grant: grant)
        display.refresh()
        guard display.phase == "checking", display.stopPanel?.isVisible == true,
              display.stopPanel?.canBecomeKey == false else { throw Failure("activity_not_visible") }
        try await Task.sleep(nanoseconds:150_000_000)
        let onScreen = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String:Any]] ?? []
        let shown = Set(onScreen.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue })
        guard let stop = display.stopPanel, shown.contains(stop.windowNumber),
              let pointer = NSApp.windows.first(where: { $0 is Marker.Panel }), shown.contains(pointer.windowNumber)
        else { throw Failure("activity_not_on_screen") }
        let snap=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,p+".snapshot.json")
        if ProcessInfo.processInfo.environment["GENIE_FIXTURE_SCROLL"] == "1" {
            func inspectScroll(_ e:AXUIElement,_ depth:Int=0) {
                guard depth < 15 else { return }
                if BackgroundAX.string(e,kAXRoleAttribute) == kAXScrollAreaRole {
                    print("DIAGNOSTIC scroll area",Helper.elementRect(e) as Any)
                    for key in [kAXContentsAttribute,kAXVerticalScrollBarAttribute,kAXWindowAttribute] {
                        print("DIAGNOSTIC",key,BackgroundAX.attribute(e,key) as Any)
                    }
                    for child in BackgroundAX.children(e) {
                        print("DIAGNOSTIC child",BackgroundAX.string(child,kAXRoleAttribute),Helper.elementRect(child) as Any)
                        for key in [kAXValueAttribute,kAXMinValueAttribute,kAXMaxValueAttribute,kAXOrientationAttribute,kAXEnabledAttribute] {
                            if BackgroundAX.string(child,kAXRoleAttribute) == kAXScrollBarRole { print("DIAGNOSTIC",key,BackgroundAX.attribute(child,key) as Any) }
                        }
                    }
                }
                for child in BackgroundAX.children(e) { inspectScroll(child,depth+1) }
            }
            inspectScroll(try BackgroundAX.window(t))
        }
        guard let button=snap.elements.first(where:{$0.role == kAXButtonRole && $0.title == "Show details"}) else { throw Failure("button_missing") }
        print("TEST click")
        try await apply(f,p,button,"click")
        let markerPoint=CGPoint(x:t.bounds.x+button.x+button.width/2,y:t.bounds.y+button.y+button.height/2)
        var markerVisible=false
        if let marker=BackgroundAX.indicator(at:markerPoint,window:t.windowId) {
            markerVisible=true
            /*
             * 印は対象が隠れていても出す（どこを触っているか分からなくなるため）。
             * 代わりに守るのは、**入力を横取りしないこと**と焦点を奪わないこと。
             * 覆われているかどうかは表示の形（compact）で変える。
             */
            guard !marker.canBecomeKey,!marker.canBecomeMain,marker.ignoresMouseEvents,marker.level.rawValue != 0 else { throw Failure("marker_interference") }
            if let view=marker.contentView,let bitmap=view.bitmapImageRepForCachingDisplay(in:view.bounds) {
                view.cacheDisplay(in:view.bounds,to:bitmap)
                try bitmap.representation(using:.png,properties:[:])?.write(to:root.appendingPathComponent("indicator.png"))
            }
            marker.orderOut(nil)
        } else if !passive { throw Failure("marker_not_visible") }
        do { try await apply(f,p,button,"click");throw Failure("replay_allowed") }
        catch let error as Failure where error.code == "background_file_exists" { }
        print("TEST capture for text")
        let (f2,p2)=try await frame(), snap2=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,p2+".snapshot.json")
        guard let field=snap2.elements.first(where:{$0.identifier == "fixture-editor"}) else { print(snap2.elements);throw Failure("field_missing") }
        guard let secret=BackgroundAX.children(try BackgroundAX.window(t)).first(where:{BackgroundAX.string($0,kAXSubroleAttribute)==kAXSecureTextFieldSubrole}),let secretRect=Helper.elementRect(secret) else { throw Failure("secure_fixture_missing") }
        let forbidden=BackgroundAX.Element(path:[],role:kAXTextFieldRole,subrole:kAXSecureTextFieldSubrole,identifier:"fixture-secret",title:"",valueHash:"",x:secretRect.minX-t.bounds.x,y:secretRect.minY-t.bounds.y,width:secretRect.width,height:secretRect.height,detail:"")
        let focusedBefore = BackgroundAX.attribute(AXUIElementCreateApplication(targetPID), kAXFocusedUIElementAttribute)
        let coordinatePreview = try await preview(f2, p2, field)
        let elementPreview = try await preview(f2, p2, field, byId:true)
        guard coordinatePreview["target"] as? [Double] == elementPreview["target"] as? [Double],
              try json(root.appendingPathComponent("target.json"))["text"] as? String == "",
              try json(root.appendingPathComponent("target.json"))["clicks"] as? Int == 1 else { throw Failure("preview_sent_input") }
        let focusedAfter = BackgroundAX.attribute(AXUIElementCreateApplication(targetPID), kAXFocusedUIElementAttribute)
        guard (focusedBefore == nil && focusedAfter == nil) || (focusedBefore != nil && focusedAfter != nil && CFEqual(focusedBefore!,focusedAfter!))
        else { throw Failure("preview_changed_focus") }
        do { _ = try await preview(f2,p2,forbidden);throw Failure("secure_preview_allowed") }
        catch let e as Failure where e.code == "policy_secure_field" { }
        do { _ = try await preview(f2,p2,button,byId:true);throw Failure("nontext_preview_allowed") }
        catch let e as Failure where e.code == "background_target_unresolved" { }
        do { try await apply(f2,p2,forbidden,"type","never");throw Failure("secure_input_allowed") }
        // 拒否の理由まで見る。「候補に無い」ではなく「禁じている」であること。
        catch let e as Failure where e.code == "policy_secure_field" { }
        let expected="背景入力 日本語 👩‍💻"
        // Foreground simulated human key events are TEST INPUT, never production adapter code.
        let typing=Task { @MainActor in
            if passive { return }
            for char in "human-input-continues" {
                let units=Array(String(char).utf16)
                for down in [true,false] {
                    let event=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:down)!
                    units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength:units.count,unicodeString:$0.baseAddress) }
                    event.postToPid(sentinelPID)
                }
                try? await Task.sleep(nanoseconds:25_000_000)
            }
        }
        print("TEST type")
        try await apply(f2,p2,field,"type",expected)
        await typing.value
        try await Task.sleep(nanoseconds:100_000_000)
        let target=try json(root.appendingPathComponent("target.json")),sentinel=try json(root.appendingPathComponent("sentinel.json"))
        guard target["clicks"] as? Int == 1,target["text"] as? String == expected else { throw Failure("target_readback") }
        guard sentinel["text"] as? String == (passive ? "" : "human-input-continues"),sentinel["clicks"] as? Int == 0 else { throw Failure("input_leaked") }
        guard target["activations"] as? Int == targetInitial["activations"] as? Int,
              sentinel["activations"] as? Int == sentinelInitial["activations"] as? Int,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == expectedFront,
              CGEvent(source:nil)!.location == pointBefore,NSPasteboard.general.changeCount == clipboard else { throw Failure("interference") }
        let (f3,p3)=try await frame(),s3=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,p3+".snapshot.json")
        let nonempty=s3.elements.first(where:{$0.identifier == "fixture-editor"})!
        do { try await apply(f3,p3,nonempty,"type","overwrite");throw Failure("overwrite_allowed") }
        // 既に中身のある欄 = 消して書くことになるので断る。文字が悪いのでも配送手段が無いのでもない。
        catch let e as Failure where e.code == "background_field_not_empty" { }
        do { try await apply(f3,p3,button,"key");throw Failure("keys_allowed") }
        // 名前の無いキーは受け付けない（ポリシー）。キー経路そのものの有無は
        // 対象と能力で決まるようになったので、一律拒否ではなくここで分かれる。
        catch let e as Failure where e.code == "policy_action_not_allowed" { }
        print("TEST append preserves existing native text")
        _ = try await preview(f3, p3, nonempty)
        try await apply(f3,p3,nonempty,"type"," + 追記",mode:"append")
        let appended = try json(root.appendingPathComponent("target.json"))
        guard appended["text"] as? String == expected + " + 追記",
              appended["clicks"] as? Int == 1,
              try json(root.appendingPathComponent("sentinel.json"))["text"] as? String == sentinel["text"] as? String,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == expectedFront,
              CGEvent(source:nil)!.location == pointBefore,NSPasteboard.general.changeCount == clipboard
        else { throw Failure("append_readback_or_interference") }
        do { try await apply(f3,p3,nonempty,"type"," duplicate",mode:"append");throw Failure("append_replay_allowed") }
        catch let e as Failure where e.code == "target_changed" || e.code == "background_file_exists" { }
        print("TEST append refuses a value changed after preview during marker travel")
        let (f4,p4)=try await frame(),s4=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,p4+".snapshot.json")
        let capturedField=s4.elements.first(where:{$0.identifier == "fixture-editor"})!
        _ = try await preview(f4,p4,capturedField)
        let raceField = try BackgroundAX.resolve(capturedField.path,in:t)
        let changedValue = "fixture concurrent edit preserved"
        let editDuringMarker = Task { @MainActor in
            try await Task.sleep(nanoseconds:150_000_000)
            guard AXUIElementSetAttributeValue(raceField,kAXValueAttribute as CFString,changedValue as CFString) == .success
            else { throw Failure("fixture_race_setup_failed") }
        }
        do { try await apply(f4,p4,capturedField,"type"," must not append",mode:"append");throw Failure("append_changed_value_allowed") }
        catch let e as Failure where e.code == "target_changed" { }
        try await editDuringMarker.value
        let raced = try json(root.appendingPathComponent("target.json"))
        guard raced["text"] as? String == changedValue else { throw Failure("append_overwrote_concurrent_edit") }
        var scrollEvidence: [String:Any]?
        if ProcessInfo.processInfo.environment["GENIE_FIXTURE_SCROLL"] == "1" {
            print("TEST background vertical scroll")
            let (sf,sp)=try await frame(), ss=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,sp+".snapshot.json")
            guard let area=ss.elements.first(where:{$0.identifier == "fixture-scroll"}),let state=area.scroll
            else { print(ss.elements);throw Failure("scroll_fixture_missing") }
            let before=try json(root.appendingPathComponent("target.json"))
            let sentinelBefore=try json(root.appendingPathComponent("sentinel.json"))
            do { _=try await preview(sf,sp,area,byId:true,direction:"up");throw Failure("scroll_boundary_allowed") }
            catch let error as Failure where error.code == "background_scroll_boundary" { }
            guard !FileManager.default.fileExists(atPath:sp+".used") else { throw Failure("boundary_marked_input") }
            _=try await preview(sf,sp,area,byId:true,direction:"down")
            let sent=try await apply(sf,sp,area,"scroll",direction:"down")
            let down=try json(root.appendingPathComponent("target.json"))
            guard sent["route"] as? String == "ax_scroll",sent["effect"] as? String == "confirmed",
                  let downY=down["scrollY"] as? Double, let beforeY=before["scrollY"] as? Double,
                  downY > beforeY,downY-beforeY <= state.viewport.height/2+1
            else { throw Failure("scroll_down_readback") }
            do { try await apply(sf,sp,area,"scroll",direction:"down");throw Failure("scroll_replay_allowed") }
            catch let error as Failure where error.code == "target_changed" || error.code == "background_file_exists" { }
            let (uf,up)=try await frame(),us=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,up+".snapshot.json")
            let upArea=us.elements.first(where:{$0.identifier == "fixture-scroll"})!
            _=try await preview(uf,up,upArea,byId:true,direction:"up")
            _=try await apply(uf,up,upArea,"scroll",direction:"up")
            guard abs((try json(root.appendingPathComponent("target.json"))["scrollY"] as! Double)-beforeY) <= 1
            else { throw Failure("scroll_up_readback") }
            let (rf,rp)=try await frame(),rs=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,rp+".snapshot.json")
            let raceArea=rs.elements.first(where:{$0.identifier == "fixture-scroll"})!
            _=try await preview(rf,rp,raceArea,byId:true,direction:"down")
            let nativeArea=try BackgroundAX.resolve(raceArea.path,in:t)
            let bar=BackgroundAX.children(nativeArea)[raceArea.scroll!.barIndex]
            let moveDuringMarker=Task { @MainActor in
                try await Task.sleep(nanoseconds:150_000_000)
                guard AXUIElementSetAttributeValue(bar,kAXValueAttribute as CFString,NSNumber(value:0.3)) == .success
                else { throw Failure("scroll_race_setup") }
            }
            do { try await apply(rf,rp,raceArea,"scroll",direction:"down");throw Failure("scroll_stale_position_allowed") }
            catch let error as Failure where error.code == "target_changed" { }
            try await moveDuringMarker.value
            let scrolled=try json(root.appendingPathComponent("target.json"))
            let sentinelAfter=try json(root.appendingPathComponent("sentinel.json"))
            guard abs((scrolled["scrollValue"] as! Double)-0.3) < 0.001,
                  scrolled["text"] as? String == changedValue,
                  sentinelAfter["scrollY"] as? Double == sentinelBefore["scrollY"] as? Double,
                  sentinelAfter["text"] as? String == sentinelBefore["text"] as? String,
                  sentinelAfter["clicks"] as? Int == sentinelBefore["clicks"] as? Int,
                  scrolled["activations"] as? Int == targetInitial["activations"] as? Int,
                  sentinelAfter["activations"] as? Int == sentinelInitial["activations"] as? Int,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier == expectedFront,
                  CGEvent(source:nil)!.location == pointBefore,NSPasteboard.general.changeCount == clipboard
            else { throw Failure("scroll_interference_or_race_overwrite") }
            // Observe the first actual dispatch, then alter only our fixture's
            // scrollbar before readback. A sent-but-unmatched effect is unknown.
            let (xf,xp)=try await frame(),xs=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,xp+".snapshot.json")
            let unknownArea=xs.elements.first(where:{$0.identifier == "fixture-scroll"})!
            let unknownNative=try BackgroundAX.resolve(unknownArea.path,in:t)
            let unknownBar=BackgroundAX.children(unknownNative)[unknownArea.scroll!.barIndex]
            let alterAfterDispatch=Task { @MainActor in
                for _ in 0..<200 {
                    let value=(BackgroundAX.attribute(unknownBar,kAXValueAttribute) as? NSNumber)?.doubleValue ?? -1
                    if abs(value-0.3) > 0.01 {
                        guard AXUIElementSetAttributeValue(unknownBar,kAXValueAttribute as CFString,NSNumber(value:0.6)) == .success
                        else { throw Failure("scroll_after_dispatch_setup") }
                        return
                    }
                    try await Task.sleep(nanoseconds:10_000_000)
                }
                throw Failure("scroll_dispatch_not_observed")
            }
            do { try await apply(xf,xp,unknownArea,"scroll",direction:"down");throw Failure("scroll_unmatched_effect_accepted") }
            catch let error as Failure where error.code == "input_effect_unconfirmed" { }
            try await alterAfterDispatch.value
            guard FileManager.default.fileExists(atPath:xp+".used") else { throw Failure("unknown_scroll_not_claimed") }
            let unknownReadback=try json(root.appendingPathComponent("target.json"))
            guard abs((unknownReadback["scrollValue"] as! Double)-0.6) < 0.001 else { throw Failure("unknown_scroll_resent") }
            let (bf,bp)=try await frame(),bs=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,bp+".snapshot.json")
            let replacementArea=bs.elements.first(where:{$0.identifier == "fixture-scroll"})!
            _=try await preview(bf,bp,replacementArea,byId:true,direction:"down")
            let oldArea=try BackgroundAX.resolve(replacementArea.path,in:t)
            let oldBar=BackgroundAX.children(oldArea)[replacementArea.scroll!.barIndex]
            let replaceDuringMarker=Task { @MainActor in
                try await Task.sleep(nanoseconds:150_000_000)
                try Data("fixture-only".utf8).write(to:root.appendingPathComponent("target.json.replace-scrollbar"))
            }
            do { try await apply(bf,bp,replacementArea,"scroll",direction:"down");throw Failure("scroll_replaced_bar_allowed") }
            catch let error as Failure where error.code == "target_changed" { }
            try await replaceDuringMarker.value
            let replaced=try json(root.appendingPathComponent("target.json"))
            let freshBar=BackgroundAX.children(oldArea)[replacementArea.scroll!.barIndex]
            guard !CFEqual(oldBar,freshBar),replaced["scrollBarReplacements"] as? Int == 1,
                  abs((replaced["scrollValue"] as! Double)-0.6) < 0.001
            else { throw Failure("scroll_bar_replacement_fixture") }
            scrollEvidence=["down":down,"receipt":sent,"final":scrolled,"sentinel":sentinelAfter,
                            "upReadback":true,"boundaryRefused":true,"replayRefused":true,"concurrentChangeRefused":true,
                            "postDispatchUnknown":true,"unknownReadback":unknownReadback,"replacedBarRefused":true,"replacement":replaced]
        }
        let oldActivity = try BackgroundAX.readPrivate(BackgroundAX.Activity.self, path + ".activity")
        unlink(path + ".activity")
        try BackgroundAX.privateFile(JSONEncoder().encode(BackgroundAX.Activity(
            phase: "checking", rect: oldActivity.rect, expires: Date().timeIntervalSince1970 - 1)), path + ".activity")
        display.refresh()
        guard display.stopPanel?.isVisible == false else { throw Failure("expired_display_visible") }
        do { try await apply(f3,p3,button,"click");throw Failure("input_after_display_expired") }
        catch let e as Failure where e.code == "session_stopped" { }
        guard try json(root.appendingPathComponent("target.json"))["clicks"] as? Int == 1 else {
            throw Failure("expired_run_sent_input")
        }
        // A fresh test-run display lease within fixture-scoped authority.
        try BackgroundAX.activity(path, target: t, phase: "checking", begin: true)
        // Test fixture activation simulates a human taking ownership; production never activates it.
        if passive {
            try BackgroundAX.privateFile(Data("human_takeover".utf8),path+".interrupted")
        } else { NSRunningApplication(processIdentifier:targetPID)!.activate(options:[]) }
        try await Task.sleep(nanoseconds:300_000_000)
        do { _=try await frame();throw Failure("takeover_allowed") }
        catch let e as Failure where e.code == "human_takeover" { }
        display.refresh()
        guard display.phase == "paused" else { throw Failure("pause_not_visible") }
        // Exercise the actual stop-button target. It revokes input rather than just hiding UI.
        display.stopButton?.performClick(nil)
        guard BackgroundAX.explicitlyStopped(path), display.phase == "stopped",
              display.stopButton?.isEnabled == false else { throw Failure("stop_did_not_revoke") }
        do { _=try await frame();throw Failure("explicit_stop_allowed") }
        catch let e as Failure where e.code == "session_stopped" { }
        let end = try JSONSerialization.data(withJSONObject: ["op":"end", "referencePath":p,
            "scope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(f))])
        _ = try await BackgroundAX.respond(JSONDecoder().decode(Request.self,from:end))
        display.refresh()
        guard !FileManager.default.fileExists(atPath: path + ".activity"),
              display.stopPanel?.isVisible == false else { throw Failure("activity_survived_end") }
        var evidence:[String:Any]=["status":"PASS","pointerAndStopOnScreen":true,"targetPreviewReadOnly":true,"targetPreviewCanonicalElement":true,"targetPreviewSecureRefused":true,"target":target,"sentinel":sentinel,"cursorUnchanged":true,"clipboardUnchanged":true,"foregroundUnchangedDuringActions":true,"replayRefused":true,"existingTextRefused":true,"appendPreserved":true,"appendReplayRefused":true,"appendConcurrentChangeRefused":true,"raced":raced,"appended":appended,"keysRefused":true,"humanTakeoverRefused":true,"secureInputRefused":true,"indicatorShown":markerVisible,"indicatorInputTransparent":markerVisible,"inputSource":passive ? "none; passive preservation check only, no foreground typing test" : "automated foreground fixture; not human participant", "takeoverSource":passive ? "injected sticky marker" : "actual fixture activation"]
        if let scrollEvidence { evidence["scroll"] = scrollEvidence }
        let data=try JSONSerialization.data(withJSONObject:evidence,options:[.prettyPrinted,.sortedKeys])
        try data.write(to:root.appendingPathComponent("result.json"));print(String(data:data,encoding:.utf8)!)
    }
    static func json(_ url:URL) throws -> [String:Any] { try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any] }
}
