import SwiftUI

struct LimitsView: View {
    @Environment(TokenMonitorStore.self) private var store
    @Environment(AppPreferences.self) private var preferences

    var body: some View {
        ZStack {
            AppBackground()

            if let stats = store.stats {
                let providers = stats.sortedLimits
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        ConnectionStatusNotice(phase: store.phase, retry: refresh)
                        LimitsSummaryHeader(
                            providers: providers,
                            updatedAt: stats.limits?.updatedAt
                        )

                        if providers.isEmpty {
                            ContentUnavailableView(
                                "No AI Limits",
                                systemImage: "gauge.open.with.lines.needle.33percent",
                                description: Text(
                                    "Enable AI Tool Limits on a reporting device. Provider credentials never need to be stored on this iPhone."
                                )
                            )
                            .padding(.vertical, 50)
                        } else {
                            ForEach(providers) { provider in
                                SurfaceCard {
                                    ProviderLimitCard(provider: provider)
                                }
                            }
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
                ContentUnavailableView(
                    "Connect Your Hub",
                    systemImage: "link.badge.plus",
                    description: Text(
                        "Configure a Hub in Settings to see provider quotas."
                    )
                )
                .padding(DesignTokens.screenPadding)
            }
        }
        .navigationTitle("AI Limits")
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
}

#Preview {
    NavigationStack {
        LimitsView()
            .environment(TokenMonitorStore.preview)
            .environment(AppPreferences.preview)
    }
}
