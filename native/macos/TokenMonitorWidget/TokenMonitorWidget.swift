import SwiftUI
import WidgetKit

enum TokenMonitorWidgetConfiguration {
    static let kind = Bundle.main.object(forInfoDictionaryKey: "TMWidgetKind") as? String ?? "com.tokenmonitor.dashboard"
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "TokenMonitorAppGroup") as? String ?? ""
    static let urlScheme = Bundle.main.object(forInfoDictionaryKey: "TokenMonitorURLScheme") as? String ?? "token-monitor"

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
            intent: TokenMonitorWidgetConfigurationIntent.self,
            provider: TokenMonitorTimelineProvider()
        ) { entry in
            TokenMonitorWidgetView(entry: entry)
                .widgetURL(TokenMonitorWidgetConfiguration.url(for: entry.page))
                .containerBackground(for: .widget) { WidgetBackground() }
        }
        .configurationDisplayName("Token Monitor")
        .description("Choose Overview, Quota, Models, Activity, or Trend for each widget.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct WidgetBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            LinearGradient(
                colors: [
                    Color.primary.opacity(colorScheme == .dark ? 0.07 : 0.035),
                    WidgetDesignTokens.accent.opacity(colorScheme == .dark ? 0.08 : 0.045)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }
}

private enum WidgetLayoutRegion: String {
    case header
    case content
    case footer
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
        if snapshot.isEmpty {
            statusState(title: WidgetL10n.text("No usage yet"), detail: WidgetL10n.text("Open Token Monitor to collect data"))
        } else if snapshot.isStale(at: entry.date) {
            statusState(
                title: WidgetL10n.text("Data may be stale"),
                detail: WidgetL10n.format("Updated %@", snapshot.generatedAt.formatted(.relative(presentation: .named)))
            )
        } else {
            switch family {
            case .systemLarge: large(snapshot)
            case .systemMedium: medium(snapshot)
            default: small(snapshot)
            }
        }
    }

    private func small(_ snapshot: WidgetSnapshot) -> some View {
        scaffold(
            header: header(snapshot: snapshot, page: entry.page),
            content: pageBody(snapshot: snapshot, page: entry.page, layout: .small),
            footer: footer(page: entry.page, familyScope: familyScope),
            metrics: metrics
        )
    }

    private func medium(_ snapshot: WidgetSnapshot) -> some View {
        scaffold(
            header: mediumHeader(snapshot: snapshot),
            content: pageBody(snapshot: snapshot, page: entry.page, layout: .medium),
            footer: footer(page: entry.page, familyScope: familyScope),
            metrics: metrics
        )
    }

    private func large(_ snapshot: WidgetSnapshot) -> some View {
        scaffold(
            header: mediumHeader(snapshot: snapshot),
            content: pageBody(snapshot: snapshot, page: entry.page, layout: .large),
            footer: footer(page: entry.page, familyScope: familyScope),
            metrics: metrics
        )
    }

    private func scaffold<Header: View, Content: View, Footer: View>(
        header: Header,
        content: Content,
        footer: Footer,
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

            footer
                .frame(height: metrics.footerHeight)
                .frame(maxWidth: .infinity, alignment: .leading)
                .measureWidgetLayoutRegion(.footer)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(metrics.outerInsets)
    }

    private var familyScope: WidgetFamilyScope? {
        WidgetFamilyScope(widgetFamily: family)
    }

    private func header(snapshot: WidgetSnapshot, page: WidgetPage) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            brand
            Spacer(minLength: 4)
            WidgetPeriodControl(selection: entry.period, style: .compact)
        }
        .frame(height: metrics.headerHeight, alignment: .center)
    }

    private func mediumHeader(snapshot: WidgetSnapshot) -> some View {
        HStack(spacing: 12) {
            brand
            Spacer(minLength: 6)
            WidgetPeriodControl(selection: entry.period, style: .segmented)
        }
        .frame(height: metrics.headerHeight, alignment: .center)
    }

    private var brand: some View {
        HStack(spacing: 2) {
            Text("Σ")
                .font(.system(size: WidgetDesignTokens.titleSize, weight: .bold, design: .monospaced))
            Circle()
                .fill(WidgetDesignTokens.accent)
                .frame(width: 4, height: 4)
        }
        .accessibilityLabel("Token Monitor")
    }

    @ViewBuilder
    private func pageBody(snapshot: WidgetSnapshot, page: WidgetPage, layout: WidgetLayout) -> some View {
        GeometryReader { proxy in
            let context = WidgetContentContext(layout: layout, metrics: metrics, size: proxy.size)
            Group {
                switch page {
                case .overview: overview(snapshot, context: context)
                case .quota: quota(snapshot, context: context)
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

        if context.layout == .large {
            return AnyView(largeOverview(snapshot, model: model))
        }

        return AnyView(adaptiveContent {
            if context.layout == .small {
                VStack(alignment: .leading, spacing: 6) {
                    primary(model.primaryValue, size: WidgetDesignTokens.smallPrimarySize)
                    secondary(model.secondaryValue)
                    summaryRow(WidgetL10n.text("Quota"), quotaSummary(snapshot))
                    Text(snapshot.overview.updatedAt, style: .time)
                        .font(.system(size: WidgetDesignTokens.microSize, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            } else {
                HStack(alignment: .top, spacing: WidgetDesignTokens.mediumGap) {
                    Link(destination: TokenMonitorWidgetConfiguration.url(for: .overview)) {
                        panel {
                            VStack(alignment: .leading, spacing: 4) {
                                sectionLabel(WidgetL10n.text("TOTAL TOKENS"))
                                primary(model.primaryValue, size: WidgetDesignTokens.mediumPrimarySize)
                                secondary(model.secondaryValue)
                            }
                        }
                    }
                    .buttonStyle(.plain)
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
                        panel {
                            VStack(alignment: .leading, spacing: 3) {
                                sectionLabel(WidgetL10n.text("TOTAL TOKENS"))
                                primary(model.primaryValue, size: WidgetDesignTokens.mediumPrimarySize)
                                secondary(model.secondaryValue)
                            }
                        }
                    }
                    .buttonStyle(.plain)
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
                largeModelList(snapshot, context: context, plan: largePlan)
            } else {
                let plan = WidgetListCapacity.plan(
                    itemCount: snapshot.models.count,
                    availableHeight: context.size.height,
                    kind: .models
                )
                modelList(snapshot, context: context, plan: plan)
            }
        }
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

    private func footer(page: WidgetPage, familyScope: WidgetFamilyScope?) -> some View {
        HStack(spacing: 6) {
            if let familyScope {
                WidgetPageControl(page: page, family: familyScope)
                    .frame(width: metrics.pageControlWidth, height: WidgetDesignTokens.pageControlHeight, alignment: .leading)
            } else {
                pageLabel(page: page)
                    .frame(width: metrics.pageControlWidth, height: WidgetDesignTokens.pageControlHeight, alignment: .leading)
            }
            Spacer(minLength: 4)
            Link(destination: TokenMonitorWidgetConfiguration.url(for: page)) {
                Image(systemName: "arrow.up.right")
                    .font(.system(size: WidgetDesignTokens.secondarySize, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: WidgetDesignTokens.openButtonSize, height: WidgetDesignTokens.openButtonSize)
            }
            .buttonStyle(.plain)
        }
        .frame(height: metrics.footerHeight)
    }

    private func statusState(title: String, detail: String) -> some View {
        scaffold(
            header: brand,
            content: VStack(alignment: .leading, spacing: 6) {
                Spacer(minLength: 0)
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(detail)
                    .font(.system(size: WidgetDesignTokens.secondarySize))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: 0)
            },
            footer: footer(page: entry.page, familyScope: familyScope),
            metrics: metrics
        )
    }

    private func pageLabel(page: WidgetPage, showsNextIndicator: Bool = false) -> some View {
        HStack(spacing: 4) {
            Image(systemName: page.systemImage)
            Text(page.title)
                .lineLimit(1)
            if showsNextIndicator {
                Image(systemName: "chevron.right")
                    .font(.system(size: WidgetDesignTokens.microSize - 1, weight: .semibold))
            }
        }
        .font(.system(size: WidgetDesignTokens.microSize, weight: .medium))
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .frame(height: WidgetDesignTokens.pageControlHeight, alignment: .center)
        .background(.primary.opacity(WidgetDesignTokens.panelOpacity), in: Capsule())
        .overlay(Capsule().stroke(.primary.opacity(WidgetDesignTokens.dividerOpacity), lineWidth: 0.6))
    }

    private func panel<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(WidgetDesignTokens.sectionPadding)
            .background(.primary.opacity(WidgetDesignTokens.panelOpacity), in: RoundedRectangle(cornerRadius: WidgetDesignTokens.cornerRadius))
    }

    private func compactPanel<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, WidgetDesignTokens.sectionPadding)
            .padding(.vertical, 6)
            .background(.primary.opacity(WidgetDesignTokens.panelOpacity), in: RoundedRectangle(cornerRadius: WidgetDesignTokens.cornerRadius))
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
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.primary.opacity(WidgetDesignTokens.panelOpacity), in: RoundedRectangle(cornerRadius: 7))
    }

    private func largeSummarySection(title: String, rows: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel(title)
            if rows.isEmpty {
                emptyMessage(WidgetL10n.text("No data"))
            } else {
                ForEach(Array(rows.prefix(5).enumerated()), id: \.offset) { _, row in
                    Text(row)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                        .truncationMode(.tail)
                }
            }
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text).font(.system(size: WidgetDesignTokens.microSize, weight: .semibold, design: .monospaced)).foregroundStyle(.secondary)
    }

    private func primary(_ text: String, size: CGFloat) -> some View {
        Text(text)
            .font(.system(size: size, weight: .semibold, design: .monospaced))
            .lineLimit(1)
            .minimumScaleFactor(0.62)
            .contentTransition(.numericText())
    }

    private func secondary(_ text: String) -> some View {
        Text(text)
            .font(.system(size: WidgetDesignTokens.secondarySize, design: .monospaced))
            .foregroundStyle(.secondary)
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
        VStack(alignment: .leading, spacing: 5) {
            Link(destination: TokenMonitorWidgetConfiguration.url(for: .overview)) {
                compactPanel {
                    VStack(alignment: .leading, spacing: 3) {
                        sectionLabel(WidgetL10n.text("TOTAL TOKENS"))
                        primary(snapshot.overview.totalTokens.formatted(.number.grouping(.automatic)), size: WidgetDesignTokens.largePrimarySize)
                        secondary(model.secondaryValue)
                    }
                }
            }
            .buttonStyle(.plain)
            largeQuotaPreview(snapshot, limit: quotaLimit, showsMoreRows: showsMoreRows)
            Link(destination: TokenMonitorWidgetConfiguration.url(for: .models)) {
                compactPanel {
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
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func quotaSummary(_ snapshot: WidgetSnapshot) -> String {
        guard let provider = snapshot.quota.first else { return WidgetL10n.text("Not configured") }
        let label = WidgetFormat.provider(provider.provider)
        return "\(label) \(WidgetFormat.quotaValue(provider))"
    }

    private func largeQuotaPreview(_ snapshot: WidgetSnapshot, limit: Int, showsMoreRows: Bool) -> some View {
        Link(destination: TokenMonitorWidgetConfiguration.url(for: .quota)) {
            compactPanel {
                VStack(alignment: .leading, spacing: 1) {
                    sectionLabel(WidgetL10n.text("Quota"))
                    if snapshot.quota.isEmpty {
                        emptyMessage(WidgetL10n.text("No quota provider configured"))
                    } else {
                        ForEach(Array(sortedQuotaProviders(snapshot).prefix(max(0, limit)))) { provider in
                            LargeOverviewListRow(
                                label: WidgetFormat.provider(provider.provider),
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
        }
        .buttonStyle(.plain)
    }

    private func sortedQuotaProviders(_ snapshot: WidgetSnapshot) -> [WidgetQuotaProvider] {
        snapshot.quota.sorted { a, b in
            func priority(_ p: WidgetQuotaProvider) -> Int {
                if p.balance != nil || p.windows.first?.remainingPercent != nil { return 0 }
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
                value: WidgetFormat.tokens($0.totalTokens, style: snapshot.presentation.numberStyle),
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

    private func summaryLinkSection(title: String, rows: [String], page: WidgetPage) -> some View {
        Link(destination: TokenMonitorWidgetConfiguration.url(for: page)) {
            panel {
                VStack(alignment: .leading, spacing: 5) {
                    sectionLabel(title)
                    if rows.isEmpty {
                        emptyMessage(WidgetL10n.text("No data"))
                    } else {
                        ForEach(Array(rows.prefix(3).enumerated()), id: \.offset) { _, row in
                            Text(row)
                                .font(.system(size: 11, weight: .medium))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                                .truncationMode(.tail)
                        }
                    }
                }
            }
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
        let remaining = provider.windows.first?.remainingPercent
        let providerFontSize: CGFloat = density == .regular && layout == .small ? 13 : density == .summary ? 10 : 11

        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(WidgetFormat.provider(provider.provider))
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
        plan: WidgetListLayoutPlan
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
                        style: snapshot.presentation.numberStyle
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
        plan: WidgetLargeListLayoutPlan
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
                        style: snapshot.presentation.numberStyle
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
        style: String
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
            Text(WidgetFormat.tokens(model.totalTokens, style: style))
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
        style: String
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
                Text(WidgetFormat.tokens(model.totalTokens, style: style))
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
                Text(WidgetL10n.format("%@ tokens", WidgetFormat.tokens(day.totalTokens, style: snapshot.presentation.numberStyle)))
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
            return WidgetL10n.format("%@ · %@ tokens", day.date, WidgetFormat.tokens(day.totalTokens, style: snapshot.presentation.numberStyle))
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
        let sparkHeight = sparklineHeight(for: context.layout, density: density)

        return VStack(alignment: .leading, spacing: density == .summary ? 4 : 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                primary(
                    WidgetFormat.tokens(snapshot.trend.currentTokens, style: snapshot.presentation.numberStyle),
                    size: context.layout == .small ? 22 : 25
                )
                Spacer(minLength: 4)
                if density == .regular {
                    secondary(WidgetL10n.format("Peak %@", WidgetFormat.tokens(snapshot.trend.peakTokens, style: snapshot.presentation.numberStyle)))
                } else {
                    secondary(trendDeltaText(snapshot.trend))
                }
            }
            sparkline(snapshot.trend.points)
                .frame(height: sparkHeight)
            if density != .summary {
                secondary(trendDateRange(snapshot.trend))
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
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

    private func trendDeltaText(_ trend: WidgetTrend) -> String {
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
        return "\(prefix)\(WidgetFormat.tokens(abs(delta)))"
    }

    private func quotaBar(_ remaining: Double) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.primary.opacity(0.08))
                Capsule().fill(WidgetDesignTokens.accent.opacity(0.7)).frame(width: proxy.size.width * max(0, min(1, remaining / 100)))
            }
        }
        .frame(height: 4)
    }

    private func modelBar(_ share: Double) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.primary.opacity(0.07))
                Capsule().fill(.primary.opacity(0.34)).frame(width: proxy.size.width * max(0, min(1, share / 100)))
            }
        }
        .frame(height: 3)
    }

    private func sparkline(_ points: [WidgetTrendPoint]) -> some View {
        GeometryReader { proxy in
            let values = points.map { Double($0.totalTokens) }
            let peak = max(values.max() ?? 1, 1)
            Path { path in
                for (index, value) in values.enumerated() {
                    let x = values.count <= 1 ? 0 : proxy.size.width * CGFloat(index) / CGFloat(values.count - 1)
                    let y = proxy.size.height * (1 - CGFloat(value / peak))
                    if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
                    else { path.addLine(to: CGPoint(x: x, y: y)) }
                }
            }
            .stroke(WidgetDesignTokens.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        }
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
        intensity <= 0 ? .primary.opacity(0.06) : WidgetDesignTokens.accent.opacity(0.18 + Double(min(4, intensity)) * 0.17)
    }
}

private struct ActivityHeatmapCell: View {
    let cell: WidgetHeatmapCell
    let width: CGFloat
    let height: CGFloat
    let color: Color
    let isSelected: Bool

    private var cornerRadius: CGFloat {
        min(2, min(width, height) / 3)
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

enum WidgetPeriodControlStyle {
    case compact
    case segmented
}

struct WidgetPeriodControl: View {
    let selection: WidgetPeriod
    let style: WidgetPeriodControlStyle

    var body: some View {
        switch style {
        case .compact:
            Button(intent: CycleWidgetPeriodIntent()) {
                periodLabel(selection, selected: true)
            }
            .buttonStyle(.plain)
            .frame(height: WidgetDesignTokens.periodControlHeight, alignment: .center)
            .accessibilityLabel(WidgetL10n.format("%@, selected", selection.accessibilityName))
            .accessibilityHint(WidgetL10n.format("Switch to %@", selection.next.accessibilityName))
        case .segmented:
            HStack(spacing: 5) {
                ForEach(WidgetPeriod.allCases, id: \.self) { period in
                    Button(intent: SetWidgetPeriodIntent(period: period)) {
                        periodLabel(period, selected: period == selection)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(period == selection
                        ? WidgetL10n.format("%@, selected", period.accessibilityName)
                        : WidgetL10n.format("Switch to %@", period.accessibilityName))
                }
            }
            .frame(height: WidgetDesignTokens.periodControlHeight, alignment: .center)
        }
    }

    private func periodLabel(_ period: WidgetPeriod, selected: Bool) -> some View {
        Text(period.title)
            .font(.system(size: WidgetDesignTokens.microSize, weight: selected ? .bold : .medium, design: .monospaced))
            .foregroundStyle(selected ? .primary : .tertiary)
            .padding(.horizontal, selected ? 6 : 3)
            .padding(.vertical, 3)
            .frame(height: WidgetDesignTokens.periodControlHeight, alignment: .center)
            .background(Color.primary.opacity(selected ? WidgetDesignTokens.panelOpacity * 1.8 : 0), in: Capsule())
            .overlay(Capsule().stroke(.primary.opacity(selected ? WidgetDesignTokens.dividerOpacity : 0), lineWidth: 0.6))
            .lineLimit(1)
    }
}

struct WidgetPageControl: View {
    let page: WidgetPage
    let family: WidgetFamilyScope

    var body: some View {
        Button(intent: CycleWidgetPageIntent(family: family, currentPage: page)) {
            HStack(spacing: 4) {
                Image(systemName: page.systemImage)
                Text(page.title)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: WidgetDesignTokens.microSize - 1, weight: .semibold))
            }
            .font(.system(size: WidgetDesignTokens.microSize, weight: .medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .frame(height: WidgetDesignTokens.pageControlHeight, alignment: .center)
            .background(.primary.opacity(WidgetDesignTokens.panelOpacity), in: Capsule())
            .overlay(Capsule().stroke(.primary.opacity(WidgetDesignTokens.dividerOpacity), lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(WidgetL10n.format("Current page: %@", page.title))
        .accessibilityHint(WidgetL10n.format("Switch to %@", page.next.title))
    }
}
