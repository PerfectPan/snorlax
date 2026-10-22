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
            Text(model.appGroupIdentifier)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            Text(model.appGroupDetail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
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
            Chart(summary.daily) { bar in
                BarMark(
                    x: .value("Day", bar.date),
                    y: .value("Tokens", bar.tokens)
                )
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4))
            }
            .frame(height: 140)
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
