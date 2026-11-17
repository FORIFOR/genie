import AppKit
import Darwin
let root = URL(fileURLWithPath: "/private/tmp/genie-transactions-20261002/environment-probe")
let state = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Genie/local-preview")
var observations: [String: Any] = ["initialAstraKeyCount": ProcessInfo.processInfo.environment.keys.filter { $0.hasPrefix("ASTRA_") }.count]
let selection = DesktopConnectionBootstrap.select(state: state, environment: ProcessInfo.processInfo.environment, arguments: CommandLine.arguments)
guard case .configured(let projection) = selection else { observations["selectionConfigured"] = false; try JSONSerialization.data(withJSONObject: observations, options: [.sortedKeys]).write(to: root.appendingPathComponent("standard-app-result.json")); exit(2) }
observations["selectionConfigured"] = true
DesktopConnectionBootstrap.install()
func sample(_ phase: String) {
 observations[phase] = ["swiftModelMatches": ProcessInfo.processInfo.environment["ASTRA_CODEX_MODEL"] == "gpt-6-sol", "cModelMatches": getenv("ASTRA_CODEX_MODEL").map { String(cString: $0) } == "gpt-6-sol", "swiftWorkspaceMatches": ProcessInfo.processInfo.environment["ASTRA_DATA_ROOT"] == state.appendingPathComponent("app").path]
}
sample("beforeAppKit")
let app = NSApplication.shared
sample("afterAppKit")
final class Delegate: NSObject, NSApplicationDelegate {
 func applicationDidFinishLaunching(_ notification: Notification) {
  sample("didFinishLaunching")
  RunLoop.main.perform(inModes: [.default, .modalPanel, .eventTracking]) {
   sample("afterLaunch")
   try! JSONSerialization.data(withJSONObject: observations, options: [.sortedKeys, .prettyPrinted]).write(to: root.appendingPathComponent("standard-app-result.json"))
   Darwin.exit(0)
  }
 }
}
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
