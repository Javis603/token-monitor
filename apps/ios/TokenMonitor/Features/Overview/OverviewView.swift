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
                ScrollView {
                    LazyVStack(
                        alignment: .leading,
                        spacing: 16
                    ) {
                        ConnectionStatusNotice(phase: store.phase, retry: refresh)
                        PeriodPicker(selection: $store.selectedPeriod)
                        HeroSummaryCard(
                            periodKey: store.selectedPeriod,
                            period: store.currentPeriod,
                            updatedAt: stats.updatedAt
                        )
                        Divider()
                        LimitPreviewSection(
                            providers: Array(stats.sortedLimits.prefix(preferences.homeLimitCount)),
                            showAll: showLimits
                        )
                        Divider()
                        UsageTrendCard(history: store.currentHistory, metric: .tokens)
                        Divider()
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Usage breakdown")
                                .font(.title3.weight(.semibold))
                                .accessibilityAddTraits(.isHeader)
                            BreakdownCard(
                                title: "Tools", imageName: "SectionTools", kind: .tool,
                                entries: store.currentPeriod.clientEntries,
                                total: store.currentPeriod.totalTokens ?? 0, limit: 3
                            )
                            Divider()
                            BreakdownCard(
                                title: "Models", imageName: "SectionModels", kind: .model,
                                entries: store.currentPeriod.modelEntries,
                                total: store.currentPeriod.totalTokens ?? 0, limit: 3
                            )
                        }
                        Divider()
                        DeviceListCard(devices: stats.sortedDevices, period: store.selectedPeriod)
                    }
                    .padding(.horizontal, DesignTokens.screenPadding)
                    .padding(.top, 8)
                    .padding(.bottom, DesignTokens.sectionSpacing)
                }
                .refreshable {
                    await store.refresh()
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
