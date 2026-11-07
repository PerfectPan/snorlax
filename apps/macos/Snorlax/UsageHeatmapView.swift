import SnorlaxKit
import SwiftUI

/// Compact contribution calendar: 26–27 week columns inside the 440 pt popover.
struct UsageHeatmapView: View {
    let heatmap: UsageHeatmap
    private let cellSize: CGFloat = 10
    private let gap: CGFloat = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Token activity").font(.headline)
                Spacer()
                Text("180 days").foregroundStyle(.secondary)
            }
            HStack(alignment: .top, spacing: 5) {
                VStack(spacing: gap) {
                    Color.clear.frame(height: 14)
                    ForEach(0..<7) { weekday in
                        Text([1: "Mon", 3: "Wed", 5: "Fri"][weekday] ?? "")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                            .frame(width: 22, height: cellSize, alignment: .leading)
                    }
                }
                .accessibilityHidden(true)
                HStack(alignment: .top, spacing: gap) {
                    ForEach(heatmap.weeks) { week in
                        VStack(spacing: gap) {
                            Color.clear
                                .frame(width: cellSize, height: 14)
                                .overlay(alignment: .leading) {
                                    Text(week.monthLabel ?? "")
                                        .font(.system(size: 9))
                                        .foregroundStyle(.secondary)
                                        .fixedSize()
                                }
                                .accessibilityHidden(true)
                            ForEach(week.days) { day in
                                cell(day)
                            }
                        }
                    }
                }
            }
            HStack(spacing: 4) {
                Text(heatmap.startDate + " – " + heatmap.endDate)
                    .font(.system(size: 9))
                Spacer(minLength: 4)
                Text("Less")
                ForEach(0..<5) { level in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(color(level))
                        .frame(width: cellSize, height: cellSize)
                }
                Text("More")
            }
            .font(.system(size: 9))
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(heatmap.startDate) through \(heatmap.endDate). Darker green means more tokens.")
            if heatmap.hasMissingDays {
                Text("Outlined cells have no data in this snapshot.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func cell(_ day: UsageHeatmapDay) -> some View {
        if day.date == nil {
            Color.clear.frame(width: cellSize, height: cellSize)
                .accessibilityHidden(true)
        } else {
            RoundedRectangle(cornerRadius: 2)
                .fill(day.tokens == nil ? Color.clear : color(day.level))
                .overlay {
                    if day.tokens == nil {
                        RoundedRectangle(cornerRadius: 2)
                            .strokeBorder(.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 0.7, dash: [2, 1]))
                    }
                }
                .frame(width: cellSize, height: cellSize)
                .help(day.detail)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(day.detail)
        }
    }

    private func color(_ level: Int) -> Color {
        if level == 0 { return Color.secondary.opacity(0.12) }
        return Color.green.opacity([0.0, 0.25, 0.45, 0.7, 1.0][min(4, max(1, level))])
    }
}
