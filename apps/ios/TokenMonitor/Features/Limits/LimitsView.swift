import SwiftUI

struct LimitsView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store

    @State private var showsOrderEditor = false

    var body: some View {
        Group {
            if let stats = store.stats {
                let providers = stats.orderedLimits(
                    order: preferences.limitProviderOrder,
                    hidden: preferences.hiddenLimitProviders
                )
                let groups = LimitProviderGroup.grouped(providers)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: DesignTokens.sectionSpacing) {
                            ConnectionStatusNotice(phase: store.phase, retry: refresh)

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
                                ForEach(groups) { group in
                                    SurfaceCard {
                                        ProviderLimitCard(providers: group.accounts)
                                    }
                                    .id(group.id)
                                }
                            }

                            ViewThatFits(in: .horizontal) {
                                HStack {
                                    customizationButton
                                    Spacer()
                                    refreshButton
                                }
                                VStack(alignment: .leading, spacing: 4) {
                                    customizationButton
                                    refreshButton
                                }
                            }
                            .font(.footnote)
                            .labelStyle(.titleAndIcon)
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
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
                        if arguments.contains("--sample-limits-editor") {
                            showsOrderEditor = true
                        }
                        let prefix = "--sample-scroll="
                        if let anchor = arguments
                            .first(where: { $0.hasPrefix(prefix) })
                            .map({ String($0.dropFirst(prefix.count)) }) {
                            await Task.yield()
                            proxy.scrollTo(anchor, anchor: .top)
                        }
                        #endif
                    }
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
        .modifier(RootPageHeader("AI Limits"))
        .background {
            AppBackground()
        }
        .sheet(isPresented: $showsOrderEditor) {
            NavigationStack {
                LimitProviderOrderEditor()
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") { showsOrderEditor = false }
                                .fontWeight(.semibold)
                        }
                    }
            }
        }
    }

    private var customizationButton: some View {
        Button {
            showsOrderEditor = true
        } label: {
            Label("Customize AI Limits", systemImage: "slider.horizontal.3")
                .frame(minHeight: DesignTokens.controlHeight)
                .contentShape(.rect)
        }
    }

    private var refreshButton: some View {
        Button(action: refresh) {
            Label("Refresh", systemImage: "arrow.clockwise")
                .frame(minHeight: DesignTokens.controlHeight)
                .contentShape(.rect)
        }
        .disabled(store.isRefreshing)
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
