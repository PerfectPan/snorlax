import Foundation

/// One of the snapshot windows the menu and the widget show (today, 7 days, 30 days).
public struct DayWindowModel: Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var tokensText: String
    public var costText: String
    public var requests: Int
    public var unpricedRequests: Int
    public var tokens: Int

    public var costLabel: String {
        UsageFormat.costLabel(costText: costText, requests: requests, unpricedRequests: unpricedRequests)
    }
}

/// One row in a top-agents, top-models, or devices list, ordered by today's tokens.
public struct RankedUsage: Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var tokensText: String
    public var costText: String
    public var requests: Int
    public var unpricedRequests: Int
    public var tokens: Int
    public var isThisDevice: Bool

    public var costLabel: String {
        UsageFormat.costLabel(costText: costText, requests: requests, unpricedRequests: unpricedRequests)
    }

    /// The device list marks which row is this Mac — but not when the name
    /// already says it.
    public var listLabel: String {
        isThisDevice && name != "This Mac" ? "\(name) · this Mac" : name
    }
}

/// One bar of the 30-day chart. `day` is the bar's date as the start of that
/// local day in the snapshot's time zone (R8); nil when the date is unparseable.
public struct DailyBar: Equatable, Identifiable, Sendable {
    public var id: String
    public var date: String
    public var day: Date?
    public var tokens: Int
}

/// Everything the menu popover renders from one snapshot.
public struct UsageSummary: Equatable, Sendable {
    public var menuTitle: String
    public var windows: [DayWindowModel]
    public var topAgents: [RankedUsage]
    public var topModels: [RankedUsage]
    public var devices: [RankedUsage]
    public var daily: [DailyBar]
    /// Zone the snapshot cut its days in; the chart axis labels use it too.
    public var timeZone: TimeZone
    public var statusLine: String
}

public enum UsageSummaryBuilder {
    /// How many agent and model rows the popover shows. The widget takes the first three agents.
    public static let popoverLimit = 5
    public static let widgetAgentLimit = 3

    /// - Parameters:
    ///   - now: relative scan and sync times are measured against it.
    ///   - timeZone: zone of the device showing the summary, for old timestamps.
    public static func make(_ snapshot: Snapshot, now: Date = Date(), timeZone: TimeZone = .current) -> UsageSummary {
        let zone = TimeZone(identifier: snapshot.timeZone) ?? timeZone
        let windows = [
            window(snapshot.totals.today, id: "today", title: "Today"),
            window(snapshot.totals.last7D, id: "last7d", title: "7 days"),
            window(snapshot.totals.last30D, id: "last30d", title: "30 days")
        ]
        return UsageSummary(
            menuTitle: windows[0].tokensText,
            windows: windows,
            topAgents: ranked(agentRows(snapshot.byAgent)),
            topModels: ranked(modelRows(snapshot.byModel)),
            devices: ranked(deviceRows(snapshot.byDevice)),
            daily: snapshot.daily.map { entry in
                DailyBar(id: entry.date, date: entry.date, day: UsageFormat.dayDate(entry.date, timeZone: zone), tokens: entry.tokens)
            },
            timeZone: zone,
            statusLine: statusLine(snapshot.status, now: now, timeZone: timeZone)
        )
    }

    /// Last scan, last sync, and decode failures per agent, as relative times
    /// (plan 4.2). Older than a week shows the local date-time instead.
    public static func statusLine(
        _ status: SnapshotStatus,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> String {
        let scan = status.lastScanAt.flatMap { UsageFormat.instantText($0, now: now, timeZone: timeZone) } ?? "—"
        let syncAt = status.sync.at.flatMap { UsageFormat.instantText($0, now: now, timeZone: timeZone) }
            .map { " at \($0)" } ?? ""
        let failures = status.failuresByAgent.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }
        let failureText = failures.isEmpty ? "no failures" : failures.joined(separator: ", ")
        return "Last scan \(scan) · sync \(status.sync.state.rawValue)\(syncAt) · \(failureText)"
    }

    private static func window(_ total: WindowTotal, id: String, title: String) -> DayWindowModel {
        DayWindowModel(
            id: id,
            title: title,
            tokensText: UsageFormat.shortTokens(total.tokens),
            costText: UsageFormat.cost(total.costUsd),
            requests: total.requests,
            unpricedRequests: total.unpricedRequests,
            tokens: total.tokens
        )
    }

    /// The windows show today (R5), so a row with no usage today is noise.
    private static func agentRows(_ entries: [ByAgent]) -> [RankedUsage] {
        entries.compactMap { entry in
            guard entry.today.tokens > 0 else { return nil }
            return rankedRow(id: entry.agent, name: entry.agent, total: entry.today, isThisDevice: false)
        }
    }

    private static func modelRows(_ entries: [ByModel]) -> [RankedUsage] {
        entries.compactMap { entry in
            guard entry.today.tokens > 0 else { return nil }
            return rankedRow(id: entry.model, name: entry.model, total: entry.today, isThisDevice: false)
        }
    }

    private static func deviceRows(_ entries: [ByDevice]) -> [RankedUsage] {
        let rows = entries.compactMap { entry -> RankedUsage? in
            guard entry.today.tokens > 0 else { return nil }
            let rawName = entry.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let name: String
            if !rawName.isEmpty {
                name = rawName
            } else if entry.isThisDevice {
                name = "This Mac"
            } else {
                name = String(entry.deviceId.prefix(8))
            }
            return rankedRow(id: entry.deviceId, name: name, total: entry.today, isThisDevice: entry.isThisDevice)
        }
        // Checked after the zero filter: a remote device with no usage today
        // must not leave a one-line Devices section repeating the totals above.
        if rows.count == 1, rows[0].isThisDevice {
            return []
        }
        return rows
    }

    private static func rankedRow(id: String, name: String, total: WindowTotal, isThisDevice: Bool) -> RankedUsage {
        RankedUsage(
            id: id,
            name: name,
            tokensText: UsageFormat.shortTokens(total.tokens),
            costText: UsageFormat.cost(total.costUsd),
            requests: total.requests,
            unpricedRequests: total.unpricedRequests,
            tokens: total.tokens,
            isThisDevice: isThisDevice
        )
    }

    private static func ranked(_ rows: [RankedUsage]) -> [RankedUsage] {
        rows.sorted { lhs, rhs in
            if lhs.tokens != rhs.tokens { return lhs.tokens > rhs.tokens }
            return lhs.name < rhs.name
        }
    }
}
