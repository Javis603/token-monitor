import SwiftUI

struct ActivityHeatmap: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.locale) private var locale

    let model: HeatmapModel
    let metric: TrendMetric
    let currency: AppCurrency

    @State private var selectedCell: HeatmapModel.Cell?

    private let cellSize = 12.0
    private let columnWidth = 14.0
    private let cellGap = 2.0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 6) {
                    monthHeader

                    HStack(alignment: .top, spacing: cellGap) {
                        ForEach(model.weeks) { week in
                            VStack(spacing: cellGap) {
                                ForEach(week.cells) { cell in
                                    dayButton(cell)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
            .defaultScrollAnchor(.trailing)
            .scrollIndicators(.hidden)

            if let selectedCell {
                selectedDayCallout(for: selectedCell)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }
        }
        .animation(.snappy(duration: 0.2), value: selectedCell?.date)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "\(model.activeDays) active days. Peak \(metric.label.lowercased()) \(formattedPeak)."
        )
    }

    private var monthHeader: some View {
        HStack(alignment: .bottom, spacing: cellGap) {
            ForEach(model.weeks) { week in
                ZStack(alignment: .leading) {
                    Color.clear

                    if let label = monthLabel(for: week) {
                        Text(label)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .frame(width: columnWidth, height: 16, alignment: .leading)
            }
        }
    }

    private func dayButton(_ cell: HeatmapModel.Cell) -> some View {
        Button {
            selectedCell = selectedCell?.date == cell.date ? nil : cell
        } label: {
            RoundedRectangle(cornerRadius: 3)
                .fill(color(for: cell.intensity))
                .frame(width: cellSize, height: cellSize)
                .overlay {
                    if selectedCell?.date == cell.date {
                        RoundedRectangle(cornerRadius: 3)
                            .stroke(.primary.opacity(0.9), lineWidth: 1.5)
                    }
                }
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .frame(width: columnWidth, height: columnWidth)
        .accessibilityLabel(
            cell.date.formatted(
                .dateTime
                    .weekday(.wide)
                    .month(.wide)
                    .day()
                    .locale(locale)
            )
        )
        .accessibilityValue(accessibilityValue(for: cell))
        .accessibilityAddTraits(
            selectedCell?.date == cell.date ? .isSelected : []
        )
    }

    private func selectedDayCallout(for cell: HeatmapModel.Cell) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "calendar")
                .foregroundStyle(DesignTokens.accent)

            VStack(alignment: .leading, spacing: 1) {
                Text(
                    cell.date,
                    format: .dateTime
                        .weekday(.wide)
                        .month(.wide)
                        .day()
                )
                .font(.footnote.weight(.semibold))

                Text(selectedValue(for: cell))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 4)

            Button("Dismiss", systemImage: "xmark") {
                selectedCell = nil
            }
            .labelStyle(.iconOnly)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.thinMaterial, in: .capsule)
        .accessibilityElement(children: .combine)
    }

    private var formattedPeak: String {
        switch metric {
        case .tokens:
            MetricFormatter.tokens(model.peakValue)
        case .cost:
            MetricFormatter.currencyFromUSD(
                model.peakValue,
                currency: currency
            )
        }
    }

    private func selectedValue(for cell: HeatmapModel.Cell) -> String {
        switch metric {
        case .tokens:
            MetricFormatter.tokens(cell.tokens)
        case .cost:
            MetricFormatter.currencyFromUSD(cell.cost, currency: currency)
        }
    }

    private func accessibilityValue(for cell: HeatmapModel.Cell) -> String {
        selectedValue(for: cell)
    }

    private func monthLabel(for week: HeatmapModel.Week) -> String? {
        guard let date = week.cells.first?.date else {
            return nil
        }

        if week.index > 0,
           let previousDate = model.weeks[week.index - 1].cells.first?.date {
            let calendar = Calendar.autoupdatingCurrent
            let sameYear = calendar.component(.year, from: date)
                == calendar.component(.year, from: previousDate)
            let sameMonth = calendar.component(.month, from: date)
                == calendar.component(.month, from: previousDate)
            if sameYear && sameMonth {
                return nil
            }
        }

        return date.formatted(
            .dateTime
                .month(.abbreviated)
                .locale(locale)
        )
    }

    private func color(for intensity: Int) -> Color {
        switch intensity {
        case 1:
            Color(red: 90 / 255, green: 170 / 255, blue: 1).opacity(0.18)
        case 2:
            Color(red: 120 / 255, green: 190 / 255, blue: 1).opacity(0.45)
        case 3:
            Color(red: 150 / 255, green: 210 / 255, blue: 1).opacity(0.8)
        case 4:
            Color(red: 180 / 255, green: 230 / 255, blue: 1)
        default:
            colorScheme == .dark
                ? .white.opacity(0.035)
                : .black.opacity(0.055)
        }
    }
}
