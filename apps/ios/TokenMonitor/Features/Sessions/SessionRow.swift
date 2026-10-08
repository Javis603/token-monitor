import SwiftUI

struct SessionRow: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: SessionUsage
    let sessionKey: String
    let maximum: Double
    let now: Date
    @State private var showsModels = false
    @State private var showsTitle = false
    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0
    @ScaledMetric(relativeTo: .subheadline) private var markInset = 26.0

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.rowBarSpacing) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
            layout {
                VStack(alignment: .leading, spacing: DesignTokens.rowLineSpacing) {
                    Button { showsTitle = true } label: {
                        Text(session.displayTitle ?? clientName)
                            .font(DesignTokens.rowTitle)
                            .lineLimit(1).truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .popover(isPresented: $showsTitle) {
                        Text(session.displayTitle ?? clientName)
                            .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                            .padding(16).frame(idealWidth: 280, maxWidth: 280, alignment: .leading)
                            .presentationCompactAdaptation(.popover)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if session.displayTitle != nil { Text(clientName) }
                        if !session.modelEntries.isEmpty {
                            if session.displayTitle != nil { Text("·") }
                            modelLabel
                        }
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                    Text(activity).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                        .minimumScaleFactor(0.9)
                    if session.displayTitle == nil {
                        Text(session.sessionId ?? sessionKey)
                            .font(.caption2).foregroundStyle(.tertiary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, markInset)
                .overlay(alignment: .topLeading) {
                    ProviderMark(provider: session.client, size: markSize)
                        .overlay(alignment: .bottomTrailing) {
                            if session.isRunning(at: now) {
                                Circle().fill(.mint).frame(width: 5, height: 5)
                                    .overlay { Circle().stroke(.background, lineWidth: 1) }
                                    .accessibilityHidden(true)
                            }
                        }
                }
                metrics
            }
            UsageMeter(value: session.measuredTokens, maximum: maximum,
                       color: ClientPresentation.color(for: session.client ?? "unknown"))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private var clientName: String { ClientPresentation.displayName(for: session.client ?? "unknown") }
    private var activity: String {
        var parts: [String] = []
        if session.isArchived { parts.append(String(localized: "Archived")) }
        if let date = session.lastActivity {
            let time = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
                .locale(Locale(identifier: "en_US_POSIX"))
            parts.append(date.formatted(Calendar.current.isDate(date, inSameDayAs: now)
                                        ? time : time.month(.twoDigits).day(.twoDigits)))
        }
        if let count = session.messageCount, count > 0 {
            parts.append("\(MetricFormatter.exactTokens(Double(count))) \(count == 1 ? "call" : "calls")")
        }
        if let percent = session.cacheHitPercent {
            parts.append(percent > 0 && percent < 1 ? "<1%" : MetricFormatter.percent(percent))
        }
        if session.measuredTokens != nil, let speed = session.outputTokensPerSecond, speed.rounded() > 0 {
            parts.append("\(MetricFormatter.tokens(speed.rounded())) tok/s")
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var modelLabel: some View {
        if session.modelEntries.count > 1 {
            Button { showsModels = true } label: {
                Text("\(session.modelEntries.count) models").underline(color: .secondary)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showsModels) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Models").font(DesignTokens.rowTitle)
                        ForEach(session.modelEntries) { model in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(model.id).font(.footnote).fixedSize(horizontal: false, vertical: true)
                                HStack {
                                    Text(MetricFormatter.exactTokens(model.value))
                                    Spacer()
                                    let total = max(session.measuredTokens ?? 0, session.modelEntries.reduce(0) { $0 + $1.value })
                                    Text(MetricFormatter.percent(UsageRowPresentation.share(model.value, total: total) * 100))
                                }.font(.caption).monospacedDigit().foregroundStyle(.secondary)
                            }
                        }
                    }.padding(16)
                }
                .frame(idealWidth: 280, maxWidth: 280, idealHeight: 240, maxHeight: 320)
                .presentationCompactAdaptation(.popover)
            }
        } else if let model = session.modelEntries.first {
            Text(model.id).lineLimit(1).truncationMode(.tail)
        }
    }

    private var metrics: some View {
        VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: DesignTokens.rowLineSpacing) {
            if let tokens = session.measuredTokens {
                Text(MetricFormatter.exactTokens(tokens)).font(DesignTokens.rowValue)
            } else {
                Text("Tokens unavailable").font(.footnote).foregroundStyle(.secondary)
            }
            if session.measuredTokens != nil, let cost = session.costUsd, cost.isFinite, cost >= 0 {
                Text(MetricFormatter.usageCostFromUSD(cost, currency: preferences.currency))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            SessionStatusView(session: session, now: now)
        }
        .monospacedDigit().fixedSize(horizontal: true, vertical: false)
    }
}
