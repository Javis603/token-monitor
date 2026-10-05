import SwiftUI

struct ActivityHeatmap: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .caption2) private var monthLabelPadding = 28

    let model: HeatmapModel
    let metric: TrendMetric
    let currency: AppCurrency

    @State private var selectedDate = Calendar.current.startOfDay(for: Date.now)
    @State private var showsDayDetails = false

    private let cellSize = 14.0
    private let columnWidth = 14.0
    private let cellGap = 3.0

    var body: some View {
        let selectedCell = selectedCell
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 6) {
                    monthHeader
                    HStack(alignment: .top, spacing: cellGap) {
                        ForEach(model.weeks) { week in
                            VStack(spacing: cellGap) {
                                ForEach(week.cells) { cell in
                                    dayCell(cell, isSelected: selectedCell?.date == cell.date)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 2)
                .padding(.trailing, monthLabelPadding)
                .accessibilityHidden(true)
            }
            .defaultScrollAnchor(.trailing)
            .scrollIndicators(.hidden)

            DisclosureGroup(isExpanded: $showsDayDetails) {
                if let selectedCell {
                    selectedDayControls(for: selectedCell)
                        .padding(.top, 8)
                }
            } label: {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(model.activeDays) active days")
                        Spacer(minLength: 4)
                        Text("Peak \(formattedPeak)")
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(model.activeDays) active days")
                        Text("Peak \(formattedPeak)")
                    }
                }
                .foregroundStyle(.secondary)
                .frame(minHeight: DesignTokens.controlHeight)
            }
            .font(.caption.monospacedDigit())
            .tint(.secondary)
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: selectedCell?.date)
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

    private var selectableCells: [HeatmapModel.Cell] {
        model.weeks.flatMap(\.cells).filter { !$0.isFuture }
    }

    private var selectedCell: HeatmapModel.Cell? {
        selectableCells.first {
            Calendar.current.isDate($0.date, inSameDayAs: selectedDate)
        } ?? selectableCells.last
    }

    private var selectionRange: ClosedRange<Date> {
        let last = selectableCells.last?.date ?? Calendar.current.startOfDay(for: .now)
        return (selectableCells.first?.date ?? last)...last
    }

    // Dense cells are a visual map; the native date control owns day selection.
    private func dayCell(_ cell: HeatmapModel.Cell, isSelected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(cell.isFuture ? Color.clear : color(for: cell.intensity))
            .frame(width: cellSize, height: cellSize)
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(.primary.opacity(0.9), lineWidth: 1.5)
                }
            }
            .frame(width: columnWidth, height: columnWidth)
    }

    private func selectedDayControls(for cell: HeatmapModel.Cell) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                dayPicker
                Spacer(minLength: 4)
                selectedReading(for: cell)
            }
            VStack(alignment: .leading, spacing: 8) {
                dayPicker
                selectedReading(for: cell)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var dayPicker: some View {
        DatePicker("Date", selection: $selectedDate, in: selectionRange,
                   displayedComponents: .date)
            .datePickerStyle(.compact)
            .labelsHidden()
            .frame(minHeight: DesignTokens.controlHeight)
    }

    private func selectedReading(for cell: HeatmapModel.Cell) -> some View {
        Text(selectedValue(for: cell))
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.secondary)
            .accessibilityLabel(LocalizedStringKey(metric.label))
            .accessibilityValue(selectedValue(for: cell))
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
        if colorScheme == .light, intensity > 0 {
            return Color.blue
                .opacity([0.0, 0.12, 0.24, 0.38, 0.56][min(4, intensity)])
        }
        return switch intensity {
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
