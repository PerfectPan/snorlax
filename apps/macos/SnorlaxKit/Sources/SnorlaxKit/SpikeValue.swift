import Foundation

/// One string in the App Group container. Batch 4 replaces this with the
/// generated snapshot types. The file the owner edits is `{"value":"<text>"}`.
public struct SpikeValue: Codable, Equatable, Sendable {
    public var value: String

    public init(value: String) {
        self.value = value
    }
}

public enum SpikeValueStore {
    public static let fileName = "spike-value.json"
    public static let seed = SpikeValue(value: "0")

    public static func fileURL(in container: URL) -> URL {
        container.appendingPathComponent(fileName, isDirectory: false)
    }

    public static func read(in container: URL) throws -> SpikeValue {
        let data = try Data(contentsOf: fileURL(in: container))
        return try JSONDecoder().decode(SpikeValue.self, from: data)
    }

    /// Writes the seed when the file is absent. A file that fails to decode is left in place.
    public static func readOrSeed(in container: URL) throws -> SpikeValue {
        let url = fileURL(in: container)
        if !FileManager.default.fileExists(atPath: url.path) {
            try write(seed, in: container)
        }
        return try read(in: container)
    }

    public static func write(_ value: SpikeValue, in container: URL) throws {
        let data = try JSONEncoder().encode(value)
        try data.write(to: fileURL(in: container), options: .atomic)
    }
}
