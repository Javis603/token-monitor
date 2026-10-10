import SwiftUI

struct PeriodPicker: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Binding var selection: UsagePeriodKey
    var compact = false
    var periods: [UsagePeriodKey] = UsagePeriodKey.allCases
    @ScaledMetric(relativeTo: .caption) private var segmentWidth = 68

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                picker.pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if compact {
                picker.pickerStyle(.segmented)
                    .frame(width: segmentWidth * Double(periods.count))
                    .frame(minHeight: DesignTokens.controlHeight)
            } else {
                picker.pickerStyle(.segmented)
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
    }

    private var picker: some View {
        Picker("Period", selection: $selection) {
            ForEach(periods) { period in
                Text(LocalizedStringKey(period.shortLabel)).tag(period)
            }
        }
    }
}
