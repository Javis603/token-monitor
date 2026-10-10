import SwiftUI

struct InsightsView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store

    /// Inner width of the Activity card, measured so the heatmap can pick how
    /// many week columns fill it flush.
    @State private var activityCardWidth: Double = 0

    var body: some View {
        Group {
            if store.stats != nil {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: DesignTokens.sectionSpacing) {
                            ConnectionStatusNotice(phase: store.phase) {
                                Task { await store.refresh() }
                            }

                            section("Lifetime") {
                                LifetimeCard(summary: store.currentHistory.summary)
                            }

                            VStack(alignment: .leading, spacing: DesignTokens.headerToCardSpacing) {
                                SectionHeader("Activity")
                                SurfaceCard {
                                    ActivityHeatmap(
                                        model: heatmapModel,
                                        metric: .tokens,
                                        currency: preferences.currency
                                    )
                                }
                            }
                            .onGeometryChange(for: Double.self) { proxy in
                                proxy.size.width
                            } action: { width in
                                activityCardWidth = max(
                                    0,
                                    width - 2 * DesignTokens.cardPadding
                                )
                            }

                            section("Trend") {
                                InsightTrendCard(history: store.currentHistory)
                            }
                            .id("insights-trend")

                            section("Monthly history") {
                                MonthlyHistoryCard(
                                    months: store.currentHistory.monthly ?? [],
                                    currency: preferences.currency
                                )
                            }
                            .id("monthly-history")
                        }
                        .padding(.horizontal, DesignTokens.screenPadding)
                        .padding(.top, 8)
                        .padding(.bottom, DesignTokens.sectionSpacing)
                    }
                    .refreshable {
                        await store.refresh()
                    }
                    .task {
                        #if DEBUG
                        let arguments = ProcessInfo.processInfo.arguments
                        if arguments.contains("--sample-insights-bottom") {
                            await Task.yield()
                            proxy.scrollTo("monthly-history", anchor: .top)
                        } else if let anchor = arguments
                            .first(where: { $0.hasPrefix("--sample-scroll=") })
                            .flatMap({ $0.split(separator: "=").last })
                            .map(String.init) {
                            await Task.yield()
                            proxy.scrollTo(anchor, anchor: .top)
                        }
                        #endif
                    }
                }
            } else if case let .failed(message) = store.phase {
                ContentUnavailableView {
                    Label("Offline", systemImage: "wifi.slash")
                } description: {
                    Text(message)
                } actions: {
                    Button("Refresh") { Task { await store.refresh() } }
                        .modifier(AppActionStyle())
                }
                .padding(DesignTokens.screenPadding)
            } else {
                ContentUnavailableView(
                    "No Insights",
                    systemImage: "chart.xyaxis.line",
                    description: Text(
                        "Connect a Hub to explore usage history and trends."
                    )
                )
                .padding(DesignTokens.screenPadding)
            }
        }
        .modifier(RootPageHeader("Insights"))
        .background {
            AppBackground()
        }
    }

    private var heatmapModel: HeatmapModel {
        HeatmapModel.make(
            days: store.currentHistory.daily ?? [],
            metric: .tokens,
            weekCount: HeatmapModel.columnCount(forWidth: activityCardWidth)
        )
    }

    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.headerToCardSpacing) {
            SectionHeader(title)
            SurfaceCard(content: content)
        }
    }
}

#Preview {
    NavigationStack {
        InsightsView()
            .environment(TokenMonitorStore.preview)
            .environment(AppPreferences.preview)
    }
}

private struct MonthlyHistoryCard: View {
    @Environment(\.locale) private var locale

    let months: [HistoryMonth]
    let currency: AppCurrency

    var body: some View {
        if visibleMonths.isEmpty {
            Text("No Usage Yet")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(visibleMonths.enumerated()), id: \.element.id) { index, month in
                    if index > 0 {
                        Divider()
                    }
                    row(month)
                }
            }
        }
    }

    private func row(_ month: HistoryMonth) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(monthTitle(month))
                    .font(.headline)
                Text(month.activeTimeMs.map {
                    MetricFormatter.duration(milliseconds: $0, locale: locale)
                } ?? "—")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(month.tokens.map(MetricFormatter.tokens) ?? "—")
                    .bold()
                    .monospacedDigit()
                Text(month.cost.map {
                    MetricFormatter.currencyFromUSD($0, currency: currency)
                } ?? "—")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(alignment: .leading) {
            GeometryReader { geometry in
                Capsule()
                    .fill(DesignTokens.accent.opacity(0.10))
                    .frame(width: geometry.size.width * share(for: month))
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var visibleMonths: [HistoryMonth] {
        Array(months.sorted {
            ($0.dateValue ?? .distantPast) > ($1.dateValue ?? .distantPast)
        }.prefix(6))
    }

    private var maxTokens: Double {
        visibleMonths.compactMap(\.tokens).max() ?? 0
    }

    private func share(for month: HistoryMonth) -> Double {
        guard maxTokens > 0, let tokens = month.tokens, tokens > 0 else {
            return 0
        }
        return min(1, tokens / maxTokens)
    }

    private func monthTitle(_ month: HistoryMonth) -> String {
        month.dateValue?.formatted(.dateTime.month(.wide).year())
            ?? month.month
            ?? "Unknown month"
    }
}
