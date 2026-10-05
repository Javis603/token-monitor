import SwiftUI

struct OverviewView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store

    @Binding var selectedTab: AppTab

    var body: some View {
        @Bindable var store = store

        ZStack {
            AppBackground()

            if let stats = store.stats {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(
                            alignment: .leading,
                            spacing: DesignTokens.sectionSpacing
                        ) {
                            ConnectionStatusNotice(phase: store.phase, retry: refresh)
                            PeriodPicker(selection: $store.selectedPeriod)
                            HeroSummaryCard(
                                periodKey: store.selectedPeriod,
                                period: store.currentPeriod,
                                updatedAt: stats.updatedAt
                            )
                            LimitPreviewSection(
                                groups: Array(limitGroups.prefix(preferences.homeLimitCount)),
                                showAll: showLimits
                            )
                            section("Trend") {
                                InsightTrendCard(history: store.currentHistory, compact: true)
                            }
                            .id("overview-trend")
                            section("Tools") {
                                BreakdownCard(
                                    kind: .tool,
                                    entries: store.currentPeriod.clientEntries,
                                    total: store.currentPeriod.totalTokens ?? 0, limit: 3
                                )
                            }
                            section("Models") {
                                BreakdownCard(
                                    kind: .model,
                                    entries: store.currentPeriod.modelEntries,
                                    total: store.currentPeriod.totalTokens ?? 0, limit: 3
                                )
                            }
                            section("Devices") {
                                DeviceListCard(devices: stats.sortedDevices, period: store.selectedPeriod)
                            }
                            .id("overview-bottom")
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
                            "--sample-overview-bottom"
                        ) else { return }
                        await Task.yield()
                        proxy.scrollTo("overview-bottom", anchor: .bottom)
                        #endif
                    }
                }
            } else {
                OverviewUnavailableView(
                    phase: store.phase,
                    openSettings: showSettings
                )
                .padding(DesignTokens.screenPadding)
            }
        }
        .navigationTitle("Overview")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
                    .disabled(store.isRefreshing)
            }
        }
    }

    private var limitGroups: [LimitProviderGroup] {
        LimitProviderGroup.grouped(
            store.stats?.orderedLimits(
                order: preferences.limitProviderOrder,
                hidden: preferences.hiddenLimitProviders
            ) ?? []
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

    private func refresh() {
        Task {
            await store.refresh()
        }
    }

    private func showLimits() {
        selectedTab = .limits
    }

    private func showSettings() {
        selectedTab = .settings
    }
}

#Preview {
    @Previewable @State var selectedTab: AppTab = .overview
    NavigationStack {
            OverviewView(selectedTab: $selectedTab)
                .environment(TokenMonitorStore.preview)
                .environment(AppPreferences.preview)
    }
}
