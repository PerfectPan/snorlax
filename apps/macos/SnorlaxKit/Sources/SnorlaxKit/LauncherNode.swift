import Foundation

/// Resolution for the compiled `Contents/Helpers/snorlax` launcher (plan 3.11).
/// Pure functions: every file lookup is injected, so tests run without a real
/// bundle. The launcher's `main.swift` applies the result with `execv`.
public enum LauncherNode {
    /// The launcher's view of the file system. Defaults touch the real disk.
    public struct FileSystem: Sendable {
        public var fileExists: @Sendable (String) -> Bool
        public var isExecutableFile: @Sendable (String) -> Bool
        public var firstLine: @Sendable (String) -> String?

        public init(
            fileExists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
            isExecutableFile: @escaping @Sendable (String) -> Bool = {
                FileManager.default.isExecutableFile(atPath: $0)
            },
            firstLine: @escaping @Sendable (String) -> String? = { LauncherNode.firstLine(ofFile: $0) }
        ) {
            self.fileExists = fileExists
            self.isExecutableFile = isExecutableFile
            self.firstLine = firstLine
        }
    }

    public static let fileName = "node-path"
    public static let fallbackDirectories = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    public static let missingNodeMessage =
        "snorlax: node not found (checked node-path, then /opt/homebrew/bin:/usr/local/bin:/usr/bin)"
    static let collectorResourcePath = "Resources/collector/snorlax.mjs"

    /// Node from `<data>/node-path`, else the first executable in the fixed fallback
    /// directories, else nil. Never searches `PATH` or a login shell. `firstLine`
    /// returns the file's first line unchanged; trimming happens here.
    public static func resolve(dataDirectory: URL, fileSystem: FileSystem) -> String? {
        let pathFile = dataDirectory.appendingPathComponent(fileName, isDirectory: false).path
        if fileSystem.fileExists(pathFile) {
            let candidate = (fileSystem.firstLine(pathFile) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !candidate.isEmpty, fileSystem.isExecutableFile(candidate) {
                return candidate
            }
        }
        return fallbackDirectories
            .map { $0 + "/node" }
            .first { fileSystem.isExecutableFile($0) }
    }

    /// The bundled collector, derived from the launcher's own executable path so the
    /// working directory does not matter. Symlinks are resolved first: launchd and
    /// `CollectorClient` may reach the helper through one.
    public static func collectorPath(executablePath: String) -> String {
        let contents = URL(fileURLWithPath: executablePath)
            .resolvingSymlinksInPath()
            .deletingLastPathComponent() // Helpers
            .deletingLastPathComponent() // <bundle>/Contents
        return contents.appendingPathComponent(collectorResourcePath, isDirectory: false).path
    }

    /// First line of a text file without surrounding whitespace; nil when
    /// unreadable or empty. The literal first line, the way `head -n 1` reads
    /// it — a leading blank line means no Node, not the second line. The
    /// split names `\r\n` explicitly: Swift folds it into one grapheme, so a
    /// plain `"\n"` separator would not cut a CRLF file's first line.
    public static func firstLine(ofFile path: String) -> String? {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let line = text
            .split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" || $0 == "\r" })
            .first
            .map(String.init) ?? ""
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The home directory the way the previous `/bin/sh` launcher saw it:
    /// `$HOME` when set, otherwise nil (the caller falls back to the system
    /// home, which `homeDirectoryForCurrentUser` reads without the variable).
    public static func homeDirectory(environment: [String: String]) -> URL? {
        guard let home = environment["HOME"], !home.isEmpty else { return nil }
        return URL(fileURLWithPath: home, isDirectory: true)
    }
}
