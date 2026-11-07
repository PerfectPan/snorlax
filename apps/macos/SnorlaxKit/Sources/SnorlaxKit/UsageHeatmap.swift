import Foundation

/// A missing date is padding outside the displayed window. A date with nil
/// tokens is inside the window but absent from an older/incomplete snapshot.
public struct UsageHeatmapDay: Equatable, Identifiable, Sendable {
    public var id: Int
    public var date: String?
    public var tokens: Int?
    public var costUsd: Double?
    public var level: Int

    public var detail: String {
        guard let date else { return "" }
        guard let tokens, let costUsd else { return "\(date): no data in this snapshot" }
        return "\(date): \(tokens.formatted(.number.locale(Locale(identifier: "en_US")))) tokens · estimated cost \(UsageFormat.cost(costUsd))"
    }
}

public struct UsageHeatmapWeek: Equatable, Identifiable, Sendable {
    public var id: Int
    public var monthLabel: String?
    public var days: [UsageHeatmapDay]
}

public struct UsageHeatmap: Equatable, Sendable {
    public var weeks: [UsageHeatmapWeek]
    public var startDate: String
    public var endDate: String
    public var hasMissingDays: Bool
}

public enum UsageHeatmapBuilder {
    public static let dayCount = 180

    /// The snapshot's day, not the viewer's wall clock, anchors the window.
    /// Calendar arithmetic preserves local dates across daylight-saving changes.
    public static func make(daily: [Daily], generatedAt: String, timeZone: TimeZone) -> UsageHeatmap? {
        guard let instant = UsageFormat.instant(generatedAt) else { return nil }
        let calendar = UsageFormat.dayCalendar(timeZone)
        let end = calendar.startOfDay(for: instant)
        guard let start = calendar.date(byAdding: .day, value: -(dayCount - 1), to: end) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        let monthFormatter = DateFormatter()
        monthFormatter.locale = Locale(identifier: "en_US_POSIX")
        monthFormatter.calendar = calendar
        monthFormatter.timeZone = timeZone
        monthFormatter.dateFormat = "MMM"

        var entries: [String: Daily] = [:]
        for entry in daily {
            guard let day = UsageFormat.dayDate(entry.date, timeZone: timeZone), day >= start, day <= end else { continue }
            entries[entry.date] = entry
        }
        let peak = entries.values.map(\.tokens).max() ?? 0
        let leading = calendar.component(.weekday, from: start) - 1 // Sunday = 1
        let cellCount = ((leading + dayCount + 6) / 7) * 7
        var weeks: [UsageHeatmapWeek] = []
        var lastLabeledMonth: Int?
        var hasMissingDays = false
        for week in 0..<(cellCount / 7) {
            var days: [UsageHeatmapDay] = []
            var monthLabel: String?
            for weekday in 0..<7 {
                let index = week * 7 + weekday
                let offset = index - leading
                guard offset >= 0, offset < dayCount,
                      let day = calendar.date(byAdding: .day, value: offset, to: start) else {
                    days.append(UsageHeatmapDay(id: index, date: nil, tokens: nil, costUsd: nil, level: 0))
                    continue
                }
                let date = formatter.string(from: day)
                let entry = entries[date]
                if entry == nil { hasMissingDays = true }
                let month = calendar.component(.month, from: day)
                if (offset == 0 || calendar.component(.day, from: day) == 1), month != lastLabeledMonth {
                    monthLabel = monthFormatter.string(from: day)
                    lastLabeledMonth = month
                }
                let level: Int
                if let tokens = entry?.tokens, tokens > 0, peak > 0 {
                    level = min(4, max(1, Int(ceil(Double(tokens) / Double(peak) * 4))))
                } else {
                    level = 0
                }
                days.append(UsageHeatmapDay(id: index, date: date, tokens: entry?.tokens, costUsd: entry?.costUsd, level: level))
            }
            weeks.append(UsageHeatmapWeek(id: week, monthLabel: monthLabel, days: days))
        }
        // A window beginning at a month's end can put two labels in adjacent
        // columns. Omit the clipped first-month label rather than overlap text.
        let labeled = weeks.indices.filter { weeks[$0].monthLabel != nil }
        if labeled.count > 1, labeled[1] - labeled[0] < 3 {
            weeks[labeled[0]].monthLabel = nil
        }
        return UsageHeatmap(
            weeks: weeks, startDate: formatter.string(from: start), endDate: formatter.string(from: end), hasMissingDays: hasMissingDays
        )
    }
}
