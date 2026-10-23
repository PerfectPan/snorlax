import Foundation

/// What the widget can show (Spec R8, R12): the four states a container read
/// can end in, plus the usable snapshot with its as-of caption.
public enum WidgetSnapshotState: Equatable {
    case containerUnavailable
    case noSnapshot
    case newerSnapshot
    case usable(WidgetUsage)
}

/// Usable widget data. `isToday` is false when the snapshot's day — cut in the
/// snapshot's own time zone — is not the current day there, so its "today"
/// totals are a past day's numbers (an app quit across midnight).
public struct WidgetUsage: Equatable, Sendable {
    public let summary: UsageSummary
    public let asOfCaption: String
    public let isToday: Bool

    /// Agent rows for the medium widget: the ranked lists are ordered by
    /// today's tokens, so a past-day snapshot would mislabel old numbers.
    public var agentRows: [RankedUsage] {
        isToday ? summary.topAgents : []
    }
}

public enum WidgetSnapshot {
    /// - Parameters:
    ///   - timeZone: zone of the device showing the widget; the as-of clock uses it.
    ///   - load: reads the snapshot from the container; throws to signal unreadable.
    public static func state(
        containerURL: URL?,
        now: Date,
        timeZone: TimeZone,
        load: (URL) throws -> Snapshot
    ) -> WidgetSnapshotState {
        guard let containerURL else { return .containerUnavailable }
        do {
            let snapshot = try load(containerURL)
            let summary = UsageSummaryBuilder.make(snapshot)
            // Days in the snapshot were cut in its own zone (R8), so the
            // staleness check compares days there too.
            let snapshotZone = summary.timeZone
            let isToday: Bool
            if let generated = UsageFormat.instant(snapshot.generatedAt) {
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = snapshotZone
                isToday = calendar.isDate(generated, inSameDayAs: now)
            } else {
                isToday = false
            }
            let caption = asOfCaption(
                generatedAt: snapshot.generatedAt,
                isToday: isToday,
                timeZone: timeZone
            ) ?? ""
            return .usable(WidgetUsage(summary: summary, asOfCaption: caption, isToday: isToday))
        } catch SchemaError.newerCollector {
            return .newerSnapshot
        } catch {
            return .noSnapshot
        }
    }

    /// `as of 15:22`, or `as of 10/22 15:22` when the snapshot is not from today.
    public static func asOfCaption(generatedAt: String, isToday: Bool, timeZone: TimeZone) -> String? {
        guard let date = UsageFormat.instant(generatedAt) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = isToday ? "'as of' HH:mm" : "'as of' M/d HH:mm"
        return formatter.string(from: date)
    }
}
