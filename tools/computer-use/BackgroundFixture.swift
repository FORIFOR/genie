// Dedicated native test target/sentinel. No network or user documents.
import AppKit
final class Fixture: NSObject, NSApplicationDelegate {
    var window:NSWindow!, editor:NSTextView!, label:NSTextField!
    var clicks=0, activations=0
    let env=ProcessInfo.processInfo.environment
    func applicationDidFinishLaunching(_ note:Notification) {
        let sentinel=env["GENIE_FIXTURE_ROLE"] == "sentinel"
        window=NSWindow(contentRect:NSRect(x:sentinel ? 500:180,y:210,width:580,height:410),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title=sentinel ? "Genie Human Input Sentinel":"Genie Background Target"
        let view=window.contentView!
        label=NSTextField(labelWithString:sentinel ? "Human input stays here":"Details closed")
        label.frame=NSRect(x:30,y:330,width:520,height:35);label.font = .systemFont(ofSize:22);view.addSubview(label)
        let button=NSButton(title:"Show details",target:self,action:#selector(showDetails))
        button.frame=NSRect(x:30,y:250,width:200,height:48);button.bezelStyle = .rounded;view.addSubview(button)
        let password=NSSecureTextField(frame:NSRect(x:280,y:260,width:220,height:28))
        password.placeholderString="Protected test field";password.setAccessibilityIdentifier("fixture-secret");view.addSubview(password)
        editor=NSTextView(frame:NSRect(x:30,y:50,width:520,height:170));editor.font = .systemFont(ofSize:20)
        editor.isRichText=false;editor.setAccessibilityIdentifier("fixture-editor");view.addSubview(editor)
        if sentinel && env["GENIE_FIXTURE_PASSIVE"] != "1" {
            window.makeKeyAndOrderFront(nil);window.makeFirstResponder(editor)
            NSApp.activate(ignoringOtherApps:true)
        } else if env["GENIE_FIXTURE_PASSIVE"] == "1" { window.orderBack(nil) }
        else { window.orderFront(nil) }
        Timer.scheduledTimer(withTimeInterval:0.05,repeats:true) { _ in self.save() }
    }
    func applicationDidBecomeActive(_ note:Notification) { activations += 1 }
    @objc func showDetails() { clicks += 1;label.stringValue="Details open";save() }
    func save() {
        guard let editor,let file=env["GENIE_FIXTURE_RESULT"] else { return }
        let data=try! JSONSerialization.data(withJSONObject:["text":editor.string,"clicks":clicks,"activations":activations])
        try? data.write(to:URL(fileURLWithPath:file),options:.atomic)
    }
}
let app=NSApplication.shared, delegate=Fixture()
app.delegate=delegate;app.setActivationPolicy(ProcessInfo.processInfo.environment["GENIE_FIXTURE_PASSIVE"] == "1" ? .accessory : .regular);app.run()
