import Foundation
import AppKit
import ScreenCaptureKit
import CoreGraphics

// This diagnostic does not instantiate NSApplication, request permission,
// activate applications, perform AX actions or create a capture stream/image.
// Enumeration APIs return system objects; only allowlisted numeric/boolean
// Safari fields below are read into the persisted report. No titles or URLs.
@main struct WindowMetadata {
    static func rect(_ value:CGRect) -> [String:Double] {
        ["x":value.minX,"y":value.minY,"width":value.width,"height":value.height]
    }
    static func emit(_ report:[String:Any]) throws {
        let data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    @MainActor static func main() async {
        var report:[String:Any]=[
            "recordedAt":ISO8601DateFormatter().string(from:Date()),
            "caller":"Separate read-only metadata CLI; not the signed production helper",
            "screenCapturePreflight":CGPreflightScreenCaptureAccess(),
            "scope":"Safari numeric and boolean metadata only; no title, URL, AX tree or image output"
        ]
        guard report["screenCapturePreflight"] as? Bool == true else {
            report["status"]="NOT_RUN"
            report["reason"]="existing_screen_permission_unavailable_no_request_made"
            try? emit(report);exit(2)
        }
        let apps=NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.apple.Safari" }
        let pids=Set(apps.map(\.processIdentifier))
        report["applications"]=apps.map { app in
            ["pid":Int(app.processIdentifier),"regular":app.activationPolicy == .regular,
             "hidden":app.isHidden,"active":app.isActive,"terminated":app.isTerminated] as [String:Any]
        }
        func cg(_ options:CGWindowListOption) -> [[String:Any]]? {
            guard let windows=CGWindowListCopyWindowInfo(options,kCGNullWindowID) as? [[String:Any]] else { return nil }
            return windows.compactMap { item in
                guard let pid=item[kCGWindowOwnerPID as String] as? Int32,pids.contains(pid),
                      let id=item[kCGWindowNumber as String] as? UInt32,
                      let layer=item[kCGWindowLayer as String] as? Int,
                      let bounds=item[kCGWindowBounds as String] as? [String:Double],
                      let x=bounds["X"],let y=bounds["Y"],let w=bounds["Width"],let h=bounds["Height"],
                      [x,y,w,h].allSatisfy(\.isFinite) else { return nil }
                return ["pid":Int(pid),"windowID":Int(id),"layer":layer,
                        "onScreen":item[kCGWindowIsOnscreen as String] as? Bool ?? false,
                        "frame":["x":x,"y":y,"width":w,"height":h]]
            }.sorted { ($0["windowID"] as! Int) < ($1["windowID"] as! Int) }
        }
        report["cgAll"]=cg([.optionAll,.excludeDesktopElements]) ?? NSNull()
        report["cgOnScreen"]=cg([.optionOnScreenOnly,.excludeDesktopElements]) ?? NSNull()
        if pids.isEmpty {
            report["scAll"]=[] as [[String:Any]]
            report["scOnScreen"]=[] as [[String:Any]]
            report["status"]="NO_SAFARI_PROCESS"
            try? emit(report);return
        }
        func sc(_ onScreen:Bool) async -> [String:Any] {
            do {
                let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:onScreen)
                let windows:[[String:Any]]=content.windows.compactMap { window in
                    guard let owner=window.owningApplication,pids.contains(owner.processID),
                          owner.bundleIdentifier == "com.apple.Safari" else { return nil }
                    return ["pid":Int(owner.processID),"windowID":Int(window.windowID),
                            "layer":window.windowLayer,"onScreen":window.isOnScreen,"frame":rect(window.frame)]
                }.sorted { ($0["windowID"] as! Int) < ($1["windowID"] as! Int) }
                return ["status":"OBSERVED","windows":windows]
            } catch { return ["status":"ERROR","errorCode":(error as NSError).code] }
        }
        report["scOnScreen"]=await sc(true)
        report["scAll"]=await sc(false)
        report["status"]="OBSERVED"
        report["completedAt"]=ISO8601DateFormatter().string(from:Date())
        try? emit(report)
    }
}
