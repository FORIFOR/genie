// Dedicated native test target/sentinel. No network or user documents.
import AppKit
final class Fixture: NSObject, NSApplicationDelegate {
    var window:NSWindow!, editor:NSTextView!, label:NSTextField!
    var scrollView: NSScrollView?
    var retiredScrollers: [NSScroller] = []
    var clicks=0, activations=0
    var startupReady=false
    let env=ProcessInfo.processInfo.environment
    func applicationDidFinishLaunching(_ note:Notification) {
        let sentinel=env["GENIE_FIXTURE_ROLE"] == "sentinel"
        window=NSWindow(contentRect:NSRect(x:sentinel ? 500:180,y:210,width:580,height:410),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title=sentinel ? "Genie Human Input Sentinel":"Genie Background Target"
        if env["GENIE_FIXTURE_ALL_SPACES"] == "1" {
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        }
        let view=window.contentView!
        label=NSTextField(labelWithString:sentinel ? "Human input stays here":"Details closed")
        label.frame=NSRect(x:30,y:330,width:520,height:35);label.font = .systemFont(ofSize:22);view.addSubview(label)
        let button=NSButton(title:"Show details",target:self,action:#selector(showDetails))
        button.frame=NSRect(x:30,y:250,width:200,height:48);button.bezelStyle = .rounded;view.addSubview(button)
        let password=NSSecureTextField(frame:NSRect(x:280,y:260,width:220,height:28))
        password.placeholderString="Protected test field";password.setAccessibilityIdentifier("fixture-secret");view.addSubview(password)
        editor=NSTextView(frame:NSRect(x:30,y:50,width:520,height:170));editor.font = .systemFont(ofSize:20)
        editor.isRichText=false;editor.setAccessibilityIdentifier("fixture-editor");view.addSubview(editor)
        if env["GENIE_FIXTURE_SCROLL"] == "1" {
            editor.setFrameSize(NSSize(width:250,height:170))
            let scroll = NSScrollView(frame:NSRect(x:310,y:40,width:240,height:190))
            scroll.borderType = .noBorder; scroll.hasVerticalScroller = true
            scroll.hasHorizontalScroller = false; scroll.autohidesScrollers = false; scroll.scrollerStyle = .legacy
            scroll.setAccessibilityIdentifier("fixture-scroll")
            let document = NSTextView(frame:NSRect(x:0,y:0,width:220,height:2400))
            document.font = .systemFont(ofSize:18); document.isEditable = false; document.isSelectable = false
            document.isVerticallyResizable = false; document.isHorizontallyResizable = false
            document.string = (1...80).map { "Fixture catalog row \($0)" }.joined(separator:"\n")
            document.setAccessibilityIdentifier("fixture-scroll-document")
            scroll.documentView = document; view.addSubview(scroll); scrollView = scroll
        }
        if env["GENIE_FIXTURE_STAGE_ACCESSORY"] == "1" {
            // Smoke-only staging: place our own accessory window on the current
            // Space before becoming a regular selectable app. Never activate or
            // move another application, and let the smoke preflight verify it.
            window.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline:.now() + 0.2) {
                NSApp.setActivationPolicy(.regular)
                self.startupReady=true
                self.save()
            }
        } else if sentinel && env["GENIE_FIXTURE_PASSIVE"] != "1" {
            window.makeKeyAndOrderFront(nil);window.makeFirstResponder(editor)
            NSApp.activate()
        } else if env["GENIE_FIXTURE_ACTIVATE"] == "1" {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate()
        } else if env["GENIE_FIXTURE_ALL_SPACES"] == "1" { window.orderFrontRegardless() }
        else if env["GENIE_FIXTURE_PASSIVE"] == "1" { window.orderBack(nil) }
        else { window.orderFront(nil) }
        if env["GENIE_FIXTURE_STAGE_ACCESSORY"] != "1" { startupReady=true }
        Timer.scheduledTimer(withTimeInterval:0.05,repeats:true) { _ in self.save() }
    }
    func applicationDidBecomeActive(_ note:Notification) { activations += 1 }
    @objc func showDetails() { clicks += 1;label.stringValue="Details open";save() }
    func save() {
        guard let editor,let file=env["GENIE_FIXTURE_RESULT"] else { return }
        if let scroll=scrollView, env["GENIE_FIXTURE_ROLE"] == "target",
           FileManager.default.fileExists(atPath:file+".replace-scrollbar") {
            try? FileManager.default.removeItem(atPath:file+".replace-scrollbar")
            if let old=scroll.verticalScroller {
                let replacement=NSScroller(frame:old.frame)
                replacement.scrollerStyle = .legacy
                scroll.verticalScroller=replacement;scroll.tile();scroll.reflectScrolledClipView(scroll.contentView)
                // Keep the detached control alive so the helper must refuse its
                // stale AX identity, rather than merely depend on deallocation.
                retiredScrollers.append(old)
            }
        }
        func rect(_ value: NSRect) -> [String: Double] {
            ["x":value.minX,"y":value.minY,"width":value.width,"height":value.height]
        }
        var payload: [String: Any] = [
            "text":editor.string,"clicks":clicks,"activations":activations,
            "isVisible":window.isVisible,"isOnActiveSpace":window.isOnActiveSpace,
            "isActive":NSApp.isActive,"occlusionVisible":window.occlusionState.contains(.visible),
            "startupReady":startupReady,"activationPolicy":NSApp.activationPolicy() == .regular ? "regular":"accessory",
            "geometry":["coordinateSystem":"AppKit points, bottom-left origin",
                        "window":rect(window.frame),"screens":NSScreen.screens.map { rect($0.visibleFrame) }]
        ]
        if let scroll=scrollView {
            payload["scrollY"] = scroll.contentView.bounds.minY
            payload["scrollViewport"] = scroll.contentView.bounds.height
            payload["scrollValue"] = scroll.verticalScroller?.doubleValue ?? -1
            payload["scrollBarReplacements"] = retiredScrollers.count
        }
        let data=try! JSONSerialization.data(withJSONObject:payload)
        try? data.write(to:URL(fileURLWithPath:file),options:.atomic)
    }
}
let app=NSApplication.shared, delegate=Fixture()
app.delegate=delegate
let fixtureEnv=ProcessInfo.processInfo.environment
app.setActivationPolicy(fixtureEnv["GENIE_FIXTURE_PASSIVE"] == "1" || fixtureEnv["GENIE_FIXTURE_STAGE_ACCESSORY"] == "1" ? .accessory : .regular)
app.run()
