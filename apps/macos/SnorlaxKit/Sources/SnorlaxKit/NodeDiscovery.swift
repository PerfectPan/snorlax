import Foundation

public struct NodeVersion: Equatable, Sendable {
    public var major: Int
    public var minor: Int
    public var patch: Int

    public init(major: Int, minor: Int, patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    public func isAtLeast(_ minimum: NodeVersion) -> Bool {
        if major != minimum.major { return major > minimum.major }
        if minor != minimum.minor { return minor > minimum.minor }
        return patch >= minimum.patch
    }
}

public enum NodeResolution: Equatable, Sendable {
    case ready(String)
    case missing
}

public protocol NodeProbing: Sendable {
    /// Stdout of `executable --version`, or nil when it cannot be run.
    func versionOutput(executable: String) -> String?
    /// Stdout of `/bin/zsh -lc 'command -v node'`, trimmed by the caller, or nil.
    func loginShellNodePath() -> String?
}

/// Finds a Node >= 22.13 and writes `<data>/node-path` (plan 3.11).
/// The launcher reads that file. This type does not search `PATH` itself.
public enum NodeDiscovery {
    public static let minimum = NodeVersion(major: 22, minor: 13, patch: 0)
    public static let installHint = "Install Node.js 22.13 or later"
    public static let fileName = "node-path"

    /// First line, optional leading `v`, then `major.minor.patch`. Extra trailing text is ignored.
    /// Written without a regex literal so it compiles in the Swift 5 language mode the package uses.
    public static func parseVersion(_ text: String) -> NodeVersion? {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        var characters = line.trimmingCharacters(in: .whitespaces)[...]
        if characters.first == "v" || characters.first == "V" {
            characters.removeFirst()
        }
        guard let major = takeInteger(&characters),
              takeDot(&characters),
              let minor = takeInteger(&characters),
              takeDot(&characters),
              let patch = takeInteger(&characters)
        else {
            return nil
        }
        return NodeVersion(major: major, minor: minor, patch: patch)
    }

    private static func takeInteger(_ characters: inout Substring) -> Int? {
        var digits = ""
        while let next = characters.first, next.isNumber {
            digits.append(next)
            characters.removeFirst()
        }
        return digits.isEmpty ? nil : Int(digits)
    }

    private static func takeDot(_ characters: inout Substring) -> Bool {
        guard characters.first == "." else { return false }
        characters.removeFirst()
        return true
    }

    /// Keeps a saved Node that still satisfies the minimum. Otherwise asks the login
    /// shell, writes `node-path` when that Node is new enough, and removes a saved
    /// path that is not.
    public static func resolve(dataDirectory: URL, probe: any NodeProbing) throws -> NodeResolution {
        let file = dataDirectory.appendingPathComponent(fileName)
        if let existing = readPath(file), accepts(existing, probe: probe) {
            return .ready(existing)
        }
        if let discovered = probe.loginShellNodePath()?.trimmingCharacters(in: .whitespacesAndNewlines),
           discovered.hasPrefix("/"),
           accepts(discovered, probe: probe) {
            try writePath(discovered, directory: dataDirectory)
            return .ready(discovered)
        }
        if FileManager.default.fileExists(atPath: file.path) {
            try FileManager.default.removeItem(at: file)
        }
        return .missing
    }

    private static func accepts(_ path: String, probe: any NodeProbing) -> Bool {
        guard FileManager.default.isExecutableFile(atPath: path) else { return false }
        guard let output = probe.versionOutput(executable: path), let version = parseVersion(output) else {
            return false
        }
        return version.isAtLeast(minimum)
    }

    private static func readPath(_ url: URL) -> String? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return line.isEmpty ? nil : line
    }

    private static func writePath(_ path: String, directory: URL) throws {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try Data((path + "\n").utf8).write(to: directory.appendingPathComponent(fileName), options: .atomic)
    }
}

/// The real probe. `loginShellNodePath` is `/bin/zsh -lc 'command -v node'` with a 5 s timeout.
public struct ProcessNodeProbe: NodeProbing {
    public var timeout: TimeInterval

    public init(timeout: TimeInterval = 5) {
        self.timeout = timeout
    }

    public func versionOutput(executable: String) -> String? {
        guard let result = run(executable: executable, arguments: ["--version"]), result.status == 0 else {
            return nil
        }
        return result.stdout
    }

    public func loginShellNodePath() -> String? {
        guard let result = run(executable: "/bin/zsh", arguments: ["-lc", "command -v node"]), result.status == 0 else {
            return nil
        }
        return result.stdout
    }

    private func run(executable: String, arguments: [String]) -> (status: Int32, stdout: String)? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice
        let group = DispatchGroup()
        group.enter()
        process.terminationHandler = { _ in group.leave() }
        do {
            try process.run()
        } catch {
            group.leave()
            return nil
        }
        if group.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = group.wait(timeout: .now() + 1)
            return nil
        }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}
