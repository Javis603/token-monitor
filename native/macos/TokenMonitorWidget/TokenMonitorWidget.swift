import SwiftUI
import WidgetKit

enum TokenMonitorWidgetConfiguration {
    static let kind = Bundle.main.object(forInfoDictionaryKey: "TMWidgetKind") as? String ?? "com.tokenmonitor.dashboard"
    static let summaryKind = "\(kind).summary"
    static let activityKind = "\(kind).activity"
    static let breakdownKind = "\(kind).breakdown"
    static let quotaKind = "\(kind).quota"
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "TokenMonitorAppGroup") as? String ?? ""
    static let urlScheme: String = {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "TokenMonitorURLScheme") as? String ?? "token-monitor").trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.range(of: "^[A-Za-z][A-Za-z0-9+.-]*$", options: .regularExpression) != nil else { return "token-monitor" }
        return raw.lowercased()
    }()

    static func url(for page: WidgetPage) -> URL {
        URL(string: "\(urlScheme)://\(page.rawValue)")!
    }
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
                .widgetURL(TokenMonitorWidgetConfiguration.url(for: entry.page))
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
                .widgetURL(TokenMonitorWidgetConfiguration.url(for: .overview))
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
                .widgetURL(TokenMonitorWidgetConfiguration.url(for: .activity))
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
                .widgetURL(TokenMonitorWidgetConfiguration.url(for: entry.page))
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
                .widgetURL(TokenMonitorWidgetConfiguration.url(for: .quota))
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
                statusState(
                    title: WidgetL10n.text("Waiting for data"),
                    detail: WidgetL10n.text("Open Token Monitor once")
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func content(_ snapshot: WidgetSnapshot) -> some View {
        if isStale(snapshot) {
            let updatedAt = staleUpdatedAt(snapshot)
            statusState(
                title: WidgetL10n.text("Data may be stale"),
                detail: updatedAt.map {
                    WidgetL10n.format("Updated %@", $0.formatted(.relative(presentation: .named)))
                }
            )
        } else {
            switch family {
            case .systemLarge:
                LargeDashboardWidgetView(
                    snapshot: snapshot,
                    period: entry.period,
                    page: entry.page,
                    referenceDate: entry.date,
                    selectedActivityDate: entry.selectedActivityDate,
                    selectedQuotaProviderIDs: entry.selectedQuotaProviderIDs
                )
            case .systemMedium:
                MediumUsageWidgetView(
                    snapshot: snapshot,
                    period: entry.period,
                    page: entry.page,
                    referenceDate: entry.date,
                    selectedActivityDate: entry.selectedActivityDate,
                    selectedQuotaProviderIDs: entry.selectedQuotaProviderIDs
                )
            default:
                SmallUsageWidgetView(snapshot: snapshot, period: entry.period)
            }
        }
    }

    private func isStale(_ snapshot: WidgetSnapshot) -> Bool {
        guard entry.page == .quota else { return snapshot.isStale(at: entry.date) }
        return WidgetQuotaFreshness.isStale(
            snapshot: snapshot,
            selectedIDs: entry.selectedQuotaProviderIDs,
            at: entry.date
        )
    }

    private func staleUpdatedAt(_ snapshot: WidgetSnapshot) -> Date? {
        guard entry.page == .quota else {
            return WidgetStalePresentation.trustedUpdatedAt(for: snapshot)
        }
        return WidgetQuotaFreshness.oldestUpdatedAt(
            in: snapshot,
            selectedIDs: entry.selectedQuotaProviderIDs
        ) ?? WidgetStalePresentation.trustedUpdatedAt(for: snapshot)
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

struct ActivityHeatmap: View {
    let layout: WidgetHeatmapLayout
    let family: WidgetFamilyScope?
    let selectedDate: String?

    var body: some View {
        if layout.cells.isEmpty {
            EmptyView()
        } else {
            Grid(horizontalSpacing: layout.spacing, verticalSpacing: layout.spacing) {
                ForEach(0..<7, id: \.self) { weekday in
                    GridRow {
                        ForEach(0..<layout.weekCount, id: \.self) { week in
                            if let cell = layout.cell(week: week, weekday: weekday) {
                                if let family, cell.isSelectable {
                                    Button(intent: SelectActivityDayIntent(family: family, date: cell.date)) {
                                        ActivityHeatmapCell(
                                            cell: cell,
                                            width: layout.cellWidth,
                                            height: layout.cellHeight,
                                            color: activityColor(cell.intensity),
                                            isSelected: selectedDate == cell.date
                                        )
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(WidgetL10n.format("%@, %lld tokens", cell.date, cell.totalTokens))
                                    .accessibilityHint(selectedDate == cell.date ? WidgetL10n.text("Deselect") : WidgetL10n.text("Show usage for this day"))
                                } else {
                                    ActivityHeatmapCell(
                                        cell: cell,
                                        width: layout.cellWidth,
                                        height: layout.cellHeight,
                                        color: activityColor(cell.intensity),
                                        isSelected: false
                                    )
                                    .accessibilityHidden(!cell.isSelectable)
                                }
                            }
                        }
                    }
                }
            }
            .frame(width: layout.renderedWidth, height: layout.renderedHeight, alignment: .topLeading)
            .accessibilityLabel(WidgetL10n.text("Activity heatmap"))
        }
    }

    private func activityColor(_ intensity: Int) -> Color {
        switch max(0, min(4, intensity)) {
        case 0: .white.opacity(0.03)
        case 1: Color(red: 90 / 255, green: 170 / 255, blue: 1).opacity(0.18)
        case 2: Color(red: 120 / 255, green: 190 / 255, blue: 1).opacity(0.45)
        case 3: Color(red: 150 / 255, green: 210 / 255, blue: 1).opacity(0.8)
        default: Color(red: 180 / 255, green: 230 / 255, blue: 1)
        }
    }
}

private struct ActivityHeatmapCell: View {
    let cell: WidgetHeatmapCell
    let width: CGFloat
    let height: CGFloat
    let color: Color
    let isSelected: Bool

    private var cornerRadius: CGFloat {
        min(1.5, min(width, height) / 3)
    }

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(cell.isFuture ? Color.clear : color)
            .frame(width: width, height: height)
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .strokeBorder(.primary, lineWidth: 2)
                }
            }
    }
}
