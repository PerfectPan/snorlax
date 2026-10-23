import AppKit
import Charts
import SnorlaxKit
import SwiftUI

struct PopoverView: View {
    @ObservedObject var model: MenuModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let nodeHint = model.nodeHint {
                Text(nodeHint)
                    .font(.headline)
            }
            if let loadError = model.loadError {
                Text(loadError)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            if let summary = model.summary {
                usage(summary)
            } else if model.loadError == nil {
                Text("No snapshot yet.")
                    .foregroundStyle(.secondary)
            }
            if let refreshError = model.refreshError {
                Text(refreshError)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            Divider()
            HStack {
                Button(model.refreshing ? "Refreshing…" : "Refresh now") {
                    model.refreshNow()
                }
                .disabled(model.refreshing)
                Button("Settings") {
                    openWindow(id: "settings")
                }
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
        .padding(16)
        .frame(width: 440)
        .onAppear {
            model.reloadSnapshot()
        }
    }

    @ViewBuilder
    private func usage(_ summary: UsageSummary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(summary.windows) { window in
                VStack(alignment: .leading, spacing: 2) {
                    Text(window.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(window.tokensText)
                        .font(.title3)
                    Text(window.costLabel)
                        .font(.caption)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        section("Agents", rows: Array(summary.topAgents.prefix(UsageSummaryBuilder.popoverLimit)))
        section("Models", rows: Array(summary.topModels.prefix(UsageSummaryBuilder.popoverLimit)))
        section("Devices", rows: Array(summary.devices.prefix(UsageSummaryBuilder.popoverLimit)), markThisDevice: true)
        if summary.daily.isEmpty {
            Text("No daily totals yet.")
                .foregroundStyle(.secondary)
        } else {
            let bars = summary.daily.compactMap { bar in bar.day.map { (day: $0, tokens: bar.tokens) } }
            Chart(bars, id: \.day) { bar in
                BarMark(
                    x: .value("Day", bar.day, unit: .day),
                    y: .value("Tokens", bar.tokens)
                )
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 7)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let date = value.as(Date.self) {
                            Text(UsageFormat.dayLabel(date, timeZone: summary.timeZone))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let tokens = value.as(Int.self) {
                            Text(UsageFormat.shortTokens(tokens))
                        }
                    }
                }
            }
            .frame(height: 140)
            // Bars and ticks land on the snapshot's own days, not the Mac's zone (R8).
            .environment(\.timeZone, summary.timeZone)
            .accessibilityLabel("Tokens for the last 30 days")
        }
        Text(summary.statusLine)
            .font(.caption)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
    }

    @ViewBuilder
    private func section(_ title: String, rows: [RankedUsage], markThisDevice: Bool = false) -> some View {
        if !rows.isEmpty {
            Text(title)
                .font(.headline)
            ForEach(rows) { row in
                HStack {
                    Text(markThisDevice && row.isThisDevice ? "\(row.name) · this Mac" : row.name)
                    Spacer()
                    Text(row.tokensText)
                    Text(row.costLabel)
                        .foregroundStyle(.secondary)
                }
                .font(.callout)
            }
        }
    }
}
