import SwiftUI

struct OverviewView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @Binding var selectedTab: AppTab
    @State private var showsOrderEditor = false
    @State private var surfaceStatus = SystemSurfaceStatus()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var store = store

        Group {
            if let stats = store.stats {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(
                            alignment: .leading,
                            spacing: DesignTokens.sectionSpacing
                        ) {
                            ConnectionStatusNotice(phase: store.connectionNoticePhase, retry: refresh)
                            ForEach(visibleSections) { section in
                                switch section {
                                case .summary:
                                    HeroSummaryCard(period: store.currentPeriod)
                                    SystemSurfacesHint(widgetCount: surfaceStatus.widgetCount)
                                case .limits:
                                    LimitPreviewSection(
                                        groups: Array(limitGroups.prefix(preferences.homeLimitCount)),
                                        showAll: showLimits
                                    )
                                case .sessions:
                                    SessionsPreviewSection(
                                        sessions: sessionPeriod.sessions ?? [:],
                                        showAll: showSessions
                                    )
                                case .trend:
                                    self.section("Trend") {
                                        InsightTrendCard(history: store.currentHistory, compact: true)
                                    }
                                    .id("overview-trend")
                                case .tools:
                                    self.section("Tools", destination: .tool) {
                                        BreakdownCard(
                                            kind: .tool,
                                            entries: store.currentPeriod.clientEntries,
                                            total: store.currentPeriod.totalTokens ?? 0, limit: 3
                                        )
                                    }
                                case .models:
                                    self.section("Models", destination: .model) {
                                        BreakdownCard(
                                            kind: .model,
                                            entries: store.currentPeriod.modelEntries,
                                            total: store.currentPeriod.totalTokens ?? 0, limit: 3
                                        )
                                    }
                                case .devices:
                                    VStack(alignment: .leading, spacing: DesignTokens.headerToCardSpacing) {
                                        SectionHeader("Devices") {
                                            SectionNavigationLink(title: "Devices") { DevicesView() }
                                        }
                                        SurfaceCard {
                                            DeviceListCard(devices: stats.usageDevices(for: store.selectedPeriod), period: store.selectedPeriod)
                                        }
                                    }
                                }
                            }
                            if !visibleSections.contains(.summary) {
                                SystemSurfacesHint(widgetCount: surfaceStatus.widgetCount)
                            }
                            if visibleSections.isEmpty {
                                ContentUnavailableView {
                                    Label("No Overview sections", systemImage: "square.grid.2x2")
                                } description: {
                                    Text("Choose the sections you want to see.")
                                } actions: {
                                    Button("Customize Overview") { showsOrderEditor = true }
                                        .buttonStyle(.borderedProminent)
                                        .controlSize(.large)
                                        .frame(minHeight: DesignTokens.controlHeight)
                                }
                                .padding(.vertical, 24)
                            }
                            if !visibleSections.isEmpty {
                                Button {
                                    showsOrderEditor = true
                                } label: {
                                    Label("Customize Overview", systemImage: "slider.horizontal.3")
                                        .frame(minHeight: DesignTokens.controlHeight)
                                        .contentShape(.rect)
                                }
                                .font(.footnote)
                                .buttonStyle(.plain)
                                .foregroundStyle(.secondary)
                                .id("overview-bottom")
                            }
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
                    isRefreshing: store.isRefreshing,
                    refresh: refresh,
                    openSettings: showSettings
                )
                .padding(DesignTokens.screenPadding)
            }
        }
        .modifier(RootPageHeader("Overview", brandMark: "Σ.") {
            if preferences.showsLiveTokenRate {
                TimelineView(.periodic(from: .now, by: 2)) { timeline in
                    LiveSpeedBadge(reading: store.liveOutputRate(at: timeline.date))
                }
            }
        } controls: {
            ViewThatFits(in: .horizontal) {
                PeriodPicker(selection: $store.selectedPeriod, compact: true)
                    .fixedSize(horizontal: true, vertical: false)
                Menu {
                    Picker("Period", selection: $store.selectedPeriod) {
                        ForEach(UsagePeriodKey.allCases) { period in
                            Text(LocalizedStringKey(period.shortLabel)).tag(period)
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(LocalizedStringKey(store.selectedPeriod.shortLabel))
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .font(.subheadline.weight(.medium))
                    .frame(minWidth: DesignTokens.controlHeight, minHeight: DesignTokens.controlHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .sensoryFeedback(.selection, trigger: store.selectedPeriod)
                .accessibilityLabel("Period")
                .accessibilityValue(Text(LocalizedStringKey(store.selectedPeriod.shortLabel)))
            }
        })
        .background {
            AppBackground()
        }
        .task { await surfaceStatus.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await surfaceStatus.refresh() } }
        }
        .sheet(isPresented: $showsOrderEditor) {
            NavigationStack {
                OverviewSectionOrderEditor()
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") { showsOrderEditor = false }
                                .fontWeight(.semibold)
                        }
                    }
            }
        }
    }

    private var visibleSections: [OverviewSection] {
        OverviewSection.ordered(by: preferences.overviewSectionOrder)
            .filter { !preferences.hiddenOverviewSections.contains($0.id) }
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
        destination: BreakdownKind? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.headerToCardSpacing) {
            SectionHeader(title) {
                if let destination {
                    SectionNavigationLink(title: title) { BreakdownDetailView(kind: destination) }
                }
            }
            SurfaceCard(content: content)
        }
    }

    /// The Sessions tab reads today/month only; Total falls back to today so
    /// the preview keeps live sessions while retaining the alias projection.
    private var sessionPeriod: UsagePeriod {
        store.displayPeriod(store.selectedPeriod == .allTime ? .today : store.selectedPeriod)
    }

    private func refresh() {
        Task {
            await store.refresh()
        }
    }

    private func showLimits() {
        selectedTab = .limits
    }

    private func showSessions() {
        selectedTab = .sessions
    }

    private func showSettings() {
        selectedTab = .settings
    }
}

private struct LiveSpeedBadge: View {
    let reading: LiveTokenRateTracker.Reading?

    private var value: String {
        guard let reading else { return "—" }
        let rate = reading.tokensPerSecond
        if rate > 0 && rate < 0.1 { return "<0.1" }
        if rate > 0 && rate < 1 {
            return rate.formatted(.number.precision(.fractionLength(1)))
        }
        let rounded = rate.rounded()
        return rounded < 10_000
            ? MetricFormatter.exactTokens(rounded)
            : MetricFormatter.tokens(rounded)
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "bolt.fill")
                .font(.caption.weight(.semibold))
            Text(verbatim: "\(value) tok/s")
                .monospacedDigit()
                .contentTransition(.numericText())
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(reading?.isIdle == false ? Color.primary : Color.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Live speed")
        .accessibilityValue(Text(verbatim: "\(value) tok/s"))
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
