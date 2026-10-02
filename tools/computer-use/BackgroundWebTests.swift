import AppKit
import Foundation
@main struct BackgroundWebTests {
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
        let args=CommandLine.arguments,pid=Int32(args[1])!,root=URL(fileURLWithPath:args[2]),source=URL(string:args[3])!
        let destination=source.deletingLastPathComponent().appendingPathComponent("second").absoluteString
        let blocked=source.deletingLastPathComponent().appendingPathComponent("blocked").absoluteString
        func json(_ name:String) throws -> [String:Any] { try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent(name))) as! [String:Any] }
        let front=NSWorkspace.shared.frontmostApplication?.processIdentifier,cursor=CGEvent(source:nil)!.location,clipboard=NSPasteboard.general.changeCount
        let before=try json("target.json"),sentinel=try json("sentinel.json")
        guard before["url"] as? String == source.absoluteString,before["loading"] as? Bool == false,
              before["isOnActiveSpace"] as? Bool == true else { throw Failure("web_fixture_not_ready") }
        let windows=Helper.onScreenWindows(pid:pid)
        guard windows.count == 1 else { throw Failure("fixture_window_count") }
        let target=Target(bundleId:"org.genie.background.webfixture",windowId:windows[0].0,pid:pid,bounds:windows[0].1)
        let session=UUID().uuidString.lowercased(),path=try BackgroundAX.sessionPath(root,session)
        let grant=BackgroundAX.Grant(pid:pid,window:target.windowId,bundle:target.bundleId,
            generation:try BackgroundAX.generation(pid,bundle:target.bundleId),expires:Date().timeIntervalSince1970+90)
        try BackgroundAX.privateFile(JSONEncoder().encode(grant),path);try BackgroundAX.watch(path)
        func frame() async throws -> (Frame,String,BackgroundAX.Snapshot) {
            let id="cv-"+UUID().uuidString.lowercased(),file=root.appendingPathComponent(id+".png").path
            var scope=Frame(id:id,bundleId:target.bundleId,windowId:target.windowId,pid:pid,capturedAt:Date().timeIntervalSince1970*1000,
                width:620,height:472,bounds:target.bounds,sha256:"")
            scope.deliveryMode="background";scope.backgroundSession=session
            let request=try JSONSerialization.data(withJSONObject:["op":"capture","scope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(scope)),"id":id,"outputPath":file])
            let result=try await BackgroundAX.respond(JSONDecoder().decode(Request.self,from:request))
            return (try JSONDecoder().decode(Frame.self,from:result),file,try BackgroundAX.readPrivate(BackgroundAX.Snapshot.self,file+".snapshot.json"))
        }
        func apply(_ frame:Frame,_ file:String,_ element:BackgroundAX.Element) async throws -> [String:Any] {
            let action:[String:Any]=["action":"click","elementId":element.id,"frameId":frame.id,"confidence":1,"risk":"navigation","expectation":"fixture details page"]
            let request=try JSONSerialization.data(withJSONObject:["op":"apply","scope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(frame)),"action":action,"referencePath":file,"authorizationExpiresAt":Date().timeIntervalSince1970*1000+30000])
            return try JSONSerialization.jsonObject(with:await BackgroundAX.respond(JSONDecoder().decode(Request.self,from:request))) as! [String:Any]
        }
        let (f,file,snapshot)=try await frame()
        let links=snapshot.elements.filter { $0.role == "AXLink" }
        guard links.contains(where:{$0.webLink?.destinationHash == digest(Data(destination.utf8))}),
              let blockedLink=links.first(where:{$0.webLink?.destinationHash == digest(Data(blocked.utf8))})
        else { print("DIAGNOSTIC links",links);throw Failure("web_link_missing") }
        let forbidden=try links.filter { element in
            let native=try BackgroundAX.resolve(element.path,in:target)
            return BackgroundAX.string(native,kAXTitleAttribute).contains("Forbidden") || element.webLink == nil
        }
        guard forbidden.count >= 2 else { throw Failure("web_negative_links_missing") }
        for link in forbidden {
            do { _=try await apply(f,file,link);throw Failure("forbidden_web_link_allowed") }
            catch let error as Failure where error.code == "background_link_unsupported" { }
        }
        guard !FileManager.default.fileExists(atPath:file+".used") else { throw Failure("refused_link_marked_input") }
        do { _=try await apply(f,file,blockedLink);throw Failure("blocked_navigation_confirmed") }
        catch let error as Failure where error.code == "input_effect_unconfirmed" { }
        guard FileManager.default.fileExists(atPath:file+".used"),
              try json("target.json")["blockedNavigations"] as? Int == 1 else { throw Failure("unknown_navigation_not_recorded") }
        do { _=try await apply(f,file,blockedLink);throw Failure("unknown_web_link_replayed") }
        catch let error as Failure where error.code == "target_changed" || error.code == "background_file_exists" { }
        guard try json("target.json")["blockedNavigations"] as? Int == 1 else { throw Failure("unknown_navigation_resent") }
        let (fresh,freshFile,freshSnapshot)=try await frame()
        guard let valid=freshSnapshot.elements.first(where:{$0.webLink?.destinationHash == digest(Data(destination.utf8))})
        else { throw Failure("fresh_web_link_missing") }
        let receipt=try await apply(fresh,freshFile,valid)
        guard receipt["route"] as? String == "ax_web_link",receipt["effect"] as? String == "confirmed"
        else { throw Failure("web_link_not_confirmed") }
        let (_,_,afterSnapshot)=try await frame()
        let after=try json("target.json"),sentinelAfter=try json("sentinel.json")
        guard after["url"] as? String == destination,after["title"] as? String == "Fixture details page",
              after["navigations"] as? Int == 2,after["activations"] as? Int == before["activations"] as? Int,
              sentinelAfter["text"] as? String == sentinel["text"] as? String,
              sentinelAfter["clicks"] as? Int == sentinel["clicks"] as? Int,
              sentinelAfter["activations"] as? Int == sentinel["activations"] as? Int,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == front,
              CGEvent(source:nil)!.location == cursor,NSPasteboard.general.changeCount == clipboard
        else { throw Failure("web_navigation_or_preservation_failed") }
        do { _=try await apply(fresh,freshFile,valid);throw Failure("web_link_replay_allowed") }
        catch let error as Failure where error.code == "target_changed" || error.code == "background_file_exists" { }
        let requests=try json("requests.json")
        guard requests["/first"] as? Int == 1,requests["/second"] as? Int == 1 else { throw Failure("web_navigation_duplicated") }
        let result:[String:Any]=["status":"PASS","receipt":receipt,"before":before,"after":after,"sentinel":sentinelAfter,
            "requests":requests,"negativeLinksRefused":forbidden.count,"replayRefused":true,"unknownNavigationNeverResent":true,"foregroundUnchanged":true,
            "cursorUnchanged":true,"clipboardUnchanged":true,"afterFrameId":afterSnapshot.frame.id,
            "scope":"Owned WebKit fixture; test-created grant, not production Safari consent"]
        let data=try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys])
        try data.write(to:root.appendingPathComponent("result.json"));print(String(data:data,encoding:.utf8)!)
    }
}
