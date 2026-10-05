import SwiftUI

// Live Activity customizer: the preview stage, controls, data source and the
// per-surface option gallery all render the same shared views the widget
// extension draws — never a parallel preview-only layout.
struct LiveActivityCustomizerView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store
    @Environment(LiveActivityController.self) private var liveActivity

    private let snapshotStore = SharedSnapshotStore()

    enum PreviewPage: Int, CaseIterable, Identifiable {
        case compact
        case expanded
        case lockScreen

        var id: Int { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .compact: "Compact"
            case .expanded: "Expanded"
            case .lockScreen: "Lock Screen"
            }
        }
    }

    private enum CompactSide: String, CaseIterable {
        case leading
        case trailing
    }

    @State private var page: PreviewPage
    @State private var compactSide: CompactSide = .leading
    @State private var updating = false

    init() {
        var initial: PreviewPage = .compact
        #if DEBUG
        let prefix = "--sample-customizer-page="
        if let value = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix(prefix) })
            .map({ String($0.dropFirst(prefix.count)) }) {
            initial = switch value {
            case "expanded": .expanded
            case "lockScreen", "lock": .lockScreen
            default: .compact
            }
        }
        #endif
        _page = State(initialValue: initial)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: DesignTokens.sectionSpacing) {
                stage
                controls
                data
                gallery
            }
            .padding(.horizontal, DesignTokens.screenPadding)
            .padding(.bottom, 32)
        }
        .background { AppBackground() }
        .navigationTitle("Live Activity")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: preferences.liveActivityEnabled) { _, enabled in
            Task { await setEnabled(enabled) }
        }
        .onChange(of: layoutSignature) { _, _ in
            Task { await refresh() }
        }
        .onChange(of: dataSignature) { _, _ in
            Task { await refresh() }
        }
    }

    /// Any change to layout/data options re-pushes the running activity and
    /// re-registers the preferences with the Hub.
    private var layoutSignature: String {
        [
            preferences.liveCompactLeading.rawValue,
            preferences.liveCompactTrailing.rawValue,
            preferences.liveExpandedStyle.rawValue,
            preferences.liveLockScreenStyle.rawValue
        ].joined(separator: "|")
    }

    private var dataSignature: String {
        [
            preferences.livePeriod.rawValue,
            preferences.liveProviderID,
            preferences.currency.rawValue,
            preferences.language.rawValue
        ].joined(separator: "|")
    }

    /// Live snapshot when the Hub is connected, sample data otherwise — the
    /// same source the running activity renders.
    private var previewState: TokenMonitorActivityAttributes.ContentState {
        LiveActivityController.contentState(
            snapshot: latestSnapshot(),
            preferences: preferences.sharedPreferences
        )
    }

    private func latestSnapshot() -> TokenMonitorSharedPayload.Snapshot {
        if let stats = store.stats {
            return TokenMonitorSharedPayload.Snapshot.make(
                stats: stats,
                history: store.currentHistory,
                limitProviderOrder: preferences.limitProviderOrder,
                hiddenLimitProviders: preferences.hiddenLimitProviders
            )
        }
        return TokenMonitorSharedPayload.Snapshot.make(
            stats: .sample,
            history: .sample
        )
    }

    private func state(
        leading: ActivityState.CompactLeadingOption? = nil,
        trailing: ActivityState.CompactTrailingOption? = nil,
        expanded: ActivityState.SurfaceStyle? = nil,
        lockScreen: ActivityState.SurfaceStyle? = nil
    ) -> ActivityState {
        var copy = previewState
        if let leading { copy.layout.compactLeading = leading.rawValue }
        if let trailing { copy.layout.compactTrailing = trailing.rawValue }
        if let expanded { copy.layout.expanded = expanded.rawValue }
        if let lockScreen { copy.layout.lockScreen = lockScreen.rawValue }
        return copy
    }

    private typealias ActivityState = TokenMonitorActivityAttributes.ContentState

    private var isStale: Bool {
        previewState.sourceStale == true
    }

    // MARK: - Preview stage

    private var stage: some View {
        VStack(spacing: 10) {
            TabView(selection: $page) {
                compactStage.tag(PreviewPage.compact)
                expandedStage.tag(PreviewPage.expanded)
                lockScreenStage.tag(PreviewPage.lockScreen)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(height: page == .lockScreen ? 300 : 190)
            .animation(.default, value: page)
            HStack(spacing: 7) {
                ForEach(PreviewPage.allCases) { item in
                    Circle()
                        .fill(item == page ? Color.primary : Color.secondary.opacity(0.35))
                        .frame(width: 6, height: 6)
                        .onTapGesture {
                            withAnimation { page = item }
                        }
                }
            }
            .accessibilityElement(children: .ignore)
            Text("Swipe to see other modes")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// Soft wallpaper + phone-top chrome shared by the island mocks.
    private var wallpaper: LinearGradient {
        LinearGradient(
            colors: [DesignTokens.accent.opacity(0.32), Color.purple.opacity(0.28), DesignTokens.accent.opacity(0.12)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var island: some View {
        Capsule()
            .fill(.black)
            .frame(width: 118, height: 34)
    }

    private var compactStage: some View {
        ZStack(alignment: .top) {
            wallpaper
            island
                .padding(.top, 10)
                .overlay(alignment: .top) {
                    HStack(spacing: 0) {
                        ActivityCompactLeadingView(state: previewState, isStale: isStale)
                        Spacer()
                        ActivityCompactTrailingView(state: previewState, isStale: isStale)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .frame(height: 34)
                }
        }
        .clipShape(.rect(cornerRadius: 30, style: .continuous))
        .environment(\.colorScheme, .dark)
    }

    private var expandedStage: some View {
        // The expanded island is one continuous black shape hugging the top of
        // the mock — no separate pill above it.
        ZStack(alignment: .top) {
            wallpaper
            ActivityExpandedView(state: previewState, isStale: isStale)
                .foregroundStyle(.white)
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity)
                .background(.black, in: .rect(cornerRadius: 40, style: .continuous))
                .padding(.horizontal, 10)
        }
        .clipShape(.rect(cornerRadius: 30, style: .continuous))
        .environment(\.colorScheme, .dark)
    }

    private var lockScreenStage: some View {
        ZStack(alignment: .top) {
            wallpaper
            VStack(spacing: 14) {
                island.opacity(0)
                VStack(spacing: 0) {
                    Text(Date.now, format: .dateTime.weekday(.wide).month().day())
                        .font(.subheadline)
                    Text("9:41")
                        .font(.system(size: 64, weight: .semibold, design: .rounded))
                }
                .foregroundStyle(.white)
                ActivityLockScreenView(state: previewState, isStale: isStale)
                    .foregroundStyle(.white)
                    .modifier(LockScreenGlass())
            }
            .padding(.top, 10)
            .padding(.horizontal, 14)
        }
        .clipShape(.rect(cornerRadius: 30, style: .continuous))
        .environment(\.colorScheme, .dark)
    }

    // MARK: - Controls

    private var controls: some View {
        SurfaceCard {
            @Bindable var preferences = preferences
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Enable Live Activity", isOn: $preferences.liveActivityEnabled)
                statusLine
                Button {
                    Task { await updateNow() }
                } label: {
                    Label("Update now", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(updating || !preferences.liveActivityEnabled || store.stats == nil)
                .opacity(updating ? 0.6 : 1)
            }
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        if !preferences.liveActivityEnabled {
            Label("Off", systemImage: "pause.circle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else if liveActivity.remoteUpdatesEnabled {
            Label("Remote push active", systemImage: "antenna.radiowaves.left.and.right")
                .font(.subheadline)
                .foregroundStyle(DesignTokens.accent)
        } else if let message = liveActivity.remoteUpdateMessage {
            VStack(alignment: .leading, spacing: 2) {
                Label("Remote push unavailable", systemImage: "antenna.radiowaves.left.and.right.slash")
                    .font(.subheadline.weight(.medium))
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if let error = liveActivity.errorMessage {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(DesignTokens.critical)
        } else {
            Label("Updating locally", systemImage: "iphone.badge.play")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Data

    private var data: some View {
        SurfaceCard {
            @Bindable var preferences = preferences
            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Quota source") {
                    Picker("Quota source", selection: $preferences.liveProviderID) {
                        Text("Auto — most constrained").tag("")
                        ForEach(quotaProviderIDs, id: \.self) { providerID in
                            Label(
                                ProviderPresentation.displayName(for: providerID),
                                image: ProviderPresentation.assetName(for: providerID)
                            )
                            .tag(providerID)
                        }
                    }
                    .labelsHidden()
                }
                Divider()
                LabeledContent("Period") {
                    Picker("Period", selection: $preferences.livePeriod) {
                        Text("Today").tag(UsagePeriodKey.today)
                        Text("This month").tag(UsagePeriodKey.month)
                    }
                    .labelsHidden()
                }
            }
        }
    }

    /// Providers present in the Hub data, in the user's AI Limits order.
    private var quotaProviderIDs: [String] {
        let ids = ((store.stats ?? .sample).limits?.providers ?? [])
            .map(\.normalizedProviderID)
        return LimitProviderOrder.sortedIDs(
            ids + [preferences.liveProviderID].filter { !$0.isEmpty },
            order: preferences.limitProviderOrder
        )
    }

    // MARK: - Option gallery

    private var gallery: some View {
        SurfaceCard {
            switch page {
            case .compact:
                compactGallery
            case .expanded:
                expandedGallery
            case .lockScreen:
                lockScreenGallery
            }
        }
    }

    private var compactGallery: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Side", selection: $compactSide) {
                Text("Left").tag(CompactSide.leading)
                Text("Right").tag(CompactSide.trailing)
            }
            .pickerStyle(.segmented)
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: 10),
                    count: 4
                ),
                spacing: 10
            ) {
                if compactSide == .leading {
                    ForEach(ActivityState.CompactLeadingOption.allCases, id: \.self) { option in
                        compactTile(option)
                    }
                } else {
                    ForEach(ActivityState.CompactTrailingOption.allCases, id: \.self) { option in
                        compactTile(option)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func compactTile(_ option: ActivityState.CompactLeadingOption) -> some View {
        optionTile(
            caption: option.caption,
            selected: preferences.liveCompactLeading.rawValue == option.rawValue
        ) {
            ActivityCompactLeadingView(state: state(leading: option), isStale: isStale)
        } action: {
            preferences.liveCompactLeading = .init(rawValue: option.rawValue) ?? .mark
        }
    }

    @ViewBuilder
    private func compactTile(_ option: ActivityState.CompactTrailingOption) -> some View {
        optionTile(
            caption: option.caption,
            selected: preferences.liveCompactTrailing.rawValue == option.rawValue
        ) {
            ActivityCompactTrailingView(state: state(trailing: option), isStale: isStale)
        } action: {
            preferences.liveCompactTrailing = .init(rawValue: option.rawValue) ?? .percent
        }
    }

    @ViewBuilder
    private func optionTile(
        caption: LocalizedStringKey,
        selected: Bool,
        @ViewBuilder content: () -> some View,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                content()
                    .foregroundStyle(.white)
                    .environment(\.colorScheme, .dark)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(.black, in: .rect(cornerRadius: 14, style: .continuous))
                    .overlay(alignment: .topTrailing) {
                        if selected {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(DesignTokens.accent)
                                .offset(x: 4, y: -4)
                        }
                    }
                    .overlay {
                        if selected {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(DesignTokens.accent, lineWidth: 1.5)
                        }
                    }
                Text(caption)
                    .font(.caption2.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? .primary : .secondary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var expandedGallery: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(ActivityState.SurfaceStyle.allCases, id: \.self) { style in
                Button {
                    preferences.liveExpandedStyle = .init(rawValue: style.rawValue) ?? .quota
                } label: {
                    expandedTile(style)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func expandedTile(_ style: ActivityState.SurfaceStyle) -> some View {
        ActivityExpandedView(state: state(expanded: style), isStale: isStale)
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.black, in: .rect(cornerRadius: 20, style: .continuous))
            .overlay(alignment: .topTrailing) {
                if preferences.liveExpandedStyle.rawValue == style.rawValue {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.body)
                        .foregroundStyle(DesignTokens.accent)
                        .offset(x: 6, y: -6)
                }
            }
            .overlay {
                if preferences.liveExpandedStyle.rawValue == style.rawValue {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(DesignTokens.accent, lineWidth: 1.5)
                }
            }
            .environment(\.colorScheme, .dark)
            .accessibilityLabel(Text(style.caption))
            .accessibilityAddTraits(preferences.liveExpandedStyle.rawValue == style.rawValue ? .isSelected : [])
    }

    private var lockScreenGallery: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(ActivityState.SurfaceStyle.allCases, id: \.self) { style in
                Button {
                    preferences.liveLockScreenStyle = .init(rawValue: style.rawValue) ?? .combined
                } label: {
                    lockScreenTile(style)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func lockScreenTile(_ style: ActivityState.SurfaceStyle) -> some View {
        ActivityLockScreenView(state: state(lockScreen: style), isStale: isStale)
            .foregroundStyle(.white)
            .modifier(LockScreenGlass())
            .background(wallpaper.clipShape(.rect(cornerRadius: 22, style: .continuous)))
            .overlay(alignment: .topTrailing) {
                if preferences.liveLockScreenStyle.rawValue == style.rawValue {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.body)
                        .foregroundStyle(DesignTokens.accent)
                        .offset(x: 8, y: -8)
                }
            }
            .accessibilityLabel(Text(style.caption))
            .accessibilityAddTraits(preferences.liveLockScreenStyle.rawValue == style.rawValue ? .isSelected : [])
    }

    // MARK: - Applying

    private func setEnabled(_ enabled: Bool) async {
        await liveActivity.setEnabled(
            enabled,
            snapshot: latestSnapshot(),
            preferences: preferences.sharedPreferences
        )
    }

    private func refresh() async {
        guard preferences.liveActivityEnabled else { return }
        await liveActivity.update(
            snapshot: latestSnapshot(),
            preferences: preferences.sharedPreferences
        )
    }

    private func updateNow() async {
        updating = true
        defer { updating = false }
        await store.refresh()
        if let snapshot = try? snapshotStore.load().snapshot {
            await liveActivity.update(
                snapshot: snapshot,
                preferences: preferences.sharedPreferences
            )
        } else {
            await refresh()
        }
    }
}

/// iOS 26 renders the Lock Screen activity on host glass; the same modifier on
/// the customizer tiles keeps the preview honest.
private struct LockScreenGlass: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        content
            .background {
                if reduceTransparency {
                    Color(uiColor: .secondarySystemGroupedBackground)
                } else {
                    Color.white.opacity(0.16)
                }
            }
            .background(.ultraThinMaterial)
            .clipShape(.rect(cornerRadius: 22, style: .continuous))
    }
}

extension TokenMonitorActivityAttributes.ContentState.CompactLeadingOption {
    var caption: LocalizedStringKey {
        switch self {
        case .mark: "Mark"
        case .ring: "Ring"
        case .tokens: "Tokens"
        case .cost: "Cost"
        }
    }
}

extension TokenMonitorActivityAttributes.ContentState.CompactTrailingOption {
    var caption: LocalizedStringKey {
        switch self {
        case .percent: "Percent"
        case .reset: "Reset"
        case .tokens: "Tokens"
        case .cost: "Cost"
        case .ring: "Ring"
        }
    }
}

extension TokenMonitorActivityAttributes.ContentState.SurfaceStyle {
    var caption: LocalizedStringKey {
        switch self {
        case .quota: "Quota"
        case .usage: "Usage"
        case .combined: "Combined"
        }
    }
}

#Preview {
    NavigationStack {
        LiveActivityCustomizerView()
            .environment(TokenMonitorStore.preview)
            .environment(AppPreferences.preview)
            .environment(LiveActivityController())
    }
}
