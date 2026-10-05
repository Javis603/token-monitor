import SwiftUI

struct PeriodPicker: View {
    @Binding var selection: UsagePeriodKey

    var body: some View {
        Picker("Period", selection: $selection) {
            ForEach(UsagePeriodKey.allCases) { period in
                Text(LocalizedStringKey(period.shortLabel))
                    .tag(period)
            }
        }
        .pickerStyle(.segmented)
        .sensoryFeedback(.selection, trigger: selection)
    }
}
