import Foundation

/// One of the snapshot windows the menu and the widget show (today, 7 days, 30 days).
public struct DayWindowModel: Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var tokensText: String
    public var costText: String
    public var unpriced: Bool
    public var tokens: Int

    public var costLabel: String {
        unpriced ? "\(costText) unpriced" : costText
    }
}

/// One row in a top-agents, top-models, or devices list, ordered by today's tokens.
public struct RankedUsage: Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var tokensText: String
    public var costText: String
    public var unpriced: Bool
    public var tokens: Int
    public var isThisDevice: Bool

    public var costLabel: String {
        unpriced ? "\(costText) unpriced" : costText
    }
}

/// One bar of the 30-day chart. `tokens` is the snapshot's daily total, not the short form.
public struct DailyBar: Equatable, Identifiable, Sendable {
    public var id: String
    public var date: String
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
    public var statusLine: String
}

public enum UsageSummaryBuilder {
    /// How many agent and model rows the popover shows. The widget takes the first three agents.
    public static let popoverLimit = 5
    public static let widgetAgentLimit = 3

    public static func make(_ snapshot: Snapshot) -> UsageSummary {
        let windows = [
            window(snapshot.totals.today, id: "today", title: "Today"),
            window(snapshot.totals.last7D, id: "last7d", title: "7 days"),
            window(snapshot.totals.last30D, id: "last30d", title: "30 days")
        ]
        return UsageSummary(
            menuTitle: windows[0].tokensText,
            windows: windows,
            topAgents: ranked(snapshot.byAgent.map { entry in
                rankedRow(id: entry.agent, name: entry.agent, total: entry.today, isThisDevice: false)
            }),
            topModels: ranked(snapshot.byModel.map { entry in
                rankedRow(id: entry.model, name: entry.model, total: entry.today, isThisDevice: false)
            }),
            devices: ranked(snapshot.byDevice.map { entry in
                let rawName = entry.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return rankedRow(
                    id: entry.deviceId,
                    name: rawName.isEmpty ? entry.deviceId : rawName,
                    total: entry.today,
                    isThisDevice: entry.isThisDevice
                )
            }),
            daily: snapshot.daily.map { DailyBar(id: $0.date, date: $0.date, tokens: $0.tokens) },
            statusLine: statusLine(snapshot.status)
        )
    }

    /// Last scan, last sync, and decode failures per agent (plan 4.2). Timestamps stay as written.
    public static func statusLine(_ status: SnapshotStatus) -> String {
        let scan = status.lastScanAt ?? "—"
        let syncAt = status.sync.at.map { " at \($0)" } ?? ""
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
            unpriced: total.unpricedRequests > 0,
            tokens: total.tokens
        )
    }

    private static func rankedRow(id: String, name: String, total: WindowTotal, isThisDevice: Bool) -> RankedUsage {
        RankedUsage(
            id: id,
            name: name,
            tokensText: UsageFormat.shortTokens(total.tokens),
            costText: UsageFormat.cost(total.costUsd),
            unpriced: total.unpricedRequests > 0,
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
