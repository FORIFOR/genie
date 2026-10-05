import Foundation

@main struct BackgroundScrollTests {
    static func main() throws {
        var count = 0
        func check(_ condition: Bool) { precondition(condition); count += 1 }
        func refused(_ value: Double, _ viewport: Double, _ content: Double, _ direction: String,
                     _ code: BackgroundScroll.Rejected) {
            do { _ = try BackgroundScroll.plan(value:value,viewport:viewport,content:content,direction:direction); preconditionFailure("accepted invalid scroll") }
            catch let error as BackgroundScroll.Rejected { precondition(error == code); count += 1 }
            catch { preconditionFailure("unexpected error") }
        }
        let down = try BackgroundScroll.plan(value:0,viewport:200,content:1200,direction:"down")
        check(down.after == 0.1 && down.delta == 100)
        let up = try BackgroundScroll.plan(value:0.04,viewport:200,content:1200,direction:"up")
        check(up.after == 0 && up.delta == -40)
        let end = try BackgroundScroll.plan(value:0.95,viewport:200,content:1200,direction:"down")
        check(end.after == 1 && abs(end.delta - 50) < 0.0001)
        check(BackgroundScroll.confirmed(down,value:0.1,documentDelta:100))
        check(!BackgroundScroll.confirmed(down,value:0.1,documentDelta:0))
        check(!BackgroundScroll.confirmed(down,value:0.1,documentDelta:-100))
        check(!BackgroundScroll.confirmed(down,value:0.3,documentDelta:100))
        check(!BackgroundScroll.confirmed(down,value:0.1,documentDelta:102))
        refused(0,200,1200,"up",.boundary)
        refused(1,200,1200,"down",.boundary)
        refused(.nan,200,1200,"down",.unsupported)
        refused(0,200,200,"down",.unsupported)
        refused(0,200,1200,"left",.unsupported)
        refused(-0.1,200,1200,"down",.unsupported)
        print("PASS BackgroundScroll: \(count) cases")
    }
}
