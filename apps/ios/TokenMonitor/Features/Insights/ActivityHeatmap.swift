import SwiftUI
import UIKit

/// The activity card body: a readout line, a width-filling weekday × week grid
/// you can scrub, and a Less → More legend. The model comes from the caller so
/// the section header can report the same active-day count.
struct ActivityHeatmap: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let model: HeatmapModel
    let metric: TrendMetric
    let currency: AppCurrency

    @State private var selectedDay: Date?
    /// The selection when the current gesture began; a tap on the already
    /// selected cell clears it.
    @State private var dragStartSelection: Date?
    @State private var isDragging = false
    @State private var gridWidth = 0.0
    @State private var selectionFeedback = UISelectionFeedbackGenerator()

    private let cellGap = 3.0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            readout

            VStack(alignment: .leading, spacing: 4) {
                monthHeader
                grid
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: Double.self) { proxy in
                proxy.size.width
            } action: { width in
                gridWidth = width
            }

            legend
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: selectedDay)
        .task {
            #if DEBUG
            guard ProcessInfo.processInfo.arguments.contains("--sample-heatmap-select") else { return }
            selectedDay = model.weeks.flatMap(\.cells)
                .filter(\.hasData)
                .max { $0.tokens < $1.tokens }?.date
            #endif
        }
    }

    // MARK: - Readout

    @ViewBuilder
    private var readout: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let cell = selectedCell {
                Text(selectedReadout(for: cell))
                    .font(.subheadline.monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 4)
                Button {
                    selectedDay = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear selection")
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(verbatim: "\(rangeLabel) · ")
                    Text("\(model.activeDays) active days")
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            }
        }
        .frame(minHeight: 20)
    }

    private var rangeLabel: String {
        let weekCount = model.weeks.count
        if weekCount >= 50 {
            return String(localized: "Past year")
        }
        return String(localized: "Past \(weekCount) weeks")
    }

    private var selectedCell: HeatmapModel.Cell? {
        selectedDay.flatMap { model.cell(on: $0) }
    }

    private func selectedReadout(for cell: HeatmapModel.Cell) -> String {
        var parts = [
            cell.date.formatted(
                .dateTime.weekday(.abbreviated).month(.abbreviated).day()
                    .locale(locale)
            )
        ]
        if cell.tokens.isFinite {
            parts.append(String(localized: "\(MetricFormatter.tokens(cell.tokens)) tokens"))
        }
        if cell.cost.isFinite {
            parts.append(
                MetricFormatter.currencyFromUSD(cell.cost, currency: currency)
            )
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - Grid

    private var cellWidth: Double {
        HeatmapModel.cellSize(
            forWidth: gridWidth,
            columns: model.weeks.count,
            gap: cellGap
        )
    }

    private var monthHeader: some View {
        HStack(spacing: cellGap) {
            ForEach(model.weeks) { week in
                ZStack(alignment: .leading) {
                    if let label = monthLabel(for: week) {
                        Text(label)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .frame(width: cellWidth, height: 14, alignment: .leading)
            }
        }
        .accessibilityHidden(true)
    }

    private var grid: some View {
        HStack(alignment: .top, spacing: cellGap) {
            ForEach(model.weeks) { week in
                VStack(spacing: cellGap) {
                    ForEach(week.cells) { cell in
                        dayCell(cell)
                    }
                }
            }
        }
        .contentShape(.rect)
        .gesture(scrub)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Activity heatmap"))
        .accessibilityValue(Text(verbatim: accessibilityReadout))
        .accessibilityAdjustableAction { direction in
            stepSelection(direction)
        }
    }

    private func dayCell(_ cell: HeatmapModel.Cell) -> some View {
        let isSelected = selectedCell?.date == cell.date
        let isToday = Calendar.current.isDateInToday(cell.date)
        return RoundedRectangle(cornerRadius: 3)
            .fill(cell.isFuture ? Color.clear : color(for: cell.intensity))
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(.primary.opacity(0.9), lineWidth: 1.5)
                } else if isToday {
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(.secondary.opacity(0.6), lineWidth: 0.75)
                }
            }
            .frame(width: cellWidth, height: cellWidth)
    }

    private var scrub: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if !isDragging {
                    isDragging = true
                    dragStartSelection = selectedDay
                    selectionFeedback.prepare()
                }
                if let cell = cell(at: value.location) {
                    select(cell.date)
                }
            }
            .onEnded { value in
                isDragging = false
                let start = dragStartSelection
                dragStartSelection = nil
                let moved = abs(value.translation.width) > 4
                    || abs(value.translation.height) > 4
                guard !moved,
                      let cell = cell(at: value.location),
                      let start,
                      Calendar.current.isDate(cell.date, inSameDayAs: start) else {
                    return
                }
                selectedDay = nil
            }
    }

    private func cell(at point: CGPoint) -> HeatmapModel.Cell? {
        let pitch = cellWidth + cellGap
        let column = Int(floor(point.x / pitch))
        let row = Int(floor(point.y / pitch))
        guard let cell = model.cell(atColumn: column, row: row), !cell.isFuture else {
            return nil
        }
        return cell
    }

    private func stepSelection(_ direction: AccessibilityAdjustmentDirection) {
        let days = model.weeks.flatMap(\.cells).filter { !$0.isFuture }
        guard !days.isEmpty else { return }
        let index = selectedDay.flatMap { date in
            days.firstIndex { Calendar.current.isDate($0.date, inSameDayAs: date) }
        }
        switch direction {
        case .increment:
            select(days[min(days.count - 1, (index ?? days.count - 1) + 1)].date)
        case .decrement:
            select(days[max(0, (index ?? days.count) - 1)].date)
        @unknown default:
            break
        }
    }

    private func select(_ date: Date) {
        guard selectedDay != date else { return }
        selectedDay = date
        selectionFeedback.selectionChanged()
        selectionFeedback.prepare()
    }

    private var accessibilityReadout: String {
        if let cell = selectedCell {
            return selectedReadout(for: cell)
        }
        return String(localized: "\(model.activeDays) active days")
    }

    // MARK: - Legend + colours

    private var legend: some View {
        HStack(spacing: 4) {
            Spacer()
            Text("Less")
            ForEach(0...4, id: \.self) { level in
                RoundedRectangle(cornerRadius: 2)
                    .fill(color(for: level))
                    .frame(width: 8, height: 8)
            }
            Text("More")
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
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
        guard intensity > 0 else {
            return Color(uiColor: .quaternarySystemFill)
        }
        if colorScheme == .light {
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
        default:
            Color(red: 180 / 255, green: 230 / 255, blue: 1)
        }
    }
}
