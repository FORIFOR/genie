import AppKit
import CryptoKit
import Darwin
import Foundation

/// Reads the computer helper's native privacy barrier. No image, field value,
/// URL or credential is read. The app cannot remove a marker or grant an override.
enum RegistrationPrivacyGuard {
    struct Generation: Equatable { let seconds: UInt64; let microseconds: UInt64 }
    struct Observation: Equatable { let blocked: Bool; let stamp: String }
    enum GuardError: Error { case unavailable, protectedWindow }
    // The helper can create registration markers only for this exact bundle set.
    // Keep in sync with RegistrationCapturePrivacy.supportedBrowserBundles.
    static let supportedBrowserBundles: Set<String> = [
        "com.apple.Safari", "com.google.Chrome", "com.google.Chrome.beta",
        "com.google.Chrome.dev", "com.google.Chrome.canary", "org.chromium.Chromium",
        "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi", "company.thebrowser.Browser",
    ]

    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genie-computer-privacy", isDirectory: true)
    }
    /// Wire contract shared with RegistrationCapturePrivacy in genie-computer.swift.
    static func key(pid: Int32, generation: Generation) -> String {
        SHA256.hash(data: Data("\(pid):\(generation.seconds):\(generation.microseconds)".utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    /// Filesystem and process lookup failures are privacy failures, never permission.
    static var isBlocked: Bool {
        (try? observe().blocked) ?? true
    }
    static func observe(directory: URL = RegistrationPrivacyGuard.directory) throws -> Observation {
        try observation(directory: directory, processes: currentProcesses, generation: processGeneration)
    }

    static func blocked(directory: URL, processes: () throws -> [Int32],
                        generation: (Int32) throws -> Generation) throws -> Bool {
        try observation(directory: directory, processes: processes, generation: generation).blocked
    }
    static func observation(directory: URL, processes: () throws -> [Int32],
                            generation: (Int32) throws -> Generation) throws -> Observation {
        func result(_ blocked: Bool, _ markers: Set<String>) -> Observation {
            let stamp = SHA256.hash(data: Data(markers.sorted().joined(separator: "\n").utf8))
                .map { String(format: "%02x", $0) }.joined()
            return Observation(blocked: blocked, stamp: stamp)
        }
        var info = stat()
        if lstat(directory.path, &info) != 0 {
            if errno == ENOENT { return result(false, []) }
            throw GuardError.unavailable
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(), (info.st_mode & 0o077) == 0
        else { throw GuardError.unavailable }
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        guard names.count <= 100_000 else { throw GuardError.unavailable }
        var markers: Set<String> = []
        for name in names {
            guard name.count == 64, name.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
            else { throw GuardError.unavailable }
            var marker = stat()
            guard lstat(directory.appendingPathComponent(name).path, &marker) == 0,
                  (marker.st_mode & S_IFMT) == S_IFREG, marker.st_uid == getuid(), (marker.st_mode & 0o077) == 0, marker.st_size == 0
            else { throw GuardError.unavailable }
            markers.insert(name)
        }
        if markers.isEmpty { return result(false, markers) }
        var generations: [Int32: Generation] = [:]
        let live = try processes()
        guard live.count <= 100_000 else { throw GuardError.unavailable }
        var active = false
        for pid in live {
            guard pid > 0 else { throw GuardError.unavailable }
            let born = try generations[pid] ?? generation(pid)
            guard born.seconds > 0 else { throw GuardError.unavailable }
            generations[pid] = born
            if markers.contains(key(pid: pid, generation: born)) { active = true; break }
        }
        // A marker created during process enumeration must invalidate this sample.
        guard Set(try FileManager.default.contentsOfDirectory(atPath: directory.path)) == markers
        else { throw GuardError.unavailable }
        // Tab moves and closing every window do not unblock a running browser.
        // Only a terminated/replaced process stops matching; markers are never deleted.
        return result(active, markers)
    }

    private static func currentProcesses() throws -> [Int32] {
        let applications = NSWorkspace.shared.runningApplications
        guard !applications.isEmpty else { throw GuardError.unavailable }
        // Protected system agents can deny kernel metadata access. They cannot
        // receive registration credentials, so only the helper's supported browsers
        // belong to this check; failures for those browsers still fail closed.
        return applications.filter {
            !$0.isTerminated && $0.bundleIdentifier.map(supportedBrowserBundles.contains) == true
        }.map(\.processIdentifier)
    }
    private static func processGeneration(_ pid: Int32) throws -> Generation {
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              info.pbi_start_tvsec > 0 else { throw GuardError.unavailable }
        return Generation(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
    }

    /// Both checks are necessary: a registration can fill while capture is in flight.
    static func capture<T>(observe: () throws -> Observation = { try RegistrationPrivacyGuard.observe() }, _ operation: () throws -> T) throws -> T {
        let before = try observe()
        guard !before.blocked else { throw GuardError.protectedWindow }
        let result = try operation()
        try validate(before, observe: observe)
        return result
    }
    static func captureAsync<T>(observe: () throws -> Observation = { try RegistrationPrivacyGuard.observe() }, _ operation: () async throws -> T) async throws -> T {
        let before = try observe()
        guard !before.blocked else { throw GuardError.protectedWindow }
        let result = try await operation()
        try validate(before, observe: observe)
        return result
    }
    static func validate(_ before: Observation, observe: () throws -> Observation = { try RegistrationPrivacyGuard.observe() }) throws {
        let after = try observe()
        // The process may exit while pixels/text are in flight. Marker history is
        // durable, so a newly created marker still invalidates that observation.
        guard !before.blocked, !after.blocked, before.stamp == after.stamp else { throw GuardError.protectedWindow }
    }
}
