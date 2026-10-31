import SwiftUI

/// One text layout owns the complete quota reading. Keeping `%` inside the
/// same run as `left` keeps the percent away from the text run's trailing
/// edge, including when WidgetKit composites the headline.
struct WidgetQuotaValue: View {
    @Environment(\.widgetInk) private var ink
    @ScaledMetric(relativeTo: .largeTitle) private var typeScale = 1
    let column: WidgetWindowColumn
    var size: CGFloat = 32

    var body: some View {
        ViewThatFits(in: .horizontal) {
            reading(size: size * typeScale)
            reading(size: size * typeScale * 0.85)
            reading(size: size * typeScale * 0.7)
        }
    }

    private func reading(size: CGFloat) -> some View {
        var value = AttributedString(column.shortValueText)
        value.font = .system(size: size, weight: .semibold)
        value.foregroundColor = ink.primary
        if column.isPercent {
            if let percent = value.range(of: "%") {
                value[percent].font = .system(size: size * 0.75, weight: .semibold)
            }
            var suffix = AttributedString(" left")
            suffix.font = .caption
            suffix.foregroundColor = ink.secondary
            value.append(suffix)
        }
        return Text(value)
            .monospacedDigit()
            .fixedSize(horizontal: true, vertical: true)
    }
}
