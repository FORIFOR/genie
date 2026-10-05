import AppKit
import SwiftUI

extension SelfTest {
    /// Real Metal rendering on an isolated fixture, plus native playback delegate validation.
    @MainActor static func liquidOrb(_ args: [String]) async {
        let i = args.firstIndex(of: "--selftest")!
        guard args.count > i + 2, let gpu = LiquidOrbGPU.shared else { print("SELFTEST_FAIL liquid-orb Metal unavailable"); exit(2) }
        let output = URL(fileURLWithPath: args[i+2]); try? FileManager.default.createDirectory(at: output,withIntermediateDirectories:true)
        var failures:[String]=[], geometry:[String:[String:Double]]=[:]
        NSApp.setActivationPolicy(.regular)
        for dark in [false,true] {
            let images = GenieOrbMode.allCases.compactMap { mode -> (GenieOrbMode,NSImage)? in
                guard let image = gpu.image(mode:mode) else {failures.append(mode.rawValue);return nil}
                if let data=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:data),let png=bitmap.representation(using:.png,properties:[:]) {
                    try? png.write(to:output.appendingPathComponent(mode.rawValue+".png"))
                }
                return(mode,image)
            }
            let root = VStack(alignment:.leading,spacing:24) {
                Text("Genie · Liquid Orb").font(.title2.weight(.semibold))
                Text("実際のMetalシェーダーで描画した状態見本").foregroundStyle(.secondary)
                HStack(spacing:24) {
                    ForEach(images,id:\.0.rawValue) { mode,image in
                        VStack(spacing:12) {
                            Image(nsImage:image).resizable().frame(width:112,height:112)
                            Text(mode.rawValue).font(.caption)
                            Image(nsImage:image).resizable().frame(width:36,height:36)
                        }
                    }
                }
                Text("上: 表現の確認用　下: Dockの実寸（36pt）").font(.caption).foregroundStyle(.secondary)
            }.padding(28).background(dark ? Color(red:0.07,green:0.08,blue:0.10) : Color(red:0.96,green:0.97,blue:0.98))
                .environment(\.colorScheme,dark ? .dark : .light)
            let host=NSHostingView(rootView:root)
            let size=host.fittingSize;host.frame=NSRect(origin:.zero,size:size)
            guard let rep=host.bitmapImageRepForCachingDisplay(in:host.bounds) else {failures.append("gallery");continue}
            host.cacheDisplay(in:host.bounds,to:rep)
            let name=dark ? "gallery-dark" : "gallery-light"
            if let png=rep.representation(using:.png,properties:[:]) {try? png.write(to:output.appendingPathComponent(name+".png"))}
            geometry[name] = ["width":size.width,"height":size.height,"dockOrb":Metrics.hudOrbSize]
        }
        // Exercise the actual display link as well as the deterministic images above.
        let view=LiquidOrbMetalView()
        let window=NSWindow(contentRect:NSRect(x:120,y:120,width:132,height:132),styleMask:[.titled],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        struct LiveSurface: NSViewRepresentable {
            let surface: LiquidOrbMetalView
            func makeNSView(context: Context) -> LiquidOrbMetalView { surface }
            func updateNSView(_ view: LiquidOrbMetalView, context: Context) {}
        }
        window.contentView=NSHostingView(rootView: VStack {
            Text("Genie · thinking")
            LiveSurface(surface:view).frame(width:132,height:132)
        }.padding(16).background(Color.gray))
        window.setContentSize(NSSize(width:164,height:190))
        view.configure(mode:.thinking,level:0,reduced:false)
        window.makeKeyAndOrderFront(nil);window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps:true)
        try? await Task.sleep(for:.milliseconds(800))
        print("ORB_DISPLAY visible=\(window.isVisible) occlusion=\(window.occlusionState.contains(.visible)) appHidden=\(NSApp.isHidden) viewHidden=\(view.isHiddenOrHasHiddenAncestor) paused=\(view.isPaused) size=\(view.drawableSize) frames=\(view.renderedFrames)")
        if view.renderedFrames == 0 || view.isPaused {failures.append("visible display link did not render")}
        view.configure(mode:.speaking,level:1,reduced:true)
        // 止めた直後は、すでに飛んでいる 1 枚が後から着く。それを数え始めに含めない。
        // （含めていたため、機械が混んでいるときだけ落ちていた。止まっているかは次の 200ms で見る）
        try? await Task.sleep(for:.milliseconds(120))
        let frozen=view.renderedFrames
        try? await Task.sleep(for:.milliseconds(200))
        if !view.isPaused || view.renderedFrames != frozen {failures.append("Reduce Motion kept rendering")}
        view.configure(mode:.thinking,level:0,reduced:false)
        window.orderOut(nil)
        let hidden=view.renderedFrames
        try? await Task.sleep(for:.milliseconds(200))
        if !view.isPaused || view.renderedFrames != hidden {failures.append("hidden window kept rendering")}
        window.orderFrontRegardless()
        try? await Task.sleep(for:.milliseconds(250))
        if view.isPaused || view.renderedFrames <= hidden {failures.append("reopened display link did not resume")}
        view.stop();window.close()
        if args.contains("--playback") {
            let output=GenieSpeechOutput.shared
            let id=UUID();output.read("Genieの音声出力を確認しています。",owner:id)
            var sawSpeaking=false
            for _ in 0..<100 {
                try? await Task.sleep(for:.milliseconds(100))
                if output.mode == .speaking {sawSpeaking=true}
                if sawSpeaking && output.mode == .idle {break}
            }
            if !sawSpeaking {failures.append("playback never started")}
            if output.mode != .idle {failures.append("playback did not finish")}
            output.read("停止ボタンで読み上げを止められます。",owner:id)
            try? await Task.sleep(for:.milliseconds(300));output.stop(owner:id)
            try? await Task.sleep(for:.milliseconds(100))
            if output.mode != .idle || output.owner != nil {failures.append("playback cancellation")}
        }
        if let data=try? JSONSerialization.data(withJSONObject:geometry,options:[.prettyPrinted,.sortedKeys]) {try? data.write(to:output.appendingPathComponent("geometry.json"))}
        print(failures.isEmpty ? "SELFTEST_OK liquid-orb: real Metal snapshots; playback=\(args.contains("--playback"))" : "SELFTEST_FAIL liquid-orb: \(failures)")
        exit(failures.isEmpty ? 0 : 1)
    }
}
