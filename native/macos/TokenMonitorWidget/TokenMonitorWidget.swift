import Foundation
import SwiftUI
import WidgetKit

enum TokenMonitorWidgetConfiguration {
    static let kind = Bundle.main.object(forInfoDictionaryKey: "TMWidgetKind") as? String ?? "com.tokenmonitor.dashboard"
    static let summaryKind = "\(kind).summary"
    static let activityKind = "\(kind).activity"
    static let breakdownKind = "\(kind).breakdown"
    static let quotaKind = "\(kind).quota"
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "TokenMonitorAppGroup") as? String ?? ""
}
struct TokenMonitorWidget: Widget {
    let kind = TokenMonitorWidgetConfiguration.kind

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: DashboardWidgetIntent.self,
            provider: DashboardWidgetTimelineProvider()
        ) { entry in
            TokenMonitorWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackground() }
                .environment(\.colorScheme, .dark)
        }
        .configurationDisplayName("Token Monitor Dashboard")
        .description("Usage, quota, breakdown, and activity in one dashboard.")
        .supportedFamilies([.systemLarge])
    }
}

struct TokenMonitorSummaryWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: TokenMonitorWidgetConfiguration.summaryKind, intent: UsageSummaryWidgetIntent.self, provider: SummaryWidgetTimelineProvider()) { entry in
            TokenMonitorWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackground() }
                .environment(\.colorScheme, .dark)
        }
        .configurationDisplayName("Token Monitor Summary")
        .description("Tokens, cost, and a compact trend.")
        .supportedFamilies([.systemSmall])
    }
}

struct TokenMonitorActivityWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TokenMonitorWidgetConfiguration.activityKind, provider: FixedWidgetTimelineProvider(page: .activity)) { entry in
            TokenMonitorWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackground() }
                .environment(\.colorScheme, .dark)
        }
        .configurationDisplayName("Token Monitor Activity")
        .description("Your recent activity heatmap.")
        .supportedFamilies([.systemMedium])
    }
}

struct TokenMonitorBreakdownWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: TokenMonitorWidgetConfiguration.breakdownKind, intent: BreakdownWidgetIntent.self, provider: BreakdownWidgetTimelineProvider()) { entry in
            TokenMonitorWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackground() }
                .environment(\.colorScheme, .dark)
        }
        .configurationDisplayName("Token Monitor Breakdown")
        .description("Compare tools or models for one period.")
        .supportedFamilies([.systemMedium])
    }
}

struct TokenMonitorQuotaWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: TokenMonitorWidgetConfiguration.quotaKind, intent: QuotaWidgetIntent.self, provider: QuotaWidgetTimelineProvider()) { entry in
            TokenMonitorWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackground() }
                .environment(\.colorScheme, .dark)
        }
        .configurationDisplayName("Token Monitor Quota")
        .description("Subscription windows and reset times.")
        .supportedFamilies([.systemMedium])
    }
}

struct WidgetBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            Color(red: 0.035, green: 0.043, blue: 0.055)
            LinearGradient(
                colors: [
                    Color.white.opacity(colorScheme == .dark ? 0.025 : 0.02),
                    WidgetDesignTokens.accent.opacity(colorScheme == .dark ? 0.13 : 0.1)
                ],
                startPoint: .topTrailing,
                endPoint: .bottomLeading
            )
        }
    }
}

struct TokenMonitorWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TokenMonitorEntry

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                content(snapshot)
            } else {
                WidgetRefreshButton {
                    statusState(
                        title: WidgetL10n.text("Waiting for data"),
                        detail: WidgetL10n.text("Open Token Monitor once")
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func content(_ snapshot: WidgetSnapshot) -> some View {
        if isStale(snapshot) {
            let updatedAt = staleUpdatedAt(snapshot)
            WidgetRefreshButton {
                statusState(
                    title: WidgetL10n.text("Data may be stale"),
                    detail: updatedAt.map {
                        WidgetL10n.format("Updated %@", $0.formatted(.relative(presentation: .named)))
                    }
                )
            }
        } else {
            switch family {
            case .systemLarge:
                LargeDashboardWidgetView(
                    snapshot: snapshot,
                    period: entry.period,
                    page: entry.page,
                    referenceDate: entry.date,
                    selectedActivityDate: entry.selectedActivityDate,
                    quotaMode: entry.quotaMode,
                    selectedQuotaProviderIDs: entry.selectedQuotaProviderIDs
                )
            case .systemMedium:
                if entry.page == .activity {
                    MediumUsageWidgetView(
                        snapshot: snapshot,
                        period: entry.period,
                        page: entry.page,
                        referenceDate: entry.date,
                        selectedActivityDate: entry.selectedActivityDate,
                        quotaMode: entry.quotaMode,
                        selectedQuotaProviderIDs: entry.selectedQuotaProviderIDs
                    )
                } else {
                    WidgetRefreshButton {
                        MediumUsageWidgetView(
                            snapshot: snapshot,
                            period: entry.period,
                            page: entry.page,
                            referenceDate: entry.date,
                            selectedActivityDate: entry.selectedActivityDate,
                            quotaMode: entry.quotaMode,
                            selectedQuotaProviderIDs: entry.selectedQuotaProviderIDs
                        )
                    }
                }
            default:
                WidgetRefreshButton {
                    SmallUsageWidgetView(snapshot: snapshot, period: entry.period)
                }
            }
        }
    }

    private func isStale(_ snapshot: WidgetSnapshot) -> Bool {
        snapshot.isStale(at: entry.date)
    }

    private func staleUpdatedAt(_ snapshot: WidgetSnapshot) -> Date? {
        WidgetStalePresentation.trustedUpdatedAt(for: snapshot)
    }

    private func statusState(title: String, detail: String?) -> some View {
        VStack(spacing: statusGap) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.page.title)
                    .font(.system(size: WidgetDesignTokens.secondarySize, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if WidgetPeriodPolicy.isSelectable(on: entry.page) {
                    Text(entry.period.title)
                        .font(.system(size: WidgetDesignTokens.microSize, weight: .semibold, design: .monospaced))
                        .foregroundStyle(WidgetDesignTokens.accent)
                }
            }
            .frame(height: 18)

            VStack(alignment: .leading, spacing: 6) {
                Spacer(minLength: 0)
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                if let detail {
                    Text(detail)
                        .font(.system(size: WidgetDesignTokens.secondarySize))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var statusGap: CGFloat {
        switch family {
        case .systemLarge: WidgetDesignTokens.largeGap
        case .systemMedium: WidgetDesignTokens.mediumGap
        default: WidgetDesignTokens.smallGap
        }
    }
}

struct WidgetRefreshButton<Label: View>: View {
    let label: Label

    init(@ViewBuilder label: () -> Label) {
        self.label = label()
    }

    var body: some View {
        Button(intent: RefreshWidgetIntent()) {
            label
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(WidgetL10n.text("Refresh Widget"))
    }
}

struct WidgetRefreshBackground: View {
    var body: some View {
        WidgetRefreshButton {
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityHidden(true)
    }
}
