import Foundation

/// App launch order (plan 3.11): the data directory is created, the snapshot
/// watcher starts and the snapshot loads first, then Node discovery runs in
/// the background — a login shell that hangs discovery cannot keep the menu
/// bar without data.
public enum LaunchSequence {
    /// `discover` runs on a background task; its result is delivered through
    /// `onDiscovery` (`resolution` is nil when it threw). `reloadSnapshot` is
    /// called synchronously, before discovery starts, on the caller's actor.
    public static func run(
        dataDirectory: URL,
        watcher: SnapshotWatcher,
        reloadSnapshot: @escaping () -> Void,
        discover: @escaping @Sendable () throws -> NodeResolution,
        onDiscovery: @escaping @Sendable (NodeResolution?, Error?) -> Void
    ) {
        try? FileManager.default.createDirectory(
            at: dataDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        watcher.start(directory: dataDirectory)
        reloadSnapshot()
        Task.detached(priority: .utility) {
            do {
                onDiscovery(try discover(), nil)
            } catch {
                onDiscovery(nil, error)
            }
        }
    }
}
