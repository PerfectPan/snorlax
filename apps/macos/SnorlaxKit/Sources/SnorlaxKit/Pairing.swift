import Combine
import Foundation

/// One pairing attempt in Settings. The view binds the fields and the buttons.
///
/// The admin token lives only in `adminToken` for the length of `pair()`. It is
/// handed to the collector on stdin, never as an argument, and the property is
/// cleared when the attempt ends, whether the command succeeded or failed. Nothing
/// here writes UserDefaults, the keychain, or a log: the collector stores the
/// device token, and this process must not keep the admin token.
@MainActor
public final class PairingModel: ObservableObject {
    @Published public var backendURL = ""
    @Published public var deviceName = ""
    @Published public var adminToken = ""
    @Published public private(set) var running = false
    @Published public private(set) var paired = false
    @Published public private(set) var syncStateText = "—"
    @Published public private(set) var lastSyncText = "—"
    @Published public private(set) var notice: String?

    /// Reloads the snapshot after a pair or unpair and returns the status the
    /// section should show. The app also refreshes `snorlax status` there.
    public var refreshSnapshot: (@MainActor () async -> SnapshotStatus?)?

    private let client: CollectorClient

    public init(client: CollectorClient) {
        self.client = client
    }

    public var canPair: Bool {
        !running && !trimmed(backendURL).isEmpty && !trimmed(deviceName).isEmpty && !adminToken.isEmpty
    }

    /// Fills an empty device-name field from `snorlax status`. A missing or blank
    /// name stays empty so the user can type one. A name the user already typed
    /// is left as it is.
    public func loadDefaultDeviceName() async {
        guard !running else { return }
        let status: Status
        do {
            status = try await client.run(["status"], as: Status.self)
        } catch {
            return
        }
        let name = trimmed(status.device.name ?? "")
        if trimmed(deviceName).isEmpty, !name.isEmpty {
            deviceName = name
        }
    }

    /// Shows pairing and sync from the snapshot (`status.paired`, `status.sync`).
    /// `now` is the clock the relative sync time is measured against.
    public func apply(status: SnapshotStatus?, now: Date = Date(), timeZone: TimeZone = .current) {
        guard let status else {
            paired = false
            syncStateText = "—"
            lastSyncText = "—"
            return
        }
        paired = status.paired
        syncStateText = status.sync.state.rawValue
        if let at = status.sync.at, let text = UsageFormat.instantText(at, now: now, timeZone: timeZone) {
            lastSyncText = text
        } else {
            lastSyncText = "—"
        }
    }

    public func pair() async {
        let url = trimmed(backendURL)
        let name = trimmed(deviceName)
        let token = adminToken
        guard !running, !url.isEmpty, !name.isEmpty, !token.isEmpty else { return }
        running = true
        defer {
            adminToken = ""
            running = false
        }
        let outcome: PairResult
        do {
            // `pair` strips one trailing newline. The field is one token, so
            // stdin is that token plus one newline and nothing else.
            outcome = try await client.run(
                ["pair", "--url", url, "--name", name],
                stdin: Data((token + "\n").utf8),
                as: PairResult.self
            )
            notice = nil
        } catch {
            notice = PairingCopy.pair(error)
            await reloadSnapshot()
            return
        }
        await reloadSnapshot()
        if !paired {
            notice = "Paired as \(outcome.name). The snapshot does not show this Mac as paired yet."
        }
    }

    public func unpair() async {
        guard !running else { return }
        running = true
        defer { running = false }
        do {
            _ = try await client.run(["unpair"], as: Ok.self)
            notice = nil
        } catch {
            notice = PairingCopy.unpair(error)
            await reloadSnapshot()
            return
        }
        await reloadSnapshot()
        if paired {
            notice = "Unpair finished, but the snapshot still shows this Mac as paired."
        }
    }

    private func reloadSnapshot() async {
        guard let refreshSnapshot else { return }
        let status = await refreshSnapshot()
        apply(status: status)
    }

    private func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Sentences for the collector's pairing failure codes. The collector's own
/// `message` stays on the end so the raw reason is still visible.
enum PairingCopy {
    static func pair(_ error: Error) -> String {
        guard let failure = failure(of: error) else { return localized(error) }
        let summary: String
        switch failure.code {
        case "unauthorized":
            summary = "The admin token was not accepted."
        case "conflict":
            summary = "This device is already registered and has not been revoked. Revoke it with the admin token, then pair again."
        case "network":
            summary = "The backend could not be reached."
        case "keychain":
            summary = "The backend registered this device, but the device token was not saved in the keychain. Revoke the device, then pair again."
        case "forbidden":
            summary = "The backend refused this pairing."
        case "invalid-response":
            summary = "The collector could not read the backend's response."
        case "invalid-arguments":
            summary = "The backend URL or the device name was not accepted. The URL must use https, except http for localhost, 127.0.0.1, and [::1]."
        default:
            summary = "Pairing failed (\(failure.code))."
        }
        return join(summary, failure.message)
    }

    static func unpair(_ error: Error) -> String {
        guard let failure = failure(of: error) else {
            return join("Could not unpair.", localized(error))
        }
        return join("Could not unpair (\(failure.code)).", failure.message)
    }

    private static func failure(of error: Error) -> FailureError? {
        guard case let .failed(failure) = error as? CollectorClientError else { return nil }
        return failure.error
    }

    private static func localized(_ error: Error) -> String {
        if let described = error as? LocalizedError, let text = described.errorDescription, !text.isEmpty {
            return text
        }
        return error.localizedDescription
    }

    private static func join(_ summary: String, _ message: String) -> String {
        message.isEmpty ? summary : "\(summary) \(message)"
    }
}
