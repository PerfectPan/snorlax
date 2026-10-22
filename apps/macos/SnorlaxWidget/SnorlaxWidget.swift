import SnorlaxKit
import SwiftUI
import WidgetKit

struct UsageEntry: TimelineEntry {
    let date: Date
    let summary: UsageSummary?
}

struct UsageProvider: TimelineProvider {
    func placeholder(in context: Context) -> UsageEntry {
        UsageEntry(date: Date(), summary: nil)
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
        guard let container = AppGroup.containerURL() else {
            return UsageEntry(date: now, summary: nil)
        }
        do {
            let snapshot = try SnapshotLoader.load(contentsOf: SnapshotFile.url(in: container))
            return UsageEntry(date: now, summary: UsageSummaryBuilder.make(snapshot))
        } catch {
            return UsageEntry(date: now, summary: nil)
        }
    }
}

struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    var body: some View {
        Group {
            if let summary = entry.summary {
                switch family {
                case .systemSmall:
                    small(summary)
                default:
                    medium(summary)
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("—")
                        .font(.title)
                    Text("No snapshot")
                        .font(.caption)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        }
        .containerBackground(.background, for: .widget)
    }

    private func small(_ summary: UsageSummary) -> some View {
        let today = summary.windows.first { $0.id == "today" }
        return VStack(alignment: .leading, spacing: 4) {
            Text("Today")
                .font(.caption)
            Text(today?.tokensText ?? "—")
                .font(.title2)
            Text(today?.costLabel ?? "—")
                .font(.caption)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func medium(_ summary: UsageSummary) -> some View {
        let today = summary.windows.first { $0.id == "today" }
        let week = summary.windows.first { $0.id == "last7d" }
        let agents = Array(summary.topAgents.prefix(UsageSummaryBuilder.widgetAgentLimit))
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                figure("Today", today)
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
