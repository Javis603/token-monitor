import SwiftUI

struct InsightsView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store

    var body: some View {
        @Bindable var store = store

        ZStack {
            AppBackground()

            if store.stats != nil {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            ConnectionStatusNotice(phase: store.phase) {
                                Task { await store.refresh() }
                            }
                            VStack(alignment: .leading, spacing: 16) {
                                Text("Lifetime")
                                    .font(.title3.weight(.semibold))
                                    .accessibilityAddTraits(.isHeader)
                                InsightStatsGrid(summary: store.currentHistory.summary)
                            }
                            .padding(.bottom, 8)
                            InsightTrendCard(history: store.currentHistory)
                            Divider()
                            VStack(alignment: .leading, spacing: 16) {
                                Text("Usage breakdown")
                                    .font(.title3.weight(.semibold))
                                    .accessibilityAddTraits(.isHeader)
                                PeriodPicker(selection: $store.selectedPeriod)
                                BreakdownCard(
                                    title: "Tools", imageName: "SectionTools", kind: .tool,
                                    entries: store.currentPeriod.clientEntries,
                                    total: store.currentPeriod.totalTokens ?? 0, limit: 4
                                )
                                Divider()
                                BreakdownCard(
                                    title: "Models", imageName: "SectionModels", kind: .model,
                                    entries: store.currentPeriod.modelEntries,
                                    total: store.currentPeriod.totalTokens ?? 0, limit: 4
                                )
                            }
                            Divider()
                            MonthlyHistorySection(
                                months: store.currentHistory.monthly ?? [],
                                currency: preferences.currency
                            )
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
                        guard ProcessInfo.processInfo.arguments.contains(
                            "--sample-insights-bottom"
                        ) else { return }
                        await Task.yield()
                        proxy.scrollTo("monthly-history", anchor: .top)
                        #endif
                    }
                }
            } else {
                ContentUnavailableView(
                    "No Insights",
                    systemImage: "chart.xyaxis.line",
                    description: Text(
                        "Connect a Hub to explore usage trends, tools, and models."
                    )
                )
                .padding(DesignTokens.screenPadding)
            }
        }
        .navigationTitle("Insights")
    }
}

#Preview {
    NavigationStack {
        InsightsView()
            .environment(TokenMonitorStore.preview)
            .environment(AppPreferences.preview)
    }
}

private struct MonthlyHistorySection: View {
    @Environment(\.locale) private var locale

    let months: [HistoryMonth]
    let currency: AppCurrency

    var body: some View {
        if !visibleMonths.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Monthly history")
                    .font(.headline)

                ForEach(Array(visibleMonths.enumerated()), id: \.element.id) { index, month in
                    if index > 0 {
                        Divider()
                    }

                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(monthTitle(month))
                                .font(.headline)
                            Text(month.activeTimeMs.map {
                                MetricFormatter.duration(
                                    milliseconds: $0,
                                    locale: locale
                                )
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
                    .padding(.vertical, 5)
                }
            }
        }
    }

    private var visibleMonths: [HistoryMonth] {
        Array(months.sorted {
            ($0.dateValue ?? .distantPast) > ($1.dateValue ?? .distantPast)
        }.prefix(6))
    }

    private func monthTitle(_ month: HistoryMonth) -> String {
        month.dateValue?.formatted(.dateTime.month(.wide).year())
            ?? month.month
            ?? "Unknown month"
    }
}
