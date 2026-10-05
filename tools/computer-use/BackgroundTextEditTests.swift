import Foundation

@main struct BackgroundTextEditTests {
    static func main() throws {
        var cases = 0
        func equal(_ actual: String, _ expected: String) { precondition(actual == expected); cases += 1 }
        func rejected(_ current: String, _ text: String, _ mode: String?, _ expected: BackgroundTextEdit.Rejected) {
            do { _ = try BackgroundTextEdit.value(current: current, text: text, mode: mode); preconditionFailure("unexpected acceptance") }
            catch let error as BackgroundTextEdit.Rejected { precondition(error == expected); cases += 1 }
            catch { preconditionFailure("wrong error") }
        }
        equal(try BackgroundTextEdit.value(current: "", text: "draft", mode: nil), "draft")
        equal(try BackgroundTextEdit.value(current: "既存\n🧑🏽‍💻", text: " + 追記", mode: "append"), "既存\n🧑🏽‍💻 + 追記")
        equal(try BackgroundTextEdit.value(current: "", text: "new", mode: "append"), "new")
        equal(try BackgroundTextEdit.value(current: String(repeating: "a", count: 19_999), text: "b", mode: "append"), String(repeating: "a", count: 19_999) + "b")
        rejected("keep", "new", nil, .notEmpty)
        rejected("keep", "new", "replace", .invalid)
        rejected("keep", "", "append", .invalid)
        rejected("keep", "\nsubmit", "append", .invalid)
        rejected("keep", "\u{7f}", "append", .invalid)
        rejected("", String(repeating: "🟦", count: 1001), "append", .invalid)
        rejected(String(repeating: "a", count: 20_000), "b", "append", .invalid)
        print("PASS: background text value policy \(cases) cases; no AppKit, capture, input or model")
    }
}
