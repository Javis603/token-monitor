import SwiftUI

struct PeriodPicker: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Binding var selection: UsagePeriodKey
    var compact = false
    @ScaledMetric(relativeTo: .caption) private var compactWidth = 216

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                picker.pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if compact {
                picker.pickerStyle(.segmented)
                    .frame(width: compactWidth)
                    .frame(minHeight: DesignTokens.controlHeight)
            } else {
                picker.pickerStyle(.segmented)
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
    }

    private var picker: some View {
        Picker("Period", selection: $selection) {
            ForEach(UsagePeriodKey.allCases) { period in
                Text(LocalizedStringKey(period.shortLabel)).tag(period)
            }
        }
    }
}
