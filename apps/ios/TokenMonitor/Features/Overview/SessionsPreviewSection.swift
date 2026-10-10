import SwiftUI

/// Overview preview: up to three sessions from the current display period —
/// running first, then most recent — on the same 30-second activity clock as
/// the Sessions tab.
struct SessionsPreviewSection: View {
    let sessions: [String: SessionUsage]
    let showAll: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            let now = timeline.date
            let rows = SessionPreviewPresentation.rows(sessions, now: now)
            let running = SessionPreviewPresentation.runningCount(sessions, at: now)
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
                        let maximum = UsageRowPresentation.maximum(rows.map { $0.session.measuredTokens })
                        VStack(alignment: .leading, spacing: DesignTokens.rowDividerSpacing) {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                if index > 0 { Divider() }
                                SessionPreviewRow(session: row.session, maximum: maximum, now: now)
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
/// carries the full metadata on the Sessions tab.
private struct SessionPreviewRow: View {
    let session: SessionUsage
    let maximum: Double
    let now: Date
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
                    Text(session.displayTitle ?? clientName)
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

    private var subtitle: String {
        var parts: [String] = []
        if session.displayTitle != nil { parts.append(clientName) }
        switch session.modelEntries.count {
        case 0: break
        case 1: parts.append(session.modelEntries[0].id)
        default: parts.append(String(localized: "\(session.modelEntries.count) models"))
        }
        if session.isArchived { parts.append(String(localized: "Archived")) }
        if let activity {
            parts.append(activity)
        }
        return parts.joined(separator: " · ")
    }

    private var activity: String? {
        guard let date = session.lastActivity else { return nil }
        let time = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
            .locale(Locale(identifier: "en_US_POSIX"))
        return date.formatted(Calendar.current.isDate(date, inSameDayAs: now)
                              ? time : time.month(.twoDigits).day(.twoDigits))
    }

    private var metrics: some View {
        VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing,
               spacing: DesignTokens.rowLineSpacing) {
            if let tokens = session.measuredTokens {
                Text(MetricFormatter.exactTokens(tokens)).font(DesignTokens.rowValue)
            } else {
                Text("Tokens unavailable").font(.footnote).foregroundStyle(.secondary)
            }
            if session.isRunning(at: now) {
                Text("Running").font(.caption2).foregroundStyle(.mint)
            }
            SessionStatusView(session: session, now: now)
        }
        .monospacedDigit().fixedSize(horizontal: true, vertical: false)
    }
}
