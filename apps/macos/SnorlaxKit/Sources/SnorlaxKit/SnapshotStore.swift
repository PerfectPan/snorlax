import Foundation

/// `snapshot.json` in the data directory and in the App Group container.
public enum SnapshotFile {
    public static let name = "snapshot.json"

    public static func url(in directory: URL) -> URL {
        directory.appendingPathComponent(name, isDirectory: false)
    }
}

public enum SnapshotLoader {
    public static func load(_ data: Data) throws -> Snapshot {
        try SchemaGate.rejectIfUnsupported(data)
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    public static func load(contentsOf url: URL) throws -> Snapshot {
        try load(Data(contentsOf: url))
    }
}

/// Asks WidgetKit to reload. The app adapts `WidgetCenter`; tests record the call.
public protocol TimelineReloading: AnyObject {
    func reloadAllTimelines()
}

/// Writes the accepted snapshot into the App Group container and reloads widget timelines (Spec S13).
/// A newer `schemaVersion` is refused before the file is replaced.
public struct AppGroupSnapshotCopy {
    public let container: URL
    public let reloader: any TimelineReloading

    public init(container: URL, reloader: any TimelineReloading) {
        self.container = container
        self.reloader = reloader
    }

    public var fileURL: URL {
        SnapshotFile.url(in: container)
    }

    public func publish(_ data: Data) throws {
        _ = try SnapshotLoader.load(data)
        try data.write(to: fileURL, options: .atomic)
        reloader.reloadAllTimelines()
    }
}

/// Publishes an accepted snapshot to the App Group container once per distinct
/// snapshot. Widget refreshes draw on a daily budget (Spec R12), so re-reads of
/// an unchanged snapshot — the 60 s fallback, opening the menu, Refresh now —
/// must not copy the file or reload timelines again.
public struct AppGroupSnapshotPublisher {
    public let copy: AppGroupSnapshotCopy
    private var lastGeneratedAt: String?

    public init(container: URL, reloader: any TimelineReloading) {
        self.copy = AppGroupSnapshotCopy(container: container, reloader: reloader)
    }

    public var container: URL { copy.container }
    public var fileURL: URL { copy.fileURL }

    /// Returns whether the snapshot changed since the last accepted publish and
    /// was copied; false leaves the file and the widget timelines untouched.
    @discardableResult
    public mutating func publish(_ data: Data) throws -> Bool {
        let snapshot = try SnapshotLoader.load(data)
        guard snapshot.generatedAt != lastGeneratedAt else { return false }
        try copy.publish(data)
        lastGeneratedAt = snapshot.generatedAt
        return true
    }
}
