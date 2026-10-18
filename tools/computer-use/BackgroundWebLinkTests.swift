import Foundation

@main struct BackgroundWebLinkTests {
    static func main() {
        var count=0
        func check(_ condition:Bool) { precondition(condition);count += 1 }
        func eligible(_ source:String,_ target:String)->Bool {
            BackgroundWebLink.eligible(document:URL(string:source)!,destination:URL(string:target)!)
        }
        check(BackgroundWebLink.enabled(bundle:"com.apple.Safari"))
        check(!BackgroundWebLink.enabled(bundle:"com.google.Chrome"))
        check(!BackgroundWebLink.enabled(bundle:"org.genie.background.webfixture"))
        check(eligible("https://www.example.com/first","https://www.example.com/second"))
        check(eligible("http://127.0.0.1:1234/first","http://127.0.0.1:1234/second"))
        check(eligible("https://example.com/first","https://example.com:443/second"))
        check(eligible("http://example.com:80/first","http://example.com/second"))
        check(eligible("https://EXAMPLE.com/first","https://example.com/second"))
        check(!eligible("https://example.com/first","https://example.com/first"))
        check(!eligible("https://example.com/first","https://other.example.com/second"))
        check(!eligible("http://127.0.0.1:1234/first","http://localhost:1234/second"))
        check(!eligible("http://example.com/first","https://example.com/second"))
        check(!eligible("https://example.com/first","https://example.com:444/second"))
        check(!eligible("https://user@example.com/first","https://example.com/second"))
        check(!eligible("https://example.com/first","https://user:secret@example.com/second"))
        check(!eligible("file:///first","file:///second"))
        check(!eligible("https://example.com/first","javascript:void(0)"))
        check(!eligible("https://example.com/first","https://example.com:0/second"))
        check(!eligible("https://example.com/first","https://example.com/"+String(repeating:"a",count:4096)))
        check(BackgroundDocumentOrigin.valid(["https://official.example"]))
        check(BackgroundDocumentOrigin.valid(["https://official.example", "https://cart.example:8443"]))
        for bad in [[], ["http://official.example"], ["https://official.example/"],
                    ["https://official.example:443"], ["https://user:secret@official.example"],
                    ["https://official.example?q=secret"], ["https://official.example#frame"],
                    ["https://*.example"], ["https://official.example", "https://official.example"]] {
            check(!BackgroundDocumentOrigin.valid(bad))
        }
        check(BackgroundDocumentOrigin.origin(URL(string:"https://official.example/path?private=hidden#fragment")!) == "https://official.example")
        check(BackgroundDocumentOrigin.origin(URL(string:"https://official.example.evil.test/")!) != "https://official.example")
        let source = URL(string:"https://official.example/cart")!
        check(BackgroundDocumentOrigin.singleDocument([source], hasEmbeddedFrame:false) == "https://official.example")
        check(BackgroundDocumentOrigin.singleDocument([], hasEmbeddedFrame:false) == nil)
        check(BackgroundDocumentOrigin.singleDocument([nil], hasEmbeddedFrame:false) == nil)
        check(BackgroundDocumentOrigin.singleDocument([source, source], hasEmbeddedFrame:false) == nil)
        check(BackgroundDocumentOrigin.singleDocument([source], hasEmbeddedFrame:true) == nil)
        check(BackgroundDocumentOrigin.singleDocument([URL(string:"about:blank")], hasEmbeddedFrame:false) == nil)
        check(BackgroundDocumentOrigin.singleDocument([URL(string:"data:text/html,opaque")], hasEmbeddedFrame:false) == nil)
        let allowed = ["https://official.example"]
        check(BackgroundDocumentOrigin.selectionAllowed(supportedBrowser:false, allowed:nil,
            observeOrigin: { preconditionFailure("generic app consent must not inspect origin") }))
        check(!BackgroundDocumentOrigin.selectionAllowed(supportedBrowser:false, allowed:allowed,
            observeOrigin: { preconditionFailure("unrelated app must be excluded before AX inspection") }))
        check(BackgroundDocumentOrigin.selectionAllowed(supportedBrowser:true, allowed:allowed,
            observeOrigin: { "https://official.example" }))
        check(!BackgroundDocumentOrigin.selectionAllowed(supportedBrowser:true, allowed:allowed,
            observeOrigin: { "https://unrelated.example" }))
        check(!BackgroundDocumentOrigin.selectionAllowed(supportedBrowser:true, allowed:allowed, observeOrigin: { nil }))
        check(!BackgroundDocumentOrigin.selectionAllowed(supportedBrowser:true, allowed:[],
            observeOrigin: { preconditionFailure("invalid constraint must never be widened") }))
        check(!BackgroundDocumentOrigin.selectionAllowed(supportedBrowser:true, allowed:allowed,
            observeOrigin: { throw NSError(domain:"fixture",code:1) }))
        let choices: [BackgroundDocumentOrigin.WindowCandidate] = [
            .init(pid: 20, window: 200, zOrder: 1), .init(pid: 10, window: 100, zOrder: 4)]
        check(BackgroundDocumentOrigin.preferredWindow(choices, foregroundPID: 10) == 100)
        check(BackgroundDocumentOrigin.preferredWindow(choices, foregroundPID: 99) == 200)
        check(BackgroundDocumentOrigin.preferredWindow([], foregroundPID: 10) == nil)
        check(BackgroundDocumentOrigin.preferredWindow([.init(pid: 0, window: 1, zOrder: 0)], foregroundPID: nil) == nil)
        check(BackgroundDocumentOrigin.preferredWindow([choices[0], choices[0]], foregroundPID: 20) == nil)
        let rect = CGRect(x: 0, y: 33, width: 1728, height: 1084)
        func matches(_ entries: [BackgroundWindowIdentity.Candidate], spi: Bool = true) -> Int? {
            BackgroundWindowIdentity.match(entries, pid: 10, window: 88, bounds: rect, identityAvailable: spi)
        }
        let exact = BackgroundWindowIdentity.Candidate(pid: 10, window: 88, bounds: rect)
        check(matches([exact]) == 0)
        check(matches([.init(pid: 10, window: 89, bounds: rect), exact]) == 1)
        check(matches([.init(pid: 10, window: 89, bounds: rect)]) == nil) // focused sibling with identical bounds
        check(matches([.init(pid: 10, window: nil, bounds: rect)]) == nil)
        check(matches([.init(pid: 11, window: 88, bounds: rect)]) == nil)
        check(matches([.init(pid: 10, window: 88, bounds: rect.offsetBy(dx: 1940, dy: 0))]) == nil)
        check(matches([exact, exact]) == nil)
        check(matches([.init(pid: 10, window: nil, bounds: rect)], spi: false) == 0)
        print("PASS BackgroundWebLink: \(count) cases")
    }
}
