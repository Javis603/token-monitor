import SwiftUI

struct PeriodPicker: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Binding var selection: UsagePeriodKey

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                picker.pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
