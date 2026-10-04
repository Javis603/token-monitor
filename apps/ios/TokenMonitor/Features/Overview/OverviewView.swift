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
                        spacing: DesignTokens.sectionSpacing
                    ) {
                        ConnectionStatusNotice(phase: store.phase, retry: refresh)
                        PeriodPicker(selection: $store.selectedPeriod)
                        HeroSummaryCard(
                            periodKey: store.selectedPeriod,
                            period: store.currentPeriod,
                            updatedAt: stats.updatedAt
                        )
                        NavigationLink {
                            SessionsView()
                        } label: {
                            HStack {
                                Label("Sessions", systemImage: "bubble.left.and.bubble.right")
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                            }
                            .font(.headline)
                            .padding(.vertical, 12)
                            .padding(.horizontal, 18)
                        }
                        .modifier(AppActionStyle())

                        LimitPreviewSection(
                            providers: Array(stats.sortedLimits.prefix(preferences.homeLimitCount)),
                            showAll: showLimits
                        )
                        SurfaceCard {
                            UsageTrendCard(history: store.currentHistory, metric: .tokens)
                        }
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Usage breakdown")
                                .font(.title2.bold())
                                .accessibilityAddTraits(.isHeader)
                            SurfaceCard {
                                BreakdownCard(
                                    title: "Tools", imageName: "SectionTools", kind: .tool,
                                    entries: store.currentPeriod.clientEntries,
                                    total: store.currentPeriod.totalTokens ?? 0, limit: 3
                                )
                            }
                            SurfaceCard {
                                BreakdownCard(
                                    title: "Models", imageName: "SectionModels", kind: .model,
                                    entries: store.currentPeriod.modelEntries,
                                    total: store.currentPeriod.totalTokens ?? 0, limit: 3
                                )
                            }
                        }
                        SurfaceCard {
                            DeviceListCard(devices: stats.sortedDevices, period: store.selectedPeriod)
                        }
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
