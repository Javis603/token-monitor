import SwiftUI

struct ModelLiveRatesView: View {
    @Environment(TokenMonitorStore.self) private var store

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let reading = store.liveModelOutputRate(at: context.date)
            VStack(alignment: .leading, spacing: 12) {
                Text("Live speed").font(.headline)
                if let reading, !reading.devices.isEmpty {
                    ForEach(reading.devices) { device in
                        if reading.deviceCount > 1 {
                            Text(device.name).font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(device.models) { model in
                            ViewThatFits(in: .horizontal) {
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(model.id).font(.subheadline)
                                    Spacer(minLength: 8)
                                    speed(model.tokensPerSecond)
                                }
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(model.id).font(.subheadline)
                                    speed(model.tokensPerSecond)
                                }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                } else {
                    Text(String(localized: "No live model timing available", table: "AppAlignment"))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Text(String(localized: "Live speed uses consecutive timed output samples. It is separate from the selected period’s average.", table: "AppAlignment"))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func speed(_ value: Double) -> some View {
        Text(verbatim: value.formatted(.number.precision(.fractionLength(0...1))) + " tok/s")
            .font(.subheadline.monospacedDigit())
    }
}
