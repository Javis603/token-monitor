import SwiftUI
import WidgetKit

enum TokenMonitorWidgetConfiguration {
    static let kind = Bundle.main.object(forInfoDictionaryKey: "TMWidgetKind") as? String ?? "com.tokenmonitor.dashboard"
    static let summaryKind = "\(kind).summary"
    static let activityKind = "\(kind).activity"
    static let breakdownKind = "\(kind).breakdown"
    // The original quota kind can remain registered with a nil App Intent after
    // changing its configuration shape. A new kind gives WidgetKit a clean
    // configuration record while the legacy kind remains reloadable for cleanup.
    static let legacyQuotaKind = "\(kind).quota"
    static let quotaKind = "\(kind).quota.v2"
    static let allKinds = [kind, summaryKind, activityKind, breakdownKind, legacyQuotaKind, quotaKind]
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "TokenMonitorAppGroup") as? String ?? ""
    static let urlScheme: String = {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "TokenMonitorURLScheme") as? String ?? "token-monitor").trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.range(of: "^[A-Za-z][A-Za-z0-9+.-]*$", options: .regularExpression) != nil else { return "token-monitor" }
        return raw.lowercased()
    }()

    static func url(for page: WidgetPage) -> URL {
        URL(string: "\(urlScheme)://\(page.rawValue)")!
    }

    static let settingsURL = URL(string: "\(urlScheme)://widget-settings")!
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

private enum WidgetLayoutRegion: String {
    case header
    case content
}

#if DEBUG
private struct WidgetLayoutRegionFrame: Equatable {
    let region: WidgetLayoutRegion
    let frame: CGRect
}

private struct WidgetLayoutRegionPreferenceKey: PreferenceKey {
    static var defaultValue: [WidgetLayoutRegionFrame] = []

    static func reduce(value: inout [WidgetLayoutRegionFrame], nextValue: () -> [WidgetLayoutRegionFrame]) {
        value.append(contentsOf: nextValue())
    }
}
#endif

private extension View {
    @ViewBuilder
    func measureWidgetLayoutRegion(_ region: WidgetLayoutRegion) -> some View {
        #if DEBUG
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: WidgetLayoutRegionPreferenceKey.self,
                    value: [WidgetLayoutRegionFrame(region: region, frame: proxy.frame(in: .local))]
                )
            }
        )
        #else
        self
        #endif
    }
}

private struct WidgetContentContext {
    let layout: WidgetLayout
    let metrics: WidgetLayoutMetrics
    let size: CGSize
}

