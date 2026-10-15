import SwiftUI

struct BreakdownDetailView: View {
    @Environment(TokenMonitorStore.self) private var store
    let kind: BreakdownKind

    var body: some View {
        @Bindable var store = store
        ZStack {
            AppBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: DesignTokens.sectionSpacing) {
                    PeriodPicker(selection: $store.selectedPeriod)
                    if entries.isEmpty {
                        ContentUnavailableView("No breakdown available", systemImage: "chart.bar.xaxis")
                            .padding(.vertical, 56)
                    } else {
                        SurfaceCard {
                            LazyVStack(alignment: .leading, spacing: DesignTokens.rowDividerSpacing) {
                                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                                    if index > 0 { Divider() }
                                    BreakdownItem(kind: kind, entry: entry,
                                                  total: store.currentPeriod.totalTokens ?? 0,
                                                  barMaximum: maximum, showsCost: true)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, DesignTokens.screenPadding)
                .padding(.top, 8)
                .padding(.bottom, DesignTokens.sectionSpacing)
            }
            .refreshable { await store.refresh() }
        }
        .navigationTitle(Text(LocalizedStringKey(kind.title)))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
    }

    private var entries: [BreakdownEntry] {
        switch kind {
        case .tool: store.currentPeriod.clientEntries
        case .model: store.currentPeriod.modelEntries
        }
    }

    private var maximum: Double { UsageRowPresentation.maximum(entries.map(\.value)) }
}
