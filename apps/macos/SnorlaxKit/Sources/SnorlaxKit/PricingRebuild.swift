import Combine
import Foundation

/// An explicit owner-requested rebuild. Merely showing a pricing notice never
/// starts a command. The task survives closing/reopening the popover.
@MainActor
public final class PricingRebuildModel: ObservableObject {
    @Published public private(set) var running = false
    @Published public private(set) var notice: String?
    public var refreshSnapshot: (@MainActor () async -> Void)?

    private let client: CollectorClient
    public static let timeout: Duration = .seconds(600)

    public init(client: CollectorClient) {
        self.client = client
    }

    public func rebuild() async {
        guard !running else { return }
        running = true
        notice = nil
        defer { running = false }
        do {
            let result = try await client.run(
                ["rebuild", "--days", "180"], timeout: Self.timeout, as: RefreshResult.self
            )
            var message = result.failures == 0
                ? "Rebuilt the last 180 days."
                : "Rebuild finished with \(result.failures) parsing failures; some costs may still be incomplete."
            if !result.sync.ok {
                message += " Sync did not complete. " + (result.sync.message ?? "Check Diagnostics for details.")
            }
            notice = message
        } catch {
            let detail = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            notice = "Rebuild could not be confirmed. \(detail) Check Diagnostics before trying again."
        }
        // A failed/timed-out process may still have written data. Reconcile it
        // once without automatically retrying the command.
        await refreshSnapshot?()
    }
}
