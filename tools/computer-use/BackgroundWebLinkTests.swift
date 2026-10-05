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
        print("PASS BackgroundWebLink: \(count) cases")
    }
}
