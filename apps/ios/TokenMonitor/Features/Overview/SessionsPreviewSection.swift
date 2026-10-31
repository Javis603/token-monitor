import SwiftUI

/// Overview preview: configured recent sessions plus active work from the display period —
/// running first, then most recent — on the same 30-second activity clock as
/// the Sessions tab.
struct SessionsPreviewSection: View {
    let sessions: [String: SessionUsage]
    var activity: [String: LiveSessionActivity]? = nil
    var grokBotIDs: Set<String> = []
    var limit = 3
    let showAll: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            let now = timeline.date
            let rows = SessionPreviewPresentation.rows(
                sessions, activity: activity, grokBotIDs: grokBotIDs, now: now, limit: limit)
            let running = SessionPreviewPresentation.runningCount(
                sessions, at: now, activity: activity, grokBotIDs: grokBotIDs)
            VStack(alignment: .leading, spacing: DesignTokens.headerToCardSpacing) {
                SectionHeader("Sessions") {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        if running > 0 {
                            HStack(spacing: 5) {
                                Circle().fill(.mint).frame(width: 5, height: 5)
                                    .accessibilityHidden(true)
                                Text("\(running) running")
                            }
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        }
                        Button(action: showAll) {
                            Label("All", systemImage: "chevron.right")
                                .labelStyle(ReversedTitleIcon())
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(minWidth: DesignTokens.controlHeight, minHeight: DesignTokens.controlHeight)
                        .contentShape(.rect)
                    }
                }

                SurfaceCard {
                    if rows.isEmpty {
                        Label("No sessions in this period", systemImage: "bubble.left.and.bubble.right")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        let maximum = UsageRowPresentation.maximum(rows.map(\.tokens))
                        VStack(alignment: .leading, spacing: DesignTokens.rowDividerSpacing) {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                if index > 0 { Divider() }
                                SessionPreviewRow(entry: row, maximum: maximum, now: now)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The compact session line: provider mark, title over tool·model·activity,
/// a trailing token/status reading and the shared usage meter. SessionRow
/// carries the full metadata on the Sessions tab. A folded group renders its
/// header row — title, subagent count and summed tokens — without expansion.
private struct SessionPreviewRow: View {
    let entry: SessionListEntry
    let maximum: Double
    let now: Date
    private var session: SessionUsage? { entry.session }
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0
    @ScaledMetric(relativeTo: .subheadline) private var markInset = 26.0

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.rowBarSpacing) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
            layout {
                VStack(alignment: .leading, spacing: DesignTokens.rowLineSpacing) {
                    Text(session?.displayTitle ?? clientName)
                        .font(DesignTokens.rowTitle)
                        .lineLimit(1).truncationMode(.tail)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption2).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.tail)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, markInset)
                .overlay(alignment: .topLeading) {
                    ProviderMark(provider: session?.client, size: markSize)
                        .overlay(alignment: .bottomTrailing) {
                            switch entry.activityState(at: now) {
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
            UsageMeter(value: entry.tokens, maximum: maximum,
                       color: ClientPresentation.color(for: session?.client ?? "unknown"))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private var clientName: String { ClientPresentation.displayName(for: session?.client ?? "unknown") }

    private var subtitle: String {
        var parts: [String] = []
        if session?.displayTitle != nil { parts.append(clientName) }
        switch session?.modelEntries.count ?? 0 {
        case 0: break
        case 1: parts.append(session?.modelEntries[0].id ?? "")
        default: parts.append(String(localized: "\(session?.modelEntries.count ?? 0) models"))
        }
        if session?.isArchived == true { parts.append(String(localized: "Archived")) }
        if let activity {
            parts.append(activity)
        }
        if entry.subagentCount > 0 {
            parts.append(String(localized: "\(entry.subagentCount) subagents"))
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var activity: String? {
        guard let date = session?.lastActivity else { return nil }
        let time = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
            .locale(Locale(identifier: "en_US_POSIX"))
        return date.formatted(Calendar.current.isDate(date, inSameDayAs: now)
                              ? time : time.month(.twoDigits).day(.twoDigits))
    }

    private var metrics: some View {
        VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing,
               spacing: DesignTokens.rowLineSpacing) {
            if let tokens = entry.tokens {
                Text(MetricFormatter.exactTokens(tokens)).font(DesignTokens.rowValue)
            } else {
                Text("Tokens unavailable").font(.footnote).foregroundStyle(.secondary)
            }
            switch entry.activityState(at: now) {
            case .running:
                Text("Running").font(.caption2).foregroundStyle(.mint)
            case .waiting:
                Text("Waiting").font(.caption2).foregroundStyle(.orange)
            case .ended, .idle:
                EmptyView()
            }
            if let session {
                SessionStatusView(session: session, now: now)
            }
        }
        .monospacedDigit().fixedSize(horizontal: true, vertical: false)
    }
}
