import SwiftUI

struct DevicesView: View {
    @Environment(TokenMonitorStore.self) private var store

    var body: some View {
        @Bindable var store = store
        ZStack {
            AppBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: DesignTokens.sectionSpacing) {
                    PeriodPicker(selection: $store.selectedPeriod)
                    if devices.isEmpty {
                        ContentUnavailableView("No devices reported", systemImage: "desktopcomputer")
                    } else {
                        SurfaceCard {
                            VStack(alignment: .leading, spacing: 14) {
                                ForEach(Array(devices.enumerated()), id: \.element.id) { index, device in
                                    if index > 0 { Divider() }
                                    DeviceRow(device: device, period: store.selectedPeriod,
                                              barMaximum: maximum, showsDetails: true)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, DesignTokens.screenPadding)
                .padding(.top, 8)
                .padding(.bottom, DesignTokens.sectionSpacing)
            }
            .refreshable { await store.refresh() }
        }
        .navigationTitle("Devices")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var devices: [DeviceSnapshot] { store.stats?.usageDevices(for: store.selectedPeriod) ?? [] }
    private var maximum: Double {
        UsageRowPresentation.maximum(devices.map { $0.period(store.selectedPeriod).totalTokens })
    }
}
