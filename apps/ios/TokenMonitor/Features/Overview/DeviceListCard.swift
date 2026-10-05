import SwiftUI

/// Card content: one row per reporting device. The "Devices" SectionHeader sits
/// above the card at the call site.
struct DeviceListCard: View {
    let devices: [DeviceSnapshot]
    let period: UsagePeriodKey

    var body: some View {
        if devices.isEmpty {
            Label("No devices reported", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(devices.enumerated()), id: \.element.id) { index, device in
                    if index > 0 {
                        Divider()
                    }
                    DeviceRow(device: device, period: period)
                }
            }
        }
    }
}
