// swift-tools-version:5.10
import PackageDescription
import Foundation

// Genie の macOS ネイティブ UI（正本）。共通ロジックは Rust の genie-core を UniFFI 経由で使う。
//   SwiftUI → GenieCoreBridge → GenieCore(UniFFI) → CGenieCoreFFI(C) → libgenie_core.a(Rust)
// 生成物: `pnpm gen:swift-bindings`。Rust 静的ライブラリ: `cargo build`（core/genie-core）。
let package = Package(
    name: "genie-macos",
    platforms: [.macOS(.v14)],
    targets: [
        // UniFFI が出す C ヘッダ + modulemap（module 名 genie_coreFFI）。
        .target(name: "CGenieCoreFFI", path: "Sources/GenieCoreFFI", sources: [], publicHeadersPath: "include"),
        // UniFFI が出す Swift binding。Rust の静的ライブラリをここでリンクする。
        .target(
            name: "GenieCore",
            dependencies: ["CGenieCoreFFI"],
            path: "Sources/GenieCore",
            linkerSettings: [
                // **静的ライブラリを直に渡す。**
                //
                // 以前は `-L …/target/debug -lgenie_core` だった。cargo は同じ場所へ
                // `.a` と `.dylib` の両方を置くので、リンカは `.dylib` を選ぶ。その結果
                // 配布用に署名した .app が、私のソースツリーの絶対パスにある debug の
                // dylib を参照して、他人の Mac では起動できない状態になっていた
                // （実際 `dist/Genie.app` が Team ID 不一致で落ちた）。
                // `.a` を位置引数で渡せば静的に取り込まれ、実行時に何も要らない。
                //
                // 置き場所は環境変数で差し替えられる。配布ビルドは release の `.a` を指す
                // —— 指せないと、release の .app に debug の Rust が入る。
                .unsafeFlags([
                    (ProcessInfo.processInfo.environment["ASTRA_CORE_LIB_DIR"]
                        ?? "../../core/genie-core/target/debug") + "/libgenie_core.a",
                ])
            ]
        ),
        // 自動更新。配布先へ置いた appcast を見て、新しい版があれば知らせる。
        // 署名は EdDSA（Sparkle 自前の鍵）で、Developer ID とは別物。
        //
        // `.package(url:)` ではなくローカルの xcframework を指す。この環境では
        // SwiftPM の binary artifact 取得だけが固まるため、取得は
        // `scripts/fetch-sparkle.sh` に切り出してある（checksum は Sparkle 自身の
        // Package.swift と同じ値で照合する）。
        .binaryTarget(name: "Sparkle", path: "Vendor/Sparkle/Sparkle.xcframework"),
        // 「ジーニー」の呼びかけ検出（端末の中だけ）。livekit-wakeword の Swift 検出器と ONNX Runtime。
        // 取得は `scripts/fetch-wakeword-runtime.sh`（checksum・コミット固定。Sparkle と同じ理由で binary は手で取る）。
        .binaryTarget(name: "onnxruntime", path: "Vendor/onnxruntime/onnxruntime.xcframework"),
        .target(name: "OnnxRuntimeBindings", dependencies: ["onnxruntime"], path: "Vendor/OnnxRuntimeBindings",
                exclude: ["LICENSE"], cxxSettings: [.define("SPM_BUILD")]),
        .target(name: "LiveKitWakeWord", dependencies: ["OnnxRuntimeBindings"], path: "Vendor/LiveKitWakeWord",
                exclude: ["LICENSE", "Resources"]),
        // 承認の境界。「人が確認カードで押した」証拠（UserApproval）と、backend の承認に答える
        // 唯一の場所をここに閉じる。**証拠の init はこのモジュールの外から見えない**ので、
        // GenieMac から直接・別名・extension・decode では作れず、コピーもできない（ここは型で守る）。
        // ただし入口の `ApprovalLedger.issue` は public で、GenieMac のどこからでも呼べば作れる。
        // それを Confirm.approve の 1 か所に限るのは型ではなくゲート（`scripts/verify-approval-boundary.sh`）。
        // 検査の側も `@testable import` しない。
        .target(name: "GenieApproval", dependencies: ["GenieCore"], path: "Sources/GenieApproval"),
        .executableTarget(
            name: "GenieMac",
            dependencies: ["GenieCore", "GenieApproval", "Sparkle", "LiveKitWakeWord"],
            path: "Sources/GenieMac",
            // CLI selftestにもTCCの用途説明が必要。ないと権限拒否ではなくOSがSIGABRTで終了する。
            // releaseは署名バンドルのInfo.plistを使う。
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                    "-Xlinker", URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                        .appendingPathComponent("Support/SelfTest-Info.plist").path,
                ], .when(configuration: .debug))
            ]
        ),
        .testTarget(
            name: "GenieMacTests",
            dependencies: ["GenieCore", "GenieApproval", "GenieMac"],
            path: "Tests/GenieMacTests"
        ),
    ],
    cxxLanguageStandard: .cxx17
)
