import SwiftUI

struct DeviceRow: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let device: DeviceSnapshot
    let period: UsagePeriodKey
    var barMaximum: Double? = nil
    var showsDetails = false
    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0
    @ScaledMetric(relativeTo: .subheadline) private var markInset = 26.0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
            layout {
                VStack(alignment: .leading, spacing: 3) {
                    Text(device.displayName).font(DesignTokens.rowTitle)
                        .fixedSize(horizontal: false, vertical: true)
                    if showsDetails {
                        Text(deviceOS).font(.caption2).foregroundStyle(.secondary)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 4) { presence }
                        VStack(alignment: .leading, spacing: 2) { presence }
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                }
                .padding(.leading, markInset)
                .overlay(alignment: .topLeading) { deviceMark }
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: 2) {
                    Text(usage.totalTokens.map { showsDetails ? MetricFormatter.exactTokens($0) : MetricFormatter.tokens($0) } ?? "—")
                        .font(DesignTokens.rowValue)
                    if showsDetails, let cost = usage.costUsd, cost.isFinite {
                        Text(MetricFormatter.usageCostFromUSD(cost, currency: preferences.currency))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .monospacedDigit().fixedSize(horizontal: true, vertical: false)
            }
            if let barMaximum {
                UsageMeter(value: usage.totalTokens, maximum: barMaximum, color: DesignTokens.accent)
            }
        }
        .foregroundStyle(device.stale == true ? .secondary : .primary)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var presence: some View {
        if showsDetails, let received = Date.hubTimestamp(from: device.receivedAt) {
            Text(received, style: .relative)
                .accessibilityLabel("Last sync")
                .accessibilityValue(Text(received, style: .relative))
            if device.stale != nil { Text("·") }
        }
        if let stale = device.stale { Text(stale ? "Offline" : "Online") }
    }

    private var usage: UsagePeriod { device.period(period) }
    private var deviceOS: String {
        [device.osName, device.osVersion].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
    }
    private var deviceMark: some View {
        Group {
            if let asset = DevicePresentation.assetName(for: device.platform) {
                Image(asset).renderingMode(.template).resizable().scaledToFit()
            } else {
                Image(systemName: DevicePresentation.symbol(for: device.platform)).resizable().scaledToFit()
            }
        }
        .frame(width: markSize, height: markSize).accessibilityHidden(true)
    }
}
