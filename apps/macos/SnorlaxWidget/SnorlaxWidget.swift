import SnorlaxKit
import SwiftUI
import WidgetKit

struct UsageEntry: TimelineEntry {
    let date: Date
    let state: WidgetSnapshotState
}

struct UsageProvider: TimelineProvider {
    func placeholder(in context: Context) -> UsageEntry {
        UsageEntry(date: Date(), state: .noSnapshot)
    }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        completion(load())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        let entry = load()
        // Plan 3.11: one entry, refreshed after 15 minutes.
        let next = entry.date.addingTimeInterval(15 * 60)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }

    private func load() -> UsageEntry {
        let now = Date()
        let state = WidgetSnapshot.state(
            containerURL: AppGroup.containerURL(),
            now: now,
            timeZone: .current,
            load: { try SnapshotLoader.load(contentsOf: $0) }
        )
        return UsageEntry(date: now, state: state)
    }
}

struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    var body: some View {
        Group {
            switch entry.state {
            case .containerUnavailable:
                message("App Group container is unavailable")
            case .noSnapshot:
                message("No snapshot yet")
            case .newerSnapshot:
                message("The collector is newer than the app; update the app.")
            case let .usable(usage):
                switch family {
                case .systemSmall:
                    small(usage)
                default:
                    medium(usage)
                }
            }
        }
        .containerBackground(.background, for: .widget)
    }

    private func message(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("—")
                .font(.title)
            Text(text)
                .font(.caption)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    /// Today's numbers, or "—" when the snapshot's today is a past day (R8).
    private func small(_ usage: WidgetUsage) -> some View {
        let today = usage.summary.windows.first { $0.id == "today" }
        return VStack(alignment: .leading, spacing: 4) {
            Text("Today")
                .font(.caption)
            Text(usage.isToday ? today?.tokensText ?? "—" : "—")
                .font(.title2)
            Text(usage.isToday ? today?.costLabel ?? "—" : "—")
                .font(.caption)
            Text(usage.asOfCaption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func medium(_ usage: WidgetUsage) -> some View {
        let today = usage.summary.windows.first { $0.id == "today" }
        let week = usage.summary.windows.first { $0.id == "last7d" }
        let agents = Array(usage.agentRows.prefix(UsageSummaryBuilder.widgetAgentLimit))
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                figure("Today", usage.isToday ? today : nil)
                figure("7 days", week)
            }
            ForEach(agents) { agent in
                HStack {
                    Text(agent.name)
                    Spacer()
                    Text(agent.tokensText)
                }
                .font(.caption)
            }
            Text(usage.asOfCaption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func figure(_ title: String, _ window: DayWindowModel?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(window?.tokensText ?? "—")
                .font(.headline)
            Text(window?.costLabel ?? "—")
                .font(.caption2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SnorlaxWidget: Widget {
    private let kind = "io.github.perfectpan.snorlax.usage"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: UsageProvider()) { entry in
            UsageWidgetView(entry: entry)
        }
        .configurationDisplayName("Snorlax")
        .description("Today's tokens and cost, and the last 7 days.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct SnorlaxWidgetBundle: WidgetBundle {
    var body: some Widget {
        SnorlaxWidget()
    }
}
