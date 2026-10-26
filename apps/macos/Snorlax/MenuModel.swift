import SnorlaxKit
import SwiftUI
import WidgetKit

/// Menu bar state. Launch discovers Node and watches the data directory.
/// It does not call `SMAppService.register()`.
@MainActor
final class MenuModel: ObservableObject {
    @Published private(set) var menuTitle = "Snorlax"
    @Published private(set) var summary: UsageSummary?
    @Published private(set) var loadError: String?
    @Published private(set) var nodeHint: String?
    @Published private(set) var appGroupIdentifier = AppGroup.identifierSuffix
    @Published private(set) var appGroupDetail = "App Group container has not been read yet."
    @Published private(set) var refreshError: String?
    @Published private(set) var refreshing = false
    @Published private(set) var deviceName = "…"
    @Published private(set) var diagnostics: Doctor?
    @Published private(set) var diagnosticsError: String?
    /// `snapshot.status`. Settings uses it for paired, sync state, and last sync.
    @Published private(set) var snapshotStatus: SnapshotStatus?

    let deviceNameNote = "Shown from snorlax status. Pairing sets the name; this field does not edit it."
    let timeZoneHelp =
        "Days follow the time zone recorded in the snapshot. A bucket belongs to the local day that contains its UTC hour. In a time zone whose offset is not a whole number of hours, that assignment is an approximation."

    private let dataDirectory: URL
    private let client: CollectorClient
    private let watcher: SnapshotWatcher
    private let reloader: WidgetCenterReloader
    private var publisher: AppGroupSnapshotPublisher?
    let pairing: PairingModel

    init() {
        let directory = DataDirectory.resolve()
        dataDirectory = directory
        let client = CollectorClient(executable: CollectorBundle.launcherURL())
        self.client = client
        reloader = WidgetCenterReloader()
        let watcher = SnapshotWatcher(scheduler: DispatchWatchScheduler())
        self.watcher = watcher
        let pairing = PairingModel(client: client)
        self.pairing = pairing
        watcher.setHandler { [weak self] in
            Task { @MainActor in
                self?.reloadSnapshot()
            }
        }
        pairing.refreshSnapshot = { [weak self] in
            guard let self else { return nil }
            self.reloadSnapshot()
            await self.reloadDeviceName()
            return self.snapshotStatus
        }
        Task { bootstrap() }
    }

    func reloadSnapshot() {
        appGroupIdentifier = AppGroup.identifier()
        let url = SnapshotFile.url(in: dataDirectory)
        guard FileManager.default.fileExists(atPath: url.path) else {
            summary = nil
            menuTitle = "Snorlax"
            loadError = nil
            snapshotStatus = nil
            noteContainer()
            return
        }
        do {
            let data = try Data(contentsOf: url)
            let snapshot = try SnapshotLoader.load(data)
            let next = UsageSummaryBuilder.make(snapshot)
            summary = next
            menuTitle = next.menuTitle
            loadError = nil
            snapshotStatus = snapshot.status
            publish(data)
        } catch {
            summary = nil
            menuTitle = "Snorlax"
            loadError = Presenter.message(for: error)
            snapshotStatus = nil
            noteContainer()
        }
    }

    func refreshNow() {
        guard !refreshing else { return }
        refreshing = true
        refreshError = nil
        Task {
            defer { refreshing = false }
            do {
                _ = try await client.run(["refresh"], as: RefreshResult.self)
                reloadSnapshot()
            } catch {
                refreshError = Presenter.message(for: error)
            }
        }
    }

    func loadDeviceName() {
        Task { await reloadDeviceName() }
    }

    private func reloadDeviceName() async {
        do {
            let status = try await client.run(["status"], as: Status.self)
            let name = status.device.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            deviceName = name.isEmpty ? "Unnamed" : name
        } catch {
            deviceName = "Unavailable"
            diagnosticsError = Presenter.message(for: error)
        }
    }

    func runDiagnostics() {
        diagnostics = nil
        diagnosticsError = nil
        Task {
            do {
                diagnostics = try await client.run(["doctor"], as: Doctor.self)
            } catch {
                diagnosticsError = Presenter.message(for: error)
            }
        }
    }

    private func bootstrap() {
        let directory = dataDirectory
        LaunchSequence.run(
            dataDirectory: directory,
            watcher: watcher,
            reloadSnapshot: { [weak self] in self?.reloadSnapshot() },
            discover: { try NodeDiscovery.resolve(dataDirectory: directory, probe: ProcessNodeProbe()) },
            onDiscovery: { [weak self] resolution, error in
                Task { @MainActor in
                    if let error {
                        self?.nodeHint = Presenter.message(for: error)
                    } else if case .missing = resolution {
                        self?.nodeHint = NodeDiscovery.installHint
                    } else {
                        self?.nodeHint = nil
                    }
                }
            }
        )
    }

    private func publish(_ data: Data) {
        guard let container = AppGroup.containerURL() else {
            appGroupDetail = "App Group container is unavailable for this signature."
            return
        }
        if publisher?.container != container {
            publisher = AppGroupSnapshotPublisher(container: container, reloader: reloader)
        }
        do {
            if try publisher?.publish(data) == true {
                appGroupDetail = publisher.map(\.fileURL.path) ?? appGroupDetail
            }
        } catch {
            appGroupDetail = Presenter.message(for: error)
        }
    }

    private func noteContainer() {
        guard let container = AppGroup.containerURL() else {
            appGroupDetail = "App Group container is unavailable for this signature."
            return
        }
        appGroupDetail = container.path
    }
}

enum CollectorBundle {
    static func launcherURL(bundle: Bundle = .main) -> URL {
        bundle.bundleURL.appendingPathComponent("Contents/Helpers/snorlax")
    }
}

final class WidgetCenterReloader: TimelineReloading {
    func reloadAllTimelines() {
        WidgetCenter.shared.reloadAllTimelines()
    }
}

enum Presenter {
    static func message(for error: Error) -> String {
        if let described = error as? LocalizedError, let text = described.errorDescription, !text.isEmpty {
            return text
        }
        return error.localizedDescription
    }
}
