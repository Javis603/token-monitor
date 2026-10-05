import SwiftUI

struct DeviceListCard: View {
    let devices: [DeviceSnapshot]
    let period: UsagePeriodKey

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
                SectionHeader("Devices", systemImage: "desktopcomputer")

                if devices.isEmpty {
                    Label("No devices reported", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 10)
                } else {
                    ForEach(devices) { device in
                        DeviceRow(device: device, period: period)
                        if device.id != devices.last?.id {
                            Divider()
                        }
                    }
                }
        }
        .padding(.vertical, 4)
    }
}
