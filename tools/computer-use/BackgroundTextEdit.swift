import Foundation

/// Pure value construction. AX identity/value-hash checks remain at the native dispatch boundary.
enum BackgroundTextEdit {
    enum Rejected: String, Error {
        case invalid = "policy_text_rejected"
        case notEmpty = "background_field_not_empty"
    }
    static func value(current: String, text: String, mode: String?) throws -> String {
        guard mode == nil || mode == "append", !text.isEmpty, text.utf16.count <= 2000,
              text.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 })
        else { throw Rejected.invalid }
        if mode == nil {
            guard current.isEmpty else { throw Rejected.notEmpty }
            return text
        }
        guard current.utf16.count + text.utf16.count <= 20_000 else { throw Rejected.invalid }
        return current + text
    }
}
