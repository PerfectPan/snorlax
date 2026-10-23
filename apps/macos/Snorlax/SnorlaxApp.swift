import SnorlaxKit
import SwiftUI

@main
struct SnorlaxApp: App {
    @StateObject private var model = SpikeModel()

    var body: some Scene {
        MenuBarExtra {
            SpikeMenu(model: model)
        } label: {
            Text(model.label)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Menu-bar label and App Group read. The 2 s timer is only so the owner can
/// see an edit of `spike-value.json`. Batch 4 watches the data directory.
@MainActor
final class SpikeModel: ObservableObject {
    @Published private(set) var label = "Snorlax"
    @Published private(set) var valueText = "—"
    @Published private(set) var appGroupIdentifier = AppGroup.identifierSuffix
    @Published private(set) var containerDetail = "App Group container has not been read yet."

    private var timer: Timer?

    init() {
        refreshValue()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refreshValue()
            }
        }
    }

    func refreshValue() {
        appGroupIdentifier = AppGroup.identifier()
        guard let container = AppGroup.containerURL() else {
            label = "Snorlax"
            valueText = "—"
            containerDetail = "App Group container is unavailable for this signature."
            return
        }
        do {
            let value = try SpikeValueStore.readOrSeed(in: container)
            label = value.value
            valueText = value.value
            containerDetail = SpikeValueStore.fileURL(in: container).path
        } catch {
            label = "Snorlax"
            valueText = "—"
            containerDetail = "Could not read \(SpikeValueStore.fileName): \(error.localizedDescription)"
        }
    }
}
