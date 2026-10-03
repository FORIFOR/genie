//  背景ネイティブ入力の検証用 fixture。製品には同梱しない。
//  押下と解放を**別々に数える**。合計の文字だけ見ていると、二重配送や
//  押しっぱなしを見落とす。AXPress を持たない面も用意する（onclick だけの絵の代役）。
import AppKit

let env = ProcessInfo.processInfo.environment
let resultPath = env["NATIVE_RESULT"] ?? "/tmp/native.json"

final class Counting: NSWindow {
    var keyDowns = 0, keyUps = 0
    override var canBecomeKey: Bool { true }
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown { keyDowns += 1 }
        if event.type == .keyUp { keyUps += 1 }
        super.sendEvent(event)
    }
}
/// AX に AXImage として現れるが、押すための action は持たない面。
/// 寿司の絵と同じ状況——枠は取れるが AXPress は無い、を再現する。
final class Picture: NSImageView {
    var clicks = 0
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { clicks += 1 }
}
/// AXPress を持たない面。ボタンではないので AX の action には現れない。
final class Plate: NSView {
    var clicks = 0
    /*
     * 非アクティブなアプリへの最初のクリックは、これを返さない面では飲み込まれる。
     * Chrome の Web コンテンツは受けるので、寿司の絵は背景クリックで反応した。
     * 受けないネイティブの面は、背景では押せない——能力の境界として記録する。
     */
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { clicks += 1 }
    override func draw(_ r: NSRect) { NSColor.systemTeal.setFill(); r.fill() }
}

final class Delegate: NSObject, NSApplicationDelegate {
    @objc func pressed() { buttonClicks += 1; save() }
    /// 検索欄で Return が押されたら数える（検索を走らせた回数）。
    @objc func searched() { searchSubmits += 1; save() }
    var search: NSSearchField!
    var searchSubmits = 0
    var window: Counting!
    var plate: Plate!
    var field: NSTextView!
    /// 2 つ目の欄。**焦点のある所ではなく、指された所へ届く**ことを確かめるために要る。
    var other: NSTextView!
    /*
     * 2 つ目の窓。**鍵はプロセスにしか宛てられない**ので、
     * アプリがどの窓を鍵の受け手と見なすかで行き先が変わる。
     * 合図の file が現れたらこちらを鍵の窓にして、その状況を作る。
     */
    var second: NSWindow!
    var picture: Picture!
    var button: NSButton!
    var buttonClicks = 0
    func applicationDidFinishLaunching(_ n: Notification) {
        window = Counting(contentRect: NSRect(x: 1180, y: 120, width: 460, height: 340),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Genie Native Input Fixture"
        let view = window.contentView!
        plate = Plate(frame: NSRect(x: 40, y: 230, width: 180, height: 70))
        plate.setAccessibilityIdentifier("native-plate")
        view.addSubview(plate)
        button = NSButton(title: "Press target", target: self, action: #selector(pressed))
        button.frame = NSRect(x: 250, y: 230, width: 170, height: 40)
        button.setAccessibilityIdentifier("native-button")
        view.addSubview(button)
        search = NSSearchField(frame: NSRect(x: 250, y: 290, width: 170, height: 28))
        search.target = self
        search.action = #selector(searched)
        // 打つたびではなく、Return で 1 回だけ走らせる。
        search.sendsSearchStringImmediately = false
        search.sendsWholeSearchString = true
        search.setAccessibilityIdentifier("native-search")
        view.addSubview(search)
        picture = Picture(frame: NSRect(x: 250, y: 180, width: 120, height: 40))
        picture.image = NSImage(size: NSSize(width: 120, height: 40))
        picture.setAccessibilityIdentifier("native-picture")
        view.addSubview(picture)
        field = NSTextView(frame: NSRect(x: 40, y: 40, width: 380, height: 120))
        field.font = .systemFont(ofSize: 18)
        field.isRichText = false
        field.setAccessibilityIdentifier("native-field")
        view.addSubview(field)
        other = NSTextView(frame: NSRect(x: 40, y: 170, width: 180, height: 50))
        other.font = .systemFont(ofSize: 18)
        other.isRichText = false
        other.setAccessibilityIdentifier("native-other")
        view.addSubview(other)
        window.orderBack(nil)
        // 初めの焦点は 2 つ目の欄に置く。指定が効いていなければ、ここに文字が入る。
        window.makeFirstResponder(other)
        second = NSWindow(contentRect: NSRect(x: 1180, y: 520, width: 300, height: 160),
                          styleMask: [.titled], backing: .buffered, defer: false)
        second.title = "Genie Native Input Second"
        second.orderBack(nil)
        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
            self.save()
            // 合図があれば 2 つ目の窓を鍵の受け手にする（前面には出さない）。
            if FileManager.default.fileExists(atPath: resultPath + ".focus-second"),
               !self.second.isKeyWindow {
                self.second.makeKeyAndOrderFront(nil)
            }
        }
        print("LAUNCHED pid=\(getpid()) window=\(window.windowNumber) frame=\(NSStringFromRect(window.frame))")
        _ = button; _ = picture
        fflush(stdout)
    }
    /// 画面座標（Quartz、左上原点）に直した矩形。AX に現れない面もここで位置を伝える。
    func quartz(_ view: NSView) -> [String: Double] {
        let inWindow = view.convert(view.bounds, to: nil)
        let onScreen = window.convertToScreen(inWindow)
        let height = NSScreen.screens.first?.frame.maxY ?? 0
        return ["x": onScreen.minX, "y": height - onScreen.maxY,
                "width": onScreen.width, "height": onScreen.height]
    }
    func save() {
        let out: [String: Any] = ["plateClicks": plate.clicks, "keyDowns": window.keyDowns,
                                  "keyUps": window.keyUps, "text": field.string,
                                  "otherText": other.string, "otherRect": quartz(other),
                                  "plateRect": quartz(plate), "fieldRect": quartz(field),
                                  "buttonClicks": buttonClicks, "pictureClicks": picture.clicks,
                                  "searchSubmits": searchSubmits, "searchText": search.stringValue,
                                  "searchRect": quartz(search),
                                  "modifierFlags": NSEvent.modifierFlags.rawValue]
        if let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: resultPath), options: .atomic)
        }
    }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
