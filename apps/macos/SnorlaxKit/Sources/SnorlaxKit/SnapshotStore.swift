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
