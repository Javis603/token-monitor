import SwiftUI

struct DeviceListCard: View {
    let devices: [DeviceSnapshot]
    let period: UsagePeriodKey

    var body: some View {
        if devices.isEmpty {
            Label("No devices reported", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
                .font(.subheadline).foregroundStyle(.secondary)
        } else {
            let active = devices.filter { ($0.period(period).totalTokens ?? 0) > 0 }
            VStack(alignment: .leading, spacing: 14) {
                if active.isEmpty {
                    Text("No device usage in this period").font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(Array(active.prefix(4).enumerated()), id: \.element.id) { index, device in
                    if index > 0 { Divider() }
                    DeviceRow(device: device, period: period)
                }

            }
        }
    }
}
