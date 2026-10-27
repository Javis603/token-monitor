import SwiftUI

/// A folded conversation group: the header quotes the latest
/// same-conversation row, the meter sums every member once, and expanding
/// lists mains (continuations of the header conversation) then subagents —
/// the same sections the desktop group page shows.
struct SessionGroupRow: View {
    let entry: SessionListEntry
    let maximum: Double
    let now: Date
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var expanded = false
    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0
    @ScaledMetric(relativeTo: .subheadline) private var markInset = 26.0

    private var display: SessionUsage? { entry.session }
    private var mains: [SessionListEntry.Member] { entry.members.filter(\.isMain) }
    private var subagents: [SessionListEntry.Member] { entry.members.filter { !$0.isMain } }

    /// One merged model readout for the group, like the desktop group row's
    /// rebuilt `modelLabel` — heaviest model or "N models" across all members.
    private var modelEntries: [BreakdownEntry] {
        var merged: [String: Double] = [:]
        for member in entry.members {
            for (model, tokens) in member.session.models ?? [:] {
                merged[model, default: 0] += tokens
            }
        }
        return merged.filter { !$0.key.isEmpty && $0.value.isFinite && $0.value > 0 }
            .map { BreakdownEntry(id: $0.key, value: $0.value, cost: 0) }
            .sorted { $0.value == $1.value ? $0.id < $1.id : $0.value > $1.value }
    }

    private var groupState: SessionActivityState { entry.activityState(at: now) }

    private var clientName: String {
        ClientPresentation.displayName(for: display?.client ?? "unknown")
    }

    private var modelLabel: String? {
        switch modelEntries.count {
        case 0: return nil
        case 1: return modelEntries[0].id
        default: return String(localized: "\(modelEntries.count) models")
        }
    }

    private var titled: Bool { display?.displayTitle != nil }

    /// Tool and model joined for one line — the group's merged model readout.
    private var identity: String {
        ([clientName, modelLabel, display?.displayReasoningEffort].compactMap { $0 }).joined(separator: " · ")
    }

    /// The line under the title: `client · model · N subagents` for a titled
    /// group, `time · calls · % · tok/s · N subagents` for an untitled one —
    /// the same strings the desktop group row puts in `subtitle`, with the
    /// count underlined like the "N models" affordance since it expands.
    private var subtitleBase: String {
        titled ? identity : (display?.activitySummary(now: now) ?? "")
    }

    private var hasSubtitle: Bool { !subtitleBase.isEmpty || entry.subagentCount > 0 }

    private var subtitle: Text {
        var text = Text(subtitleBase)
        if entry.subagentCount > 0 {
            if !subtitleBase.isEmpty { text = text + Text(" · ") }
            text = text + Text("\(entry.subagentCount) subagents").underline()
        }
        return text
    }

    /// A titled group still prints its display session's activity line, the
    /// same metadata a plain row carries — desktop keeps `display.activity`.
    private var activity: String? {
        titled ? display?.activitySummary(now: now) : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.rowBarSpacing) {
            Button { expanded.toggle() } label: {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                    : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
                layout {
                    VStack(alignment: .leading, spacing: DesignTokens.rowLineSpacing) {
                        Text(display?.displayTitle ?? identity)
                            .font(DesignTokens.rowTitle)
                            .lineLimit(1).truncationMode(.tail)
                        if hasSubtitle {
                            subtitle.font(.caption2).foregroundStyle(.secondary)
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1).truncationMode(.tail)
                        }
                        if let activity, !activity.isEmpty {
                            Text(activity).font(.caption2).foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.tail)
                        }
                        if !titled {
                            Text(display?.sessionId ?? (entry.members.first?.key ?? entry.id))
                                .font(.caption2).foregroundStyle(.tertiary)
                                .lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, markInset)
                    .overlay(alignment: .topLeading) {
                        ProviderMark(provider: display?.client, size: markSize)
                            .overlay(alignment: .bottomTrailing) {
                                switch groupState {
                                case .running:
                                    Circle().fill(.mint).frame(width: 5, height: 5)
                                        .overlay { Circle().stroke(.background, lineWidth: 1) }
                                        .accessibilityHidden(true)
                                case .waiting:
                                    Image(systemName: "exclamationmark.triangle.fill")
                                        .font(.system(size: 7))
                                        .foregroundStyle(.orange)
                                        .accessibilityHidden(true)
                                case .ended, .idle:
                                    EmptyView()
                                }
                            }
                    }
                    metrics
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect)
                .foregroundStyle(.primary)
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
            UsageMeter(value: entry.tokens, maximum: maximum,
                       color: ClientPresentation.color(for: display?.client ?? "unknown"))
            if expanded {
                LazyVStack(alignment: .leading, spacing: DesignTokens.rowDividerSpacing) {
                    let detailMaximum = UsageRowPresentation.maximum(entry.members.map { $0.session.measuredTokens })
                    Divider()
                    Text("Main session")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(mains, id: \.key) { member in
                        SessionRow(session: member.session, sessionKey: member.key,
                                   maximum: detailMaximum, now: now)
                    }
                    if !subagents.isEmpty {
                        Divider()
                        Text("Subagents · \(entry.subagentCount)")
                            .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(subagents, id: \.key) { member in
                            SessionRow(session: member.session, sessionKey: member.key,
                                       maximum: detailMaximum, now: now)
                        }
                    }
                }
            }
        }
    }

    private var metrics: some View {
        VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing,
               spacing: DesignTokens.rowLineSpacing) {
            if let tokens = entry.tokens {
                Text(MetricFormatter.exactTokens(tokens)).font(DesignTokens.rowValue)
            } else {
                Text("Tokens unavailable").font(.footnote).foregroundStyle(.secondary)
            }
            if let cost = entry.cost {
                Text(MetricFormatter.compactUsageCost(cost, unpricedTokens: entry.unpricedTokens,
                                                      currency: preferences.currency))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if let display {
                SessionStatusView(session: display, now: now)
            }
        }
        .monospacedDigit().fixedSize(horizontal: true, vertical: false)
    }
}
