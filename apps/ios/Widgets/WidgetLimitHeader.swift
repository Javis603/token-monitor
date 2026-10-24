import SwiftUI

/// Desktop quota hierarchy: identity and plan on one baseline, then the
/// source's own freshness. Account text is already masked in the snapshot.
struct WidgetLimitHeader: View {
    @Environment(\.widgetInk) private var ink
    let entry: TokenMonitorWidgetEntry
    let limit: TokenMonitorSharedPayload.Limit
    var accountLabel: String? = nil
    var showsProvider = true

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if showsProvider {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    ActivityMark(providerID: limit.providerID, size: 13)
                    Text(verbatim: WidgetPresentation.displayName(for: limit.providerID))
                        .fontWeight(.semibold)
                        .layoutPriority(1)
                    Spacer(minLength: 4)
                    if accountLabel == nil { plan }
                }
                .font(.caption)
                .lineLimit(1)
            }
            if let accountLabel {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(verbatim: accountLabel)
                        .truncationMode(.middle)
                        .privacySensitive()
                        .layoutPriority(1)
                    Spacer(minLength: 4)
                    plan
                }
                .font(.caption2)
                .lineLimit(1)
            }
            if isStale {
                Label("Data may be out of date", systemImage: "clock.badge.exclamationmark")
                    .font(.caption2)
                    .foregroundStyle(ink.secondary)
                    .lineLimit(1)
            } else if entry.showsUpdateTime {
                if let updatedAt = limit.updatedAt {
                    Text(verbatim: WidgetPresentation.updateDescription(for: updatedAt, relativeTo: entry.date))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(ink.secondary)
                        .lineLimit(1)
                } else {
                    Text("Not updated")
                        .font(.caption2)
                        .foregroundStyle(ink.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var plan: some View {
        if let label = limit.planLabel, !label.isEmpty {
            Text(verbatim: label)
                .font(.caption2)
                .foregroundStyle(ink.secondary)
                .lineLimit(1)
        }
    }

    private var isStale: Bool {
        limit.sourceStale == true
            || limit.updatedAt.map { entry.date.timeIntervalSince($0) >= TokenMonitorWidgetEntry.freshnessInterval } == true
    }
}
