// A disposable, nonpersistent WebKit target. Only its own loopback origin loads.
import AppKit
import WebKit
final class WebFixture: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window:NSWindow!, web:WKWebView!
    var activations=0, navigations=0, blockedNavigations=0
    let env=ProcessInfo.processInfo.environment
    func applicationDidFinishLaunching(_ notification:Notification) {
        let config=WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        window=NSWindow(contentRect:NSRect(x:180,y:210,width:620,height:440),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title="Genie Background Web Fixture"
        web=WKWebView(frame:window.contentView!.bounds,configuration:config)
        web.autoresizingMask=[.width,.height];web.navigationDelegate=self
        window.contentView!.addSubview(web);window.orderBack(nil)
        web.load(URLRequest(url:URL(string:env["GENIE_WEB_URL"]!)!))
        Timer.scheduledTimer(withTimeInterval:0.05,repeats:true) { _ in self.save() }
    }
    func applicationDidBecomeActive(_ notification:Notification) { activations += 1 }
    func webView(_ view:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {
        let base=URL(string:env["GENIE_WEB_URL"]!)!
        guard let url=action.request.url,url.scheme == base.scheme,url.host == base.host,url.port == base.port
        else { decisionHandler(.cancel);return }
        if url.path == "/blocked" { blockedNavigations += 1;save();decisionHandler(.cancel);return }
        decisionHandler(.allow)
    }
    func webView(_ view:WKWebView,didFinish navigation:WKNavigation!) { navigations += 1;save() }
    func save() {
        guard let web,let path=env["GENIE_WEB_RESULT"] else { return }
        let data=try! JSONSerialization.data(withJSONObject:["url":web.url?.absoluteString ?? "","title":web.title ?? "",
            "loading":web.isLoading,"navigations":navigations,"blockedNavigations":blockedNavigations,"activations":activations,"isActive":NSApp.isActive,
            "isVisible":window.isVisible,"isOnActiveSpace":window.isOnActiveSpace])
        try? data.write(to:URL(fileURLWithPath:path),options:.atomic)
    }
}
let app=NSApplication.shared,delegate=WebFixture()
app.delegate=delegate;app.setActivationPolicy(.accessory);app.run()
