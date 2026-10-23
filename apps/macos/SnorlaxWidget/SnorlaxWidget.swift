import SnorlaxKit
import SwiftUI
import WidgetKit

struct SpikeEntry: TimelineEntry {
    let date: Date
    let value: String
    let available: Bool
}

struct SpikeProvider: TimelineProvider {
    func placeholder(in context: Context) -> SpikeEntry {
        SpikeEntry(date: Date(), value: "—", available: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (SpikeEntry) -> Void) {
        completion(load())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SpikeEntry>) -> Void) {
        let entry = load()
        // Plan 3.11: one entry, refreshed after 15 minutes. Adding the widget
        // uses getSnapshot, so the gallery shows the current file immediately.
        let next = entry.date.addingTimeInterval(15 * 60)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }

    private func load() -> SpikeEntry {
        let now = Date()
        guard let container = AppGroup.containerURL() else {
            return SpikeEntry(date: now, value: "—", available: false)
        }
        do {
            let value = try SpikeValueStore.read(in: container)
            return SpikeEntry(date: now, value: value.value, available: true)
        } catch {
            return SpikeEntry(date: now, value: "—", available: false)
        }
    }
}

struct SpikeWidgetView: View {
    let entry: SpikeEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.value)
                .font(.title)
            Text(entry.available ? "App Group" : "Unavailable")
                .font(.caption)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(.background, for: .widget)
    }
}

struct SnorlaxWidget: Widget {
    private let kind = "io.github.perfectpan.snorlax.spike"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SpikeProvider()) { entry in
            SpikeWidgetView(entry: entry)
        }
        .configurationDisplayName("Snorlax")
        .description("Spike value from the App Group container.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct SnorlaxWidgetBundle: WidgetBundle {
    var body: some Widget {
        SnorlaxWidget()
    }
}