struct TokenMonitorWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TokenMonitorEntry

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                content(snapshot)
            } else {
                statusState(title: WidgetL10n.text("Waiting for data"), detail: WidgetL10n.text("Open Token Monitor once"))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var metrics: WidgetLayoutMetrics {
        WidgetLayoutMetrics.metrics(for: family)
    }

    @ViewBuilder
    private func content(_ snapshot: WidgetSnapshot) -> some View {
        if isStale(snapshot) {
            let updatedAt = staleUpdatedAt(snapshot)
            statusState(
                title: WidgetL10n.text("Data may be stale"),
                detail: updatedAt.map { WidgetL10n.format("Updated %@", $0.formatted(.relative(presentation: .named))) }
            )
        } else {
            switch family {
            case .systemLarge: large(snapshot)
            case .systemMedium: medium(snapshot)
            default: small(snapshot)
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
        guard entry.page == .quota else { return WidgetStalePresentation.trustedUpdatedAt(for: snapshot) }
        return WidgetQuotaFreshness.newestUpdatedAt(
            in: snapshot,
            selectedIDs: entry.selectedQuotaProviderIDs
        ) ?? WidgetStalePresentation.trustedUpdatedAt(for: snapshot)
    }

    private func small(_ snapshot: WidgetSnapshot) -> some View {
        SmallUsageWidgetView(snapshot: snapshot, period: entry.period)
    }

    private func medium(_ snapshot: WidgetSnapshot) -> some View {
        MediumUsageWidgetView(
            snapshot: snapshot,
            period: entry.period,
            page: entry.page,
            referenceDate: entry.date,
            selectedActivityDate: entry.selectedActivityDate,
            selectedQuotaProviderIDs: entry.selectedQuotaProviderIDs
        )
    }

    private func large(_ snapshot: WidgetSnapshot) -> some View {
        LargeDashboardWidgetView(
            snapshot: snapshot,
            period: entry.period,
            page: entry.page,
            referenceDate: entry.date,
            selectedActivityDate: entry.selectedActivityDate,
            selectedQuotaProviderIDs: entry.selectedQuotaProviderIDs
        )
    }

    private func scaffold<Header: View, Content: View>(
        header: Header,
        content: Content,
        metrics: WidgetLayoutMetrics
    ) -> some View {
        VStack(spacing: metrics.contentGap) {
            header
                .frame(height: metrics.headerHeight)
                .frame(maxWidth: .infinity, alignment: .leading)
                .measureWidgetLayoutRegion(.header)

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .measureWidgetLayoutRegion(.content)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(metrics.outerInsets)
    }

    private var familyScope: WidgetFamilyScope? {
        WidgetFamilyScope(widgetFamily: family)
    }

    private func header(page: WidgetPage, period: WidgetPeriod) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(page.title)
                .font(.system(size: WidgetDesignTokens.secondarySize, weight: .semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 6)
            if WidgetPeriodPolicy.isSelectable(on: page) {
                Text(period.title)
                    .font(.system(size: WidgetDesignTokens.microSize, weight: .semibold, design: .monospaced))
                    .foregroundStyle(WidgetDesignTokens.accent)
            }
        }
        .frame(height: metrics.headerHeight, alignment: .center)
    }

    @ViewBuilder
    private func pageBody(snapshot: WidgetSnapshot, page: WidgetPage, layout: WidgetLayout) -> some View {
        GeometryReader { proxy in
            let context = WidgetContentContext(layout: layout, metrics: metrics, size: proxy.size)
            Group {
                switch page {
                case .overview: overview(snapshot, context: context)
                case .quota: quota(snapshot, context: context)
                case .tools: tools(snapshot)
                case .models: models(snapshot, context: context)
                case .activity: activity(snapshot, context: context)
                case .trend: trend(snapshot, context: context)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func overview(_ snapshot: WidgetSnapshot, context: WidgetContentContext) -> some View {
        let model = WidgetViewModel.make(snapshot: snapshot, page: .overview, layout: context.layout)

        if snapshot.overview.totalTokens == 0
            && snapshot.overview.costUsd == 0
            && snapshot.models.isEmpty
            && snapshot.activity.activeDays == 0 {
            return AnyView(emptyMessage(WidgetL10n.text("No usage yet")))
        }

        if context.layout == .large {
            return AnyView(largeOverview(snapshot, model: model))
        }

        return AnyView(adaptiveContent {
            if context.layout == .small {
                VStack(alignment: .leading, spacing: 6) {
                    primary(model.primaryValue, size: WidgetDesignTokens.smallPrimarySize)
                    secondary(model.secondaryValue)
                    Divider().opacity(WidgetDesignTokens.dividerOpacity)
                    summaryRow(WidgetL10n.text("Quota"), quotaSummary(snapshot))
                    Text(snapshot.overview.updatedAt, style: .time)
                        .font(.system(size: WidgetDesignTokens.microSize, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            } else {
                HStack(alignment: .center, spacing: WidgetDesignTokens.mediumGap) {
                    Link(destination: TokenMonitorWidgetConfiguration.url(for: .overview)) {
                        VStack(alignment: .leading, spacing: 4) {
                            primary(model.primaryValue, size: WidgetDesignTokens.mediumPrimarySize)
                            secondary(model.secondaryValue)
                        }
                    }
                    .buttonStyle(.plain)
                    Divider()
                        .opacity(WidgetDesignTokens.dividerOpacity)
                    VStack(spacing: 6) {
                        summaryLinkRow(title: WidgetL10n.text("Quota"), value: quotaSummary(snapshot), page: .quota)
                        summaryLinkRow(title: WidgetL10n.text("Top model"), value: snapshot.models.first?.displayName ?? "—", page: .models)
                        summaryLinkRow(title: WidgetL10n.text("Active days"), value: "\(snapshot.activity.activeDays)", page: .activity)
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                }
            }
        } compact: {
            if context.layout == .small {
                VStack(alignment: .leading, spacing: 4) {
                    primary(model.primaryValue, size: WidgetDesignTokens.smallPrimarySize)
                    secondary(model.secondaryValue)
                    Text(snapshot.overview.updatedAt, style: .time)
                        .font(.system(size: WidgetDesignTokens.microSize, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            } else {
                HStack(alignment: .top, spacing: 8) {
                    Link(destination: TokenMonitorWidgetConfiguration.url(for: .overview)) {
                        VStack(alignment: .leading, spacing: 3) {
                            primary(model.primaryValue, size: WidgetDesignTokens.mediumPrimarySize)
                            secondary(model.secondaryValue)
                        }
                    }
                    .buttonStyle(.plain)
                    Divider()
                        .opacity(WidgetDesignTokens.dividerOpacity)
                    VStack(spacing: 6) {
                        summaryLinkRow(title: WidgetL10n.text("Quota"), value: quotaSummary(snapshot), page: .quota)
                        summaryLinkRow(title: WidgetL10n.text("Top model"), value: snapshot.models.first?.displayName ?? "—", page: .models)
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                }
            }
        } summary: {
            VStack(alignment: .leading, spacing: 4) {
                primary(model.primaryValue, size: 24)
                secondary(model.secondaryValue)
                summaryLinkRow(title: WidgetL10n.text("Quota"), value: quotaSummary(snapshot), page: .quota)
            }
        })
    }

    private func quota(_ snapshot: WidgetSnapshot, context: WidgetContentContext) -> some View {
        let plan = WidgetListCapacity.plan(
            itemCount: snapshot.quota.count,
            availableHeight: context.size.height,
            kind: .quota
        )
        return quotaList(snapshot, context: context, plan: plan)
    }

    private func models(_ snapshot: WidgetSnapshot, context: WidgetContentContext) -> some View {
        Group {
            if context.layout == .large {
                let largePlan = WidgetLargeListLayoutPlan.make(
                    itemCount: snapshot.models.count,
                    availableHeight: context.size.height
                )
                largeModelList(snapshot, context: context, plan: largePlan, presentation: snapshot.presentation)
            } else {
                let plan = WidgetListCapacity.plan(
                    itemCount: snapshot.models.count,
                    availableHeight: context.size.height,
                    kind: .models
                )
                modelList(snapshot, context: context, plan: plan, presentation: snapshot.presentation)
            }
        }
    }

    private func tools(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            if snapshot.tools.isEmpty {
                emptyMessage(WidgetL10n.text("No data"))
            } else {
                ForEach(Array(snapshot.tools.prefix(3))) { tool in
                    HStack(spacing: 6) {
                        Text(WidgetFormat.provider(tool.id))
                            .font(.system(size: 11, weight: .semibold))
                            .lineLimit(1)
                        Spacer(minLength: 3)
                        Text(WidgetFormat.tokens(tool.totalTokens, style: "compact", presentation: snapshot.presentation))
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    modelBar(tool.sharePercent)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func activity(_ snapshot: WidgetSnapshot, context: WidgetContentContext) -> some View {
        adaptiveContent {
            activityView(snapshot, context: context, density: .regular)
        } compact: {
            activityView(snapshot, context: context, density: .compact)
        } summary: {
            activityView(snapshot, context: context, density: .summary)
        }
    }

    private func trend(_ snapshot: WidgetSnapshot, context: WidgetContentContext) -> some View {
        adaptiveContent {
            trendView(snapshot, context: context, density: .regular)
        } compact: {
            trendView(snapshot, context: context, density: .compact)
        } summary: {
            trendView(snapshot, context: context, density: .summary)
        }
    }

    private func statusState(title: String, detail: String?) -> some View {
        scaffold(
            header: header(page: entry.page, period: entry.period),
            content: VStack(alignment: .leading, spacing: 6) {
                Spacer(minLength: 0)
                Text(title).font(.system(size: 13, weight: .semibold))
                if let detail {
                    Text(detail)
                        .font(.system(size: WidgetDesignTokens.secondarySize))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            },
            metrics: metrics
        )
    }

    private func summaryRow(_ label: String, _ value: String) -> some View {
        HStack(spacing: 6) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Text(value)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .font(.system(size: WidgetDesignTokens.secondarySize, weight: .medium))
        .padding(.vertical, 2)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text).font(.system(size: WidgetDesignTokens.microSize, weight: .semibold, design: .monospaced)).foregroundStyle(.secondary)
    }

    private func primary(_ text: String, size: CGFloat) -> some View {
        Text(text)
            .font(.system(size: size, weight: .medium))
            .monospacedDigit()
            .foregroundStyle(WidgetDesignTokens.number)
            .lineLimit(1)
            .minimumScaleFactor(0.62)
            .contentTransition(.numericText())
    }

    private func secondary(_ text: String) -> some View {
        Text(text)
            .font(.system(size: WidgetDesignTokens.secondarySize, design: .monospaced))
            .foregroundStyle(WidgetDesignTokens.muted)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }

    private func emptyMessage(_ text: String) -> some View {
        Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
    }

    private func adaptiveContent<Regular: View, Compact: View, Summary: View>(
        @ViewBuilder regular: () -> Regular,
        @ViewBuilder compact: () -> Compact,
        @ViewBuilder summary: () -> Summary
    ) -> some View {
        ViewThatFits(in: .vertical) {
            regular()
            compact()
            summary()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func largeOverview(_ snapshot: WidgetSnapshot, model: WidgetViewModel) -> some View {
        ViewThatFits(in: .vertical) {
            largeOverviewContent(snapshot, model: model, quotaLimit: 3, modelLimit: 2, showsMoreRows: true)
            largeOverviewContent(snapshot, model: model, quotaLimit: 2, modelLimit: 2, showsMoreRows: true)
            largeOverviewContent(snapshot, model: model, quotaLimit: 1, modelLimit: 1, showsMoreRows: false)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func largeOverviewContent(
        _ snapshot: WidgetSnapshot,
        model: WidgetViewModel,
        quotaLimit: Int,
        modelLimit: Int,
        showsMoreRows: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Link(destination: TokenMonitorWidgetConfiguration.url(for: .overview)) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    primary(snapshot.overview.totalTokens.formatted(.number.grouping(.automatic)), size: WidgetDesignTokens.largePrimarySize)
                    Spacer(minLength: 8)
                    secondary(model.secondaryValue)
                }
            }
            .buttonStyle(.plain)

            Divider().opacity(WidgetDesignTokens.dividerOpacity)

            HStack(alignment: .top, spacing: 12) {
                largeQuotaPreview(snapshot, limit: quotaLimit, showsMoreRows: showsMoreRows)
                Divider().opacity(WidgetDesignTokens.dividerOpacity)
                Link(destination: TokenMonitorWidgetConfiguration.url(for: .models)) {
                    VStack(alignment: .leading, spacing: 1) {
                        sectionLabel(WidgetL10n.text("Models"))
                        let rows = modelOverviewRows(snapshot, limit: modelLimit, showsMoreRows: showsMoreRows)
                        if rows.isEmpty {
                            emptyMessage(WidgetL10n.text("No data"))
                        } else {
                            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                                LargeOverviewListRow(label: row.label, value: row.value, style: row.style)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

            if !snapshot.trend.points.isEmpty {
                Divider().opacity(WidgetDesignTokens.dividerOpacity)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        sectionLabel(WidgetL10n.text("Trend"))
                        Spacer(minLength: 8)
                        secondary(trendDeltaText(snapshot.trend, presentation: snapshot.presentation))
                    }
                    sparkline(snapshot.trend.points)
                        .frame(maxHeight: .infinity)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func quotaSummary(_ snapshot: WidgetSnapshot) -> String {
        guard let provider = snapshot.quota.first else { return WidgetL10n.text("Not configured") }
        let label = providerDisplayName(provider)
        return "\(label) \(WidgetFormat.quotaValue(provider))"
    }

    private func largeQuotaPreview(_ snapshot: WidgetSnapshot, limit: Int, showsMoreRows: Bool) -> some View {
        Link(destination: TokenMonitorWidgetConfiguration.url(for: .quota)) {
            VStack(alignment: .leading, spacing: 1) {
                sectionLabel(WidgetL10n.text("Quota"))
                if snapshot.quota.isEmpty {
                    emptyMessage(WidgetL10n.text("No quota provider configured"))
                } else {
                    ForEach(Array(sortedQuotaProviders(snapshot).prefix(max(0, limit)))) { provider in
                        LargeOverviewListRow(
                            label: providerDisplayName(provider),
                            value: WidgetFormat.quotaValue(provider),
                            style: provider.status == "ok" ? .primary : .secondary
                        )
                    }
                    if showsMoreRows, snapshot.quota.count > limit {
                        LargeOverviewListRow(label: WidgetL10n.format("%lld more", snapshot.quota.count - limit), value: "", style: .more)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func sortedQuotaProviders(_ snapshot: WidgetSnapshot) -> [WidgetQuotaProvider] {
        snapshot.quota.sorted { a, b in
            func priority(_ p: WidgetQuotaProvider) -> Int {
                if p.balance != nil || p.windows.first?.remaining != nil || p.windows.first?.remainingPercent != nil { return 0 }
                if p.status == "unauthorized" || p.status == "sessionExpired" { return 1 }
                if p.status == "notConfigured" { return 3 }
                return 2
            }
            return priority(a) < priority(b)
        }
    }

    private func modelOverviewRows(_ snapshot: WidgetSnapshot, limit: Int, showsMoreRows: Bool = true) -> [LargeOverviewListRow.Model] {
        let rows = Array(snapshot.models.prefix(max(0, limit))).map {
            LargeOverviewListRow.Model(
                label: $0.displayName,
                value: WidgetFormat.tokens($0.totalTokens, style: snapshot.presentation.numberStyle, presentation: snapshot.presentation),
                style: .primary
            )
        }
        if showsMoreRows, snapshot.models.count > limit {
            return rows + [LargeOverviewListRow.Model(label: WidgetL10n.format("%lld more", snapshot.models.count - limit), value: "", style: .more)]
        }
        return rows
    }

    private func summaryLinkRow(title: String, value: String, page: WidgetPage) -> some View {
        Link(destination: TokenMonitorWidgetConfiguration.url(for: page)) {
            summaryRow(title, value)
        }
        .buttonStyle(.plain)
    }

    private func quotaList(
        _ snapshot: WidgetSnapshot,
        context: WidgetContentContext,
        plan: WidgetListLayoutPlan
    ) -> some View {
        let providers = Array(snapshot.quota.prefix(plan.visibleCount))
        let showsDetails = plan.density == .regular

        return VStack(alignment: .leading, spacing: plan.rowSpacing) {
            if snapshot.quota.isEmpty {
                emptyMessage(WidgetL10n.text("No quota provider configured"))
                if context.layout != .small {
                    secondary(WidgetL10n.text("Sign in to the provider in the desktop app"))
                }
            } else {
                ForEach(providers) { provider in
                    quotaProviderRow(
                        provider,
                        layout: context.layout,
                        density: plan.density,
                        showsBars: showsDetails,
                        showsReset: showsDetails
                    )
                    .frame(height: plan.rowHeight, alignment: .topLeading)
                    .overlay(alignment: .bottom) {
                        if provider.id != providers.last?.id {
                            Divider().opacity(WidgetDesignTokens.dividerOpacity)
                        }
                    }
                }
                if plan.hiddenCount > 0 {
                    secondary(WidgetL10n.format("%lld more", plan.hiddenCount))
                        .frame(height: plan.moreRowHeight, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func quotaProviderRow(
        _ provider: WidgetQuotaProvider,
        layout: WidgetLayout,
        density: WidgetContentDensity,
        showsBars: Bool,
        showsReset: Bool
    ) -> some View {
        let remaining = provider.windows.first?.showMeter == false || provider.windows.first?.metric == "credits"
            ? nil
            : provider.windows.first?.remainingPercent
        let providerFontSize: CGFloat = density == .regular && layout == .small ? 13 : density == .summary ? 10 : 11

        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(providerDisplayName(provider))
                    .font(.system(size: providerFontSize, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Spacer(minLength: 3)
                Text(WidgetFormat.quotaValue(provider))
                    .font(.system(size: WidgetDesignTokens.secondarySize, weight: .medium, design: .monospaced))
                    .foregroundStyle(provider.status == "ok" ? .primary : .secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            if showsBars, let remaining {
                quotaBar(remaining)
            }
            if showsReset, let reset = provider.windows.first?.resetsAt {
                Text(WidgetFormat.reset(reset))
                    .font(.system(size: WidgetDesignTokens.microSize, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func modelList(
        _ snapshot: WidgetSnapshot,
        context: WidgetContentContext,
        plan: WidgetListLayoutPlan,
        presentation: WidgetPresentation
    ) -> some View {
        let rows = Array(snapshot.models.prefix(plan.visibleCount))
        let showsDetails = plan.density == .regular

        return VStack(alignment: .leading, spacing: plan.rowSpacing) {
            if snapshot.models.isEmpty {
                emptyMessage(WidgetL10n.text("No model rankings"))
            } else {
                ForEach(rows) { model in
                    modelRow(
                        model,
                        layout: context.layout,
                        density: plan.density,
                        showsBars: showsDetails && context.layout != .small,
                        showsTokens: showsDetails,
                        style: snapshot.presentation.numberStyle,
                        presentation: presentation
                    )
                    .frame(height: plan.rowHeight, alignment: .topLeading)
                    .overlay(alignment: .bottom) {
                        if model.id != rows.last?.id {
                            Divider().opacity(WidgetDesignTokens.dividerOpacity)
                        }
                    }
                }
                if plan.hiddenCount > 0 {
                    secondary(WidgetL10n.format("%lld more", plan.hiddenCount))
                        .frame(height: plan.moreRowHeight, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func largeModelList(
        _ snapshot: WidgetSnapshot,
        context: WidgetContentContext,
        plan: WidgetLargeListLayoutPlan,
        presentation: WidgetPresentation
    ) -> some View {
        let rows = Array(snapshot.models.prefix(plan.visibleCount))

        return VStack(alignment: .leading, spacing: plan.rowSpacing) {
            if snapshot.models.isEmpty {
                emptyMessage(WidgetL10n.text("No model rankings"))
            } else {
                ForEach(rows) { model in
                    largeModelRow(
                        model,
                        plan: plan,
                        style: snapshot.presentation.numberStyle,
                        presentation: presentation
                    )
                    .frame(height: plan.rowHeight, alignment: .topLeading)
                    .overlay(alignment: .bottom) {
                        if model.id != rows.last?.id {
                            Divider().opacity(WidgetDesignTokens.dividerOpacity)
                        }
                    }
                }
                if plan.hiddenCount > 0 {
                    secondary(WidgetL10n.format("%lld more", plan.hiddenCount))
                        .frame(height: plan.moreRowHeight, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func largeModelRow(
        _ model: WidgetModel,
        plan: WidgetLargeListLayoutPlan,
        style: String,
        presentation: WidgetPresentation
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Text(model.displayName)
                    .font(.system(size: plan.nameFontSize, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .truncationMode(.tail)
                Spacer(minLength: 2)
                Text("\(Int(model.sharePercent.rounded()))%")
                    .font(.system(size: plan.percentFontSize, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            modelBar(model.sharePercent)
                .frame(height: plan.barHeight)
            Text(WidgetFormat.tokens(model.totalTokens, style: style, presentation: presentation))
                .font(.system(size: plan.tokenFontSize, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
    }

    private func modelRow(
        _ model: WidgetModel,
        layout: WidgetLayout,
        density: WidgetContentDensity,
        showsBars: Bool,
        showsTokens: Bool,
        style: String,
        presentation: WidgetPresentation
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Text(model.displayName)
                    .font(.system(size: density == .regular && layout == .small ? 12 : density == .summary ? 9 : 10, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .truncationMode(.tail)
                Spacer(minLength: 2)
                Text("\(Int(model.sharePercent.rounded()))%")
                    .font(.system(size: WidgetDesignTokens.microSize, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            if showsBars {
                modelBar(model.sharePercent)
            }
            if showsTokens {
                Text(WidgetFormat.tokens(model.totalTokens, style: style, presentation: presentation))
                    .font(.system(size: WidgetDesignTokens.microSize, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func activityView(
        _ snapshot: WidgetSnapshot,
        context: WidgetContentContext,
        density: WidgetContentDensity
    ) -> some View {
        if context.layout == .medium {
            return AnyView(mediumActivityView(snapshot, context: context, density: density))
        }

        let spec = activityLayout(snapshot, context: context, density: density)

        return AnyView(Group {
            if spec.weekCount == 0 {
                emptyMessage(WidgetL10n.text("No activity data"))
            } else {
                VStack(alignment: .leading, spacing: density == .summary ? 4 : 6) {
                    if context.layout == .small {
                        HStack(spacing: 4) {
                            Text(WidgetL10n.text("Active"))
                                .font(.system(size: WidgetDesignTokens.secondarySize, weight: .medium))
                                .foregroundStyle(.secondary)
                            Text(WidgetL10n.format("%lld days", spec.activeDays))
                                .font(.system(size: WidgetDesignTokens.secondarySize, weight: .semibold, design: .monospaced))
                        }
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            primary("\(spec.activeDays)", size: density == .summary ? 22 : 26)
                            secondary(WidgetL10n.format("Active days in the last %lld weeks", spec.weekCount))
                        }
                    }

                    ActivityHeatmap(
                        layout: spec,
                        family: context.layout == .large ? .large : nil,
                        selectedDate: entry.selectedActivityDate
                    )
                        .frame(maxWidth: .infinity, alignment: .center)

                    if context.layout == .large {
                        secondary(largeActivityCaptionText(snapshot, layout: spec))
                    } else if density == .regular {
                        secondary(activityDateRangeText(spec))
                    } else if density == .compact {
                        secondary(WidgetL10n.format("Last %lld weeks", spec.weekCount))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading))
    }

    private func mediumActivityView(
        _ snapshot: WidgetSnapshot,
        context: WidgetContentContext,
        density: WidgetContentDensity
    ) -> some View {
        let plan = WidgetMediumActivityLayoutPlan.make(availableSize: context.size)
        let spec = WidgetHeatmapLayoutCalculator.make(
            days: snapshot.activity.days,
            referenceDate: entry.date,
            availableSize: CGSize(width: plan.heatmapWidth, height: context.size.height),
            maxWeeks: 14,
            minCellSize: metrics.activityMinCellSize,
            maxCellSize: metrics.activityMaxCellSize,
            spacing: metrics.activityCellSpacing
        )

        return Group {
            if spec.weekCount == 0 {
                emptyMessage(WidgetL10n.text("No activity data"))
            } else {
                HStack(alignment: .center, spacing: plan.spacing) {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            primary("\(spec.activeDays)", size: density == .summary ? 22 : 26)
                            secondary(WidgetL10n.format("Active days in the last %lld weeks", spec.weekCount))
                        }
                        .lineLimit(1)
                        .minimumScaleFactor(0.76)

                        Spacer(minLength: 4)

                        selectedDayDetail(snapshot)
                            .frame(height: 32, alignment: .bottomLeading)
                    }
                    .frame(width: plan.summaryWidth, height: context.size.height, alignment: .topLeading)

                    ActivityHeatmap(layout: spec, family: .medium, selectedDate: entry.selectedActivityDate)
                        .frame(width: plan.heatmapWidth, height: context.size.height, alignment: .center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    @ViewBuilder
    private func selectedDayDetail(_ snapshot: WidgetSnapshot) -> some View {
        if let day = selectedActivityDay(in: snapshot) {
            VStack(alignment: .leading, spacing: 2) {
                Text(day.date)
                Text(WidgetL10n.format("%@ tokens", WidgetFormat.tokens(day.totalTokens, style: snapshot.presentation.numberStyle, presentation: snapshot.presentation)))
            }
            .font(.system(size: WidgetDesignTokens.microSize, weight: .medium, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }

    private func largeActivityCaptionText(
        _ snapshot: WidgetSnapshot,
        layout: WidgetHeatmapLayout
    ) -> String {
        if let day = selectedActivityDay(in: snapshot) {
            return WidgetL10n.format("%@ · %@ tokens", day.date, WidgetFormat.tokens(day.totalTokens, style: snapshot.presentation.numberStyle, presentation: snapshot.presentation))
        }
        return activityDateRangeText(layout)
    }

    private func selectedActivityDay(in snapshot: WidgetSnapshot) -> WidgetActivityDay? {
        WidgetActivitySelection.detailDay(
            selectedDate: entry.selectedActivityDate,
            days: snapshot.activity.days
        )
    }

    private func activityLayout(
        _ snapshot: WidgetSnapshot,
        context: WidgetContentContext,
        density: WidgetContentDensity
    ) -> WidgetHeatmapLayout {
        let maxWeeks = switch context.layout {
        case .small: 16
        case .medium: 14
        case .large: 26
        }
        let labelReserve: CGFloat = context.layout == .medium ? 0 : density == .regular ? 14 : density == .compact ? 12 : 0
        let summaryReserve: CGFloat = switch context.layout {
        case .small: 16
        case .medium: 28
        case .large: 28
        }
        let heatmapWidth = max(0, context.size.width)
        let heatmapHeight = max(0, context.size.height - labelReserve - summaryReserve - 6)

        return WidgetHeatmapLayoutCalculator.make(
            days: snapshot.activity.days,
            referenceDate: entry.date,
            availableSize: CGSize(width: heatmapWidth, height: heatmapHeight),
            maxWeeks: maxWeeks,
            minCellSize: metrics.activityMinCellSize,
            maxCellSize: metrics.activityMaxCellSize,
            spacing: metrics.activityCellSpacing
        )
    }

    private func activityDateRangeText(_ layout: WidgetHeatmapLayout) -> String {
        guard let first = layout.startDate, let last = layout.endDate else { return WidgetL10n.text("No activity data") }
        return "\(first) — \(last)"
    }

    private func trendView(
        _ snapshot: WidgetSnapshot,
        context: WidgetContentContext,
        density: WidgetContentDensity
    ) -> some View {
        if snapshot.trend.points.isEmpty {
            return AnyView(emptyMessage(WidgetL10n.text("No trend data")))
        }
        let sparkHeight = sparklineHeight(for: context.layout, density: density)

        return AnyView(VStack(alignment: .leading, spacing: density == .summary ? 4 : 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                primary(
                    WidgetFormat.tokens(snapshot.trend.currentTokens, style: snapshot.presentation.numberStyle, presentation: snapshot.presentation),
                    size: context.layout == .small ? 22 : 25
                )
                Spacer(minLength: 4)
                if density == .regular {
                    secondary(WidgetL10n.format("Peak %@", WidgetFormat.tokens(snapshot.trend.peakTokens, style: snapshot.presentation.numberStyle, presentation: snapshot.presentation)))
                } else {
                    secondary(trendDeltaText(snapshot.trend, presentation: snapshot.presentation))
                }
            }
            sparkline(snapshot.trend.points)
                .frame(height: sparkHeight)
            if density != .summary {
                secondary(trendDateRange(snapshot.trend))
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading))
    }

    private func providerDisplayName(_ provider: WidgetQuotaProvider) -> String {
        if let displayName = provider.displayName, !displayName.isEmpty {
            return displayName
        }
        return WidgetFormat.provider(provider.provider)
    }

    private func sparklineHeight(for layout: WidgetLayout, density: WidgetContentDensity) -> CGFloat {
        switch (layout, density) {
        case (.small, .regular): 40
        case (.small, .compact): 32
        case (.small, .summary): 24
        case (.medium, .regular): 48
        case (.medium, .compact): 38
        case (.medium, .summary): 28
        case (.large, .regular): 96
        case (.large, .compact): 68
        case (.large, .summary): 36
        }
    }

    private func trendDateRange(_ trend: WidgetTrend) -> String {
        let values = [trend.startDate, trend.endDate].compactMap { $0 }
        return values.isEmpty ? WidgetL10n.text("No trend data") : values.joined(separator: " — ")
    }

    private func trendDeltaText(_ trend: WidgetTrend, presentation: WidgetPresentation) -> String {
        guard let first = trend.points.first?.totalTokens, let last = trend.points.last?.totalTokens else {
            return WidgetL10n.text("No change")
        }
        let delta = last - first
        if first > 0 {
            let percent = Int((Double(delta) / Double(first) * 100).rounded())
            if percent == 0 { return WidgetL10n.text("Unchanged from first day") }
            return percent > 0
                ? WidgetL10n.format("Up %lld%% from first day", percent)
                : WidgetL10n.format("Down %lld%% from first day", abs(percent))
        }
        if delta == 0 { return WidgetL10n.text("Unchanged from first day") }
        let prefix = delta > 0 ? "+" : "−"
        return "\(prefix)\(WidgetFormat.tokens(abs(delta), presentation: presentation))"
    }

    private func quotaBar(_ remaining: Double) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.09))
                Capsule().fill(WidgetDesignTokens.accent.opacity(0.7)).frame(width: proxy.size.width * max(0, min(1, remaining / 100)))
            }
        }
        .frame(height: 4)
    }

    private func modelBar(_ share: Double) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.08))
                Capsule().fill(WidgetDesignTokens.accent.opacity(0.48)).frame(width: proxy.size.width * max(0, min(1, share / 100)))
            }
        }
        .frame(height: 3)
    }

    private func sparkline(_ points: [WidgetTrendPoint]) -> some View {
        SmoothTrendChart(points: points)
    }

}

private struct LargeOverviewListRow: View {
    enum Style: Equatable {
        case primary
        case secondary
        case more
    }

    struct Model: Equatable {
        let label: String
        let value: String
        let style: Style
    }

    let label: String
    let value: String
    let style: Style

    private let rowHeight: CGFloat = 16
    private let fontSize: CGFloat = 10

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(label)
                .font(.system(size: fontSize, weight: .medium))
                .foregroundStyle(foregroundStyle)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
                .truncationMode(.tail)
            Spacer(minLength: 2)
            if !value.isEmpty {
                Text(value)
                    .font(.system(size: fontSize, weight: .medium, design: .monospaced))
                    .foregroundStyle(valueForegroundStyle)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                    .truncationMode(.tail)
            }
        }
        .frame(height: rowHeight, alignment: .center)
    }

    private var foregroundStyle: HierarchicalShapeStyle {
        style == .more ? .tertiary : .primary
    }

    private var valueForegroundStyle: HierarchicalShapeStyle {
        switch style {
        case .primary: .primary
        case .secondary: .secondary
        case .more: .tertiary
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
