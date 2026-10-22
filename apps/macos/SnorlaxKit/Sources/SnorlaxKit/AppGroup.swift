import Foundation

/// App Group shared by the menu bar app and the widget.
///
/// The entitlement and `AppGroupIdentifier` are
/// `$(TeamIdentifierPrefix)io.github.perfectpan.snorlax`. Xcode expands the
/// prefix when it builds. Reading the expanded value from the host bundle keeps
/// the id the code passes to `containerURL` equal to the signed entitlement.
public enum AppGroup {
    public static let identifierSuffix = "io.github.perfectpan.snorlax"
    public static let infoDictionaryKey = "AppGroupIdentifier"

    public static func identifier(in bundle: Bundle = .main) -> String {
        guard let raw = bundle.object(forInfoDictionaryKey: infoDictionaryKey) as? String else {
            return identifierSuffix
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.contains("$(") {
            return identifierSuffix
        }
        return trimmed
    }

    public static func containerURL(in bundle: Bundle = .main) -> URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: identifier(in: bundle)
        )
    }
}
