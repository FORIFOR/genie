import Foundation
@main enum ReceiptCheck {
    static func main() throws {
        func payload(_ level:String="readback",_ route:String="api",_ evidence:String=String(repeating:"a",count:64)) -> String {
            let v:[String:Any] = ["version":1,"status":"verified","route":route,"level":level,"summary":"確認しました", "checkedAt":"2026-09-19T03:00:00.000Z", "evidence":evidence]
            return "<!--genie-execution:"+String(data:try! JSONSerialization.data(withJSONObject:v),encoding:.utf8)!+"-->\n\nextra prose"
        }
        precondition(ExecutionReceipt.parse(payload(),taskKind:"execution.run")?.label == "保存内容を照合済み")
        precondition(ExecutionReceipt.parse(payload("visual","vision"),taskKind:"execution.run")?.label == "画面表示を確認済み")
        precondition(ExecutionReceipt.parse(payload("field","accessibility"),taskKind:"execution.run")?.label == "入力欄を照合済み")
        precondition(ExecutionReceipt.parse(payload(),taskKind:"chat") == nil)
        precondition(ExecutionReceipt.parse(payload("readback","vision"),taskKind:"execution.run") == nil)
        precondition(ExecutionReceipt.parse(payload("readback","api","bad"),taskKind:"execution.run") == nil)
        precondition(ExecutionReceipt.parse("保存しました",taskKind:"execution.run") == nil)
        print("EXECUTION_RECEIPT_CHECKS_OK 7")
    }
}
