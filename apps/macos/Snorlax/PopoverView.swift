import AppKit
import SnorlaxKit
import SwiftUI

struct PopoverView: View {
    @ObservedObject var model: MenuModel
    @ObservedObject private var pricingRebuild: PricingRebuildModel
    @State private var confirmingRebuild = false
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss

    init(model: MenuModel) {
        self.model = model
        pricingRebuild = model.pricingRebuild
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let nodeHint = model.nodeHint {
                VStack(alignment: .leading, spacing: 6) {
                    Text(nodeHint)
                        .font(.headline)
                    Button(model.discoveringNode ? "Checking…" : "Try again") {
                        model.retryNodeDiscovery()
                    }
                    .disabled(model.discoveringNode)
                }
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
            if let notice = model.pricingNotice {
                Label(notice, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .textSelection(.enabled)
            }
            if model.pricingNotice != nil || pricingRebuild.running {
                Button {
                    confirmingRebuild = true
                } label: {
                    HStack(spacing: 6) {
                        if pricingRebuild.running {
                            ProgressView().controlSize(.small)
                        }
                        Text(pricingRebuild.running ? "Rebuilding…" : "Rebuild last 180 days…")
                    }
                }
                .disabled(pricingRebuild.running || model.refreshing)
            }
            if let notice = pricingRebuild.notice {
                Text(notice)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            if let refreshError = model.refreshError {
                Text(refreshError)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            Divider()
            HStack {
                Button {
                    model.refreshNow()
                } label: {
                    HStack(spacing: 6) {
                        if model.refreshing {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(model.refreshing ? "Refreshing…" : "Refresh now")
                    }
                }
                .disabled(model.refreshing || pricingRebuild.running)
                Button("Settings") {
                    // The menu bar panel does not close on its own and floats above
                    // normal windows, so it would cover Settings. It also does not
                    // activate this LSUIElement app, and openWindow orders the window
                    // front only among this app's windows, so without activation
                    // Settings stays behind the frontmost app.
                    dismiss()
                    NSApplication.shared.activate()
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
        .alert("Rebuild the last 180 days?", isPresented: $confirmingRebuild) {
            Button("Cancel", role: .cancel) {}
            Button("Rebuild", role: .destructive) {
                guard !model.refreshing else { return }
                Task { await pricingRebuild.rebuild() }
            }
        } message: {
            Text("This replaces the last 180 days of local usage from the logs still on this Mac. Deleted logs cannot be recovered: their previously recorded usage will be removed. If paired, those changes also replace totals on other devices. This can take several minutes. Closing the menu does not stop it.")
        }
        .onAppear {
            model.reloadSnapshot()
            model.loadDeviceName()
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
        if let heatmap = summary.heatmap {
            UsageHeatmapView(heatmap: heatmap)
        } else {
            Text("Daily activity is unavailable.")
                .foregroundStyle(.secondary)
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
                    Text(markThisDevice ? row.listLabel : row.name)
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
