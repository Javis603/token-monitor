import SwiftUI

/// Compact desktop context gauge; cache takes its place once context is no longer live.
struct SessionStatusView: View {
    let session: SessionUsage
    let now: Date
    @State private var showsDetails = false
    @ScaledMetric(relativeTo: .caption2) private var meterWidth = 16.0
    @ScaledMetric(relativeTo: .caption2) private var statusFontSize = 9.0

    private var used: Double? { session.contextUsedPercent(at: now) }
    private var minutes: Int? { session.cacheMinutesRemaining(at: now) }
    private var tone: Color { (used ?? 0) >= 90 ? DesignTokens.contextLow : (used ?? 0) >= 70 ? DesignTokens.contextCaution : .secondary }

    var body: some View {
        if used != nil || minutes != nil {
            Button { showsDetails = true } label: {
                HStack(spacing: 4) {
                    if let used {
                        Capsule().fill(tone.opacity(0.16))
                            .overlay(alignment: .leading) {
                                Capsule().fill(tone).frame(width: meterWidth * min(1, max(0, used / 100)))
                            }
                            .frame(width: meterWidth, height: 3)
                            .accessibilityHidden(true)
                        Text(MetricFormatter.percent(used))
                    } else if let minutes {
                        Text("Cache \(minutes)m")
                    }
                }
                .font(.system(size: statusFontSize)).foregroundStyle(tone).monospacedDigit()
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(used != nil ? Text("Context used") : Text("Prompt cache estimate"))
            .accessibilityValue(used.map { MetricFormatter.percent($0) } ?? minutes.map { "Cache \($0)m" } ?? "")
            .popover(isPresented: $showsDetails) {
                VStack(alignment: .leading, spacing: 10) {
                    PopoverHeader(used != nil ? "Context used" : "Prompt cache estimate")
                    if let used {
                        Text(MetricFormatter.percent(used)).font(.subheadline.monospacedDigit())
                    }
                    if let tokens = session.contextTokens, let window = session.contextWindow, tokens > 0, window > 0 {
                        Text("\(MetricFormatter.exactTokens(tokens)) / \(MetricFormatter.exactTokens(window)) tokens")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let minutes {
                        Text("Cache \(minutes)m").font(.subheadline.monospacedDigit())
                        Text("Estimated from the latest cached request.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(16).frame(idealWidth: 260, maxWidth: 280, alignment: .leading)
                .presentationCompactAdaptation(.popover)
            }
        }
    }
}
