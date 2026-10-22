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

    let deviceNameNote = "No collector command changes the device name yet. Pairing sets it in a later batch."
    let timeZoneHelp =
        "Days follow the time zone recorded in the snapshot. A bucket belongs to the local day that contains its UTC hour. In a time zone whose offset is not a whole number of hours, that assignment is an approximation."

    private let dataDirectory: URL
    private let client: CollectorClient
    private let watcher: SnapshotWatcher
    private let reloader: WidgetCenterReloader

    init() {
        let directory = DataDirectory.resolve()
        dataDirectory = directory
        client = CollectorClient(executable: CollectorBundle.launcherURL())
        reloader = WidgetCenterReloader()
        let watcher = SnapshotWatcher(scheduler: DispatchWatchScheduler())
        self.watcher = watcher
        watcher.setHandler { [weak self] in
            Task { @MainActor in
                self?.reloadSnapshot()
            }
        }
        Task { await bootstrap() }
    }

    func reloadSnapshot() {
        appGroupIdentifier = AppGroup.identifier()
        let url = SnapshotFile.url(in: dataDirectory)
        guard FileManager.default.fileExists(atPath: url.path) else {
            summary = nil
            menuTitle = "Snorlax"
            loadError = nil
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
            publish(data)
        } catch {
            summary = nil
            menuTitle = "Snorlax"
            loadError = Presenter.message(for: error)
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
        Task {
            do {
                let status = try await client.run(["status"], as: Status.self)
                let name = status.device.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                deviceName = name.isEmpty ? "Unnamed" : name
            } catch {
                deviceName = "Unavailable"
                diagnosticsError = Presenter.message(for: error)
            }
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

    private func bootstrap() async {
        try? FileManager.default.createDirectory(
            at: dataDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let directory = dataDirectory
        let resolution: NodeResolution
        do {
            resolution = try await Task.detached {
                try NodeDiscovery.resolve(dataDirectory: directory, probe: ProcessNodeProbe())
            }.value
        } catch {
            nodeHint = Presenter.message(for: error)
            watcher.start(directory: directory)
            reloadSnapshot()
            return
        }
        if case .missing = resolution {
            nodeHint = NodeDiscovery.installHint
        } else {
            nodeHint = nil
        }
        watcher.start(directory: directory)
        reloadSnapshot()
    }

    private func publish(_ data: Data) {
        guard let container = AppGroup.containerURL() else {
            appGroupDetail = "App Group container is unavailable for this signature."
            return
        }
        do {
            let copy = AppGroupSnapshotCopy(container: container, reloader: reloader)
            try copy.publish(data)
            appGroupDetail = copy.fileURL.path
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
