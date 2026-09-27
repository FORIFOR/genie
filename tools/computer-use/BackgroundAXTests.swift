// Test harness only; not linked into the production executable. Uses two disposable apps.
import AppKit
import Foundation
@main struct BackgroundTests {
    @MainActor static func main() {
        let app=NSApplication.shared;app.setActivationPolicy(.prohibited)
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
            return (try JSONDecoder().decode(Frame.self,from:result),output)
        }
        func apply(_ f:Frame,_ path:String,_ e:BackgroundAX.Element,_ action:String,_ text:String?=nil) async throws {
            let sx=Double(f.width)/f.bounds.width,sy=Double(f.height)/f.bounds.height
            var a:[String:Any]=["action":action,"frameId":f.id,"target":[e.x*sx,e.y*sy,(e.x+e.width)*sx,(e.y+e.height)*sy],"confidence":1,"risk":action == "type" ? "draft":"navigation","expectation":"fixture readback"]
            if let text { a["text"]=text }
            let data=try JSONSerialization.data(withJSONObject:["op":"apply","scope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(f)),"action":a,"referencePath":path,"authorizationExpiresAt":Date().timeIntervalSince1970*1000+30000])
            _=try await BackgroundAX.respond(JSONDecoder().decode(Request.self,from:data))
        }
        print("TEST capture")
        let (f,p)=try await frame()
        let snap=try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,p+".snapshot.json")
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
        // Test fixture activation simulates a human taking ownership; production never activates it.
        if passive {
            try BackgroundAX.privateFile(Data("human_takeover".utf8),path+".interrupted")
        } else { NSRunningApplication(processIdentifier:targetPID)!.activate(options:[]) }
        try await Task.sleep(nanoseconds:300_000_000)
        do { _=try await frame();throw Failure("takeover_allowed") }
        catch let e as Failure where e.code == "human_takeover" { }
        let evidence:[String:Any]=["status":"PASS","target":target,"sentinel":sentinel,"cursorUnchanged":true,"clipboardUnchanged":true,"foregroundUnchangedDuringActions":true,"replayRefused":true,"existingTextRefused":true,"keysRefused":true,"humanTakeoverRefused":true,"secureInputRefused":true,"indicatorShown":markerVisible,"indicatorInputTransparent":markerVisible,"inputSource":passive ? "none; passive preservation check only, no foreground typing test" : "automated foreground fixture; not human participant", "takeoverSource":passive ? "injected sticky marker" : "actual fixture activation"]
        let data=try JSONSerialization.data(withJSONObject:evidence,options:[.prettyPrinted,.sortedKeys])
        try data.write(to:root.appendingPathComponent("result.json"));print(String(data:data,encoding:.utf8)!)
    }
    static func json(_ url:URL) throws -> [String:Any] { try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any] }
}
