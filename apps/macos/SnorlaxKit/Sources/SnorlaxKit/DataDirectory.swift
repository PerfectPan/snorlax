import Foundation

/// `<data>` is `SNORLAX_HOME`, or `~/Library/Application Support/snorlax` (plan 3.4.1).
public enum DataDirectory {
    public static func resolve(environment: [String: String], home: URL) -> URL {
        if let override = environment["SNORLAX_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return home.appendingPathComponent("Library/Application Support/snorlax", isDirectory: true)
    }

    public static func resolve() -> URL {
        resolve(
            environment: ProcessInfo.processInfo.environment,
            home: FileManager.default.homeDirectoryForCurrentUser
        )
    }
}
