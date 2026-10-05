import SwiftUI

struct DeviceRow: View {
    let device: DeviceSnapshot
    let period: UsagePeriodKey

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: DevicePresentation.symbol(for: device.platform))
                .font(.headline)
                .foregroundStyle(device.stale == true ? .secondary : DesignTokens.accent)
                .frame(width: 34, height: 34)
                .background(.quaternary, in: .circle)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(device.displayName)
                    .bold()
                    .lineLimit(1)

                Text(deviceSubtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(MetricFormatter.tokens(device.period(period).totalTokens ?? 0))
                .bold()
                .monospacedDigit()
        }
        .accessibilityElement(children: .combine)
    }

    private var deviceSubtitle: String {
        if device.stale == true {
            return "Offline"
        }
        return [device.osName, device.osVersion]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
