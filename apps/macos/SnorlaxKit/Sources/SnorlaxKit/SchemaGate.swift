import Foundation

/// The app's supported snapshot and CLI `schemaVersion` (plan 3.7).
public enum SchemaGate {
    public static let supportedVersion: Double = 1
    /// Shown when a file or CLI body is newer than this app.
    public static let newerCollectorMessage = "The collector is newer than the app; update the app."

    /// Throws when `schemaVersion` is present and is not the supported value.
    /// Missing `schemaVersion` is left to the typed decode.
    public static func rejectIfUnsupported(_ data: Data) throws {
        guard let version = schemaVersion(in: data) else { return }
        if version > supportedVersion {
            throw SchemaError.newerCollector
        }
        if version != supportedVersion {
            throw SchemaError.unsupported
        }
    }

    private static func schemaVersion(in data: Data) -> Double? {
        try? JSONDecoder().decode(SchemaMarker.self, from: data).schemaVersion
    }
}

public enum SchemaError: Error, Equatable {
    case newerCollector
    case unsupported
}

extension SchemaError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .newerCollector:
            return SchemaGate.newerCollectorMessage
        case .unsupported:
            return "This snapshot uses a schema the app does not support."
        }
    }
}

private struct SchemaMarker: Decodable {
    let schemaVersion: Double
}
