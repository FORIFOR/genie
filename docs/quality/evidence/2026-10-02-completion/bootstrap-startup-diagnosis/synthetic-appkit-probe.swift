import AppKit
import Darwin
let root = URL(fileURLWithPath: "/private/tmp/genie-transactions-20261002/environment-probe")
let state = root.appendingPathComponent("synthetic-state")
try FileManager.default.createDirectory(at: state.appendingPathComponent("app"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: state.path)
let descriptor: [String: Any] = ["version": 1, "gatewayURL": "http://127.0.0.1:43199", "workspace": state.appendingPathComponent("app").path, "desktopIdentity": "11111111-2222-4333-8444-555555555555", "model": ["provider": "codex", "name": "gpt-6-sol"], "externalAuthorization": ["provider": "codex", "model": "gpt-6-sol"]]
let descriptorFile = state.appendingPathComponent(DesktopConnectionBootstrap.fileName)
try JSONSerialization.data(withJSONObject: descriptor).write(to: descriptorFile)
try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: descriptorFile.path)
var observations: [String: Any] = ["initialAstraKeyCount": ProcessInfo.processInfo.environment.keys.filter { $0.hasPrefix("ASTRA_") }.count]
let selection = DesktopConnectionBootstrap.select(state: state, environment: ProcessInfo.processInfo.environment, arguments: CommandLine.arguments)
guard case .configured(let projection) = selection else { observations["selectionConfigured"] = false; try JSONSerialization.data(withJSONObject: observations, options: [.sortedKeys]).write(to: root.appendingPathComponent("app-result.json")); exit(2) }
observations["selectionConfigured"] = true
try DesktopConnectionBootstrap.apply(projection)
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
   try! JSONSerialization.data(withJSONObject: observations, options: [.sortedKeys, .prettyPrinted]).write(to: root.appendingPathComponent("app-result.json"))
   Darwin.exit(0)
  }
 }
}
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
