import SwiftUI

// Live Activity customizer. A swipeable stage previews each surface — compact
// island, the minimal bubble shown beside another activity, expanded island and
// Lock Screen — on an iPhone drawn at true geometry. On the compact page,
// tapping either side of the island selects that slot (an arc hugs its end);
// the tiles below fill the selected slot, and "Edit" opens the slot's data
// source. Every preview and tile renders the same shared views the widget draws.
struct LiveActivityCustomizerView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store
    @Environment(LiveActivityController.self) private var liveActivity
    @Environment(\.colorScheme) private var colorScheme

    private let snapshotStore = SharedSnapshotStore()

    enum Surface: Int, CaseIterable, Identifiable {
        case compact, minimal, expanded, lockScreen

        var id: Int { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .compact: "Compact"
            case .minimal: "With other activities"
            case .expanded: "Expanded"
            case .lockScreen: "Lock Screen"
            }
        }

        var systemImage: String {
            switch self {
            case .compact: "capsule"
            case .minimal: "circle.circle"
            case .expanded: "rectangle.topthird.inset.filled"
            case .lockScreen: "lock.rectangle"
            }
        }

        /// The letter stamped on the tile in use, as in the reference.
        var badge: String {
            switch self {
            case .compact: ""
            case .minimal: "M"
            case .expanded: "E"
            case .lockScreen: "L"
            }
        }
    }

    enum Slot {
        case leading, trailing
    }

    @State private var surface: Surface
    @State private var slot: Slot = .leading
    @State private var editing = false
    @State private var updating = false

    init() {
        var initial: Surface = .compact
        #if DEBUG
        let prefix = "--sample-customizer-page="
        if let value = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix(prefix) })
            .map({ String($0.dropFirst(prefix.count)) }) {
            initial = switch value {
            case "minimal": .minimal
            case "expanded": .expanded
            case "lockScreen", "lock": .lockScreen
            default: .compact
            }
        }
        #endif
        _surface = State(initialValue: initial)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: DesignTokens.sectionSpacing) {
                stage
                controls
                gallery
            }
            .padding(.horizontal, DesignTokens.screenPadding)
            .padding(.bottom, 32)
        }
        .background { AppBackground() }
        .navigationTitle("Live Activity")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
        .sheet(isPresented: $editing) {
            sourceSheet
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .onChange(of: preferences.liveActivityEnabled) { _, enabled in
            Task { await setEnabled(enabled) }
        }
        .onChange(of: preferences.liveLayout) { _, _ in
            Task { await refresh() }
        }
        .onChange(of: dataSignature) { _, _ in
            Task { await refresh() }
        }
        .sensoryFeedback(.selection, trigger: surface)
        .sensoryFeedback(.selection, trigger: slot)
    }

    /// Data choices re-push the running activity; layout changes only re-render,
    /// since the extension reads them locally.
    private var dataSignature: String {
        [preferences.currency.rawValue, preferences.language.rawValue].joined(separator: "|")
    }

    private var layout: Binding<LiveActivityLayout> {
        Binding(get: { preferences.liveLayout }, set: { preferences.liveLayout = $0 })
    }

    private var selectedSlot: LiveActivityLayout.Slot {
        slot == .leading ? preferences.liveLayout.compactLeading : preferences.liveLayout.compactTrailing
    }

    // MARK: - Preview data

    /// Live snapshot when the Hub is connected, sample data otherwise — the
    /// same source the running activity renders.
    private var previewContext: ActivityContext {
        var state = LiveActivityController.contentState(
            snapshot: latestSnapshot(),
            preferences: preferences.sharedPreferences
        )
        if store.stats == nil, state.agents.running == 0 {
            state.agents = .init(running: 2, clients: ["claude", "codex"])
        }
        return ActivityContext(
            state: state,
            preferences: preferences.sharedPreferences,
            isStale: store.stats != nil && state.sourceStale == true
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
        return TokenMonitorSharedPayload.Snapshot.make(stats: .sample, history: .sample)
    }

    // MARK: - Stage

    /// iPhone 17 Pro portrait geometry in points. The screen renders at this
    /// width and scales to fit inside the bezel, so the island keeps its true
    /// position, size and margins.
    private enum Device {
        static let width: CGFloat = 402
        static let islandTop: CGFloat = 11
        static let islandHeight: CGFloat = 37
        static let sensorWidth: CGFloat = 96
        static let shellRadius: CGFloat = 60
        static let bezelInset: CGFloat = 7
        static let expandedInset: CGFloat = 11
    }

    private var stage: some View {
        let context = previewContext
        return VStack(spacing: 14) {
            TabView(selection: $surface.animation(.snappy)) {
                phone { compactPage(context) }.tag(Surface.compact)
                phone { minimalPage(context) }.tag(Surface.minimal)
                phone { expandedPage(context) }.tag(Surface.expanded)
                phone(dimmed: true) { lockScreenPage(context) }.tag(Surface.lockScreen)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(height: Self.stageHeight)
            HStack(spacing: 6) {
                ForEach(Surface.allCases) { item in
                    Capsule()
                        .fill(item == surface ? Color.primary : Color.secondary.opacity(0.3))
                        .frame(width: item == surface ? 18 : 6, height: 6)
                        .onTapGesture { withAnimation(.snappy) { surface = item } }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(surface.title))
            .accessibilityAdjustableAction { direction in
                let next = surface.rawValue + (direction == .increment ? 1 : -1)
                if let value = Surface(rawValue: next) { withAnimation(.snappy) { surface = value } }
            }
        }
    }

    /// The top of an iPhone: a light outer frame, the black bezel and the
    /// screen inside it, fading into the page at the bottom.
    private func phone(dimmed: Bool = false, @ViewBuilder content: () -> some View) -> some View {
        let content = content()
        return ZStack(alignment: .top) {
            RoundedRectangle(cornerRadius: Device.shellRadius, style: .continuous)
                .fill(.black)
            GeometryReader { proxy in
                let scale = proxy.size.width / Device.width
                // Match the screen corner to the same shell curve after scaling.
                let screenRadius = (Device.shellRadius - Device.bezelInset) / scale
                ZStack(alignment: .top) {
                    LinearGradient(
                        colors: [Color(red: 0.69, green: 0.77, blue: 0.98), Color(red: 0.86, green: 0.89, blue: 0.98),
                                 Color(red: 0.96, green: 0.96, blue: 0.99)],
                        startPoint: .top, endPoint: .bottom
                    )
                    .overlay(Color.black.opacity(dimmed ? 0.18 : 0))
                    content
                        .environment(\.colorScheme, .dark)
                }
                .frame(width: Device.width, height: proxy.size.height / scale, alignment: .top)
                .clipShape(.rect(cornerRadius: screenRadius, style: .continuous))
                .scaleEffect(scale, anchor: .topLeading)
            }
            .padding(Device.bezelInset)
        }
        .overlay {
            RoundedRectangle(cornerRadius: Device.shellRadius, style: .continuous)
                .strokeBorder(Color(white: 0.84), lineWidth: 1.5)
        }
        // Only the top of the phone is shown: it runs past the stage so its
        // lower corners never appear, and fades into the page.
        .frame(height: Self.stageHeight + 120, alignment: .top)
        .frame(height: Self.stageHeight, alignment: .top)
        .clipped()
        .mask {
            LinearGradient(stops: [.init(color: .black, location: 0.62), .init(color: .clear, location: 1)],
                           startPoint: .top, endPoint: .bottom)
        }
    }

    /// Show only the phone's top: the surface and a short fade beneath it.
    private static let stageHeight: CGFloat = 190

    private func compactPage(_ context: ActivityContext) -> some View {
        VStack(spacing: 18) {
            compactIsland(context)
                .padding(.top, Device.islandTop)
            if selectedSlot.style != .none {
                editPill(deletes: true)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func compactIsland(_ context: ActivityContext) -> some View {
        HStack(spacing: 0) {
            slotButton(.leading, context: context)
            Color.clear.frame(width: Device.sensorWidth)
            slotButton(.trailing, context: context)
        }
        .frame(height: Device.islandHeight)
        .foregroundStyle(.white)
        .background(.black, in: Capsule())
        .overlay(alignment: slot == .leading ? .leading : .trailing) {
            SlotArc(trailing: slot == .trailing, islandHeight: Device.islandHeight)
        }
        .animation(.snappy, value: slot)
    }

    /// One side of the island: its reading, or a plus while empty.
    private func slotButton(_ target: Slot, context: ActivityContext) -> some View {
        let item = target == .leading ? context.layout.compactLeading : context.layout.compactTrailing
        return Button {
            withAnimation(.snappy) { slot = target }
        } label: {
            Group {
                if item.style == .none {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .light))
                        .foregroundStyle(.white.opacity(0.85))
                } else {
                    ActivityCompactItemView(context: context, slot: item)
                }
            }
            .padding(.leading, target == .leading ? 11 : 4)
            .padding(.trailing, target == .leading ? 4 : 13)
            .frame(minWidth: 40, maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(target == .leading ? "Left" : "Right"))
        .accessibilityAddTraits(slot == target ? .isSelected : [])
    }

    private func minimalPage(_ context: ActivityContext) -> some View {
        VStack(spacing: 18) {
            HStack(spacing: 7) {
                Capsule().fill(.black)
                    .frame(width: Device.sensorWidth + 30, height: Device.islandHeight)
                ActivityMinimalView(context: context)
                    .foregroundStyle(.white)
                    .frame(width: Device.islandHeight, height: Device.islandHeight)
                    .background(.black, in: Circle())
            }
            // The minimal bubble attaches to the right of the island.
            .offset(x: (Device.islandHeight + 7) / 2)
            .padding(.top, Device.islandTop)
            Text("Shown when another app's activity shares the island")
                .font(.system(size: 15))
                .foregroundStyle(Color.black.opacity(0.5))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func expandedPage(_ context: ActivityContext) -> some View {
        VStack(spacing: 0) {
            ActivityExpandedPreview(context: context)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .background(.black, in: .rect(cornerRadius: 44, style: .continuous))
                .padding(.horizontal, Device.expandedInset)
                .padding(.top, Device.islandTop)
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    /// Just the activity, as the reference does — the clock adds height, not meaning.
    private func lockScreenPage(_ context: ActivityContext) -> some View {
        ActivityLockScreenView(context: context)
            .modifier(LockScreenGlass(tint: 0.32))
            .padding(.horizontal, 14)
            .padding(.top, 26)
            .frame(maxHeight: .infinity, alignment: .top)
    }

    /// The glass "Edit | Delete" capsule floating under the island.
    private func editPill(deletes: Bool) -> some View {
        HStack(spacing: 0) {
            Button("Edit") { editing = true }
                .disabled(!sourceNeeds.any)
                .opacity(sourceNeeds.any ? 1 : 0.45)
            if deletes {
                Rectangle().fill(.white.opacity(0.35)).frame(width: 1, height: 16)
                    .padding(.horizontal, 14)
                Button("Delete") {
                    withAnimation(.snappy) { setSelectedStyle(.none) }
                }
            }
        }
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 26)
        .frame(height: 46)
        .background(Color(white: 0.32).opacity(0.62), in: Capsule())
        .background(.ultraThinMaterial, in: Capsule())
        .buttonStyle(.plain)
    }

    // MARK: - Controls

    private var controls: some View {
        SurfaceCard {
            @Bindable var preferences = preferences
            VStack(spacing: 12) {
                HStack(spacing: 12) {
                    Button {
                        Task { await updateNow() }
                    } label: {
                        Label {
                            Text("Update now").fontWeight(.semibold)
                        } icon: {
                            Image(systemName: "arrow.clockwise")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color(uiColor: .systemBackground))
                                .frame(width: 24, height: 24)
                                .background(Color(uiColor: .label), in: Circle())
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(updating || !preferences.liveActivityEnabled || store.stats == nil)
                    .opacity(updating || !preferences.liveActivityEnabled || store.stats == nil ? 0.45 : 1)
                    Spacer(minLength: 8)
                    Toggle("Enable Live Activity", isOn: $preferences.liveActivityEnabled)
                        .fontWeight(.semibold)
                        .fixedSize()
                }
                DashedDivider()
                statusLine
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        Group {
            if !preferences.liveActivityEnabled {
                Text("Off")
            } else if liveActivity.remoteUpdatesEnabled {
                Text("Remote push active")
            } else if let error = liveActivity.errorMessage {
                Text(error).foregroundStyle(DesignTokens.critical)
            } else if let message = liveActivity.remoteUpdateMessage {
                Text(message)
            } else {
                Text("Updating locally")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    // MARK: - Gallery

    private var gallery: some View {
        SurfaceCard {
            VStack(spacing: 16) {
                HStack(spacing: 8) {
                    Image(systemName: surface.systemImage)
                    Text(surface.title)
                    if surface != .compact {
                        Spacer(minLength: 8)
                        Button("Edit") { editing = true }
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 7)
                            .background(Color.primary.opacity(0.06), in: Capsule())
                            .buttonStyle(.plain)
                            .disabled(!sourceNeeds.any)
                            .opacity(sourceNeeds.any ? 1 : 0.4)
                    }
                }
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: surface == .compact ? .center : .leading)
                DashedDivider()
                switch surface {
                case .compact: compactGallery
                case .minimal: minimalGallery
                case .expanded: expandedGallery
                case .lockScreen: lockScreenGallery
                }
            }
        }
        .animation(.snappy, value: surface)
    }

    private var tileColumns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 14), count: 4)
    }

    private var compactGallery: some View {
        let context = previewContext
        let layout = preferences.liveLayout
        return LazyVGrid(columns: tileColumns, spacing: 18) {
            ForEach(LiveActivityLayout.CompactStyle.allCases.filter { $0 != .none }, id: \.self) { style in
                let badges = (layout.compactLeading.style == style ? ["L"] : [])
                    + (layout.compactTrailing.style == style ? ["R"] : [])
                squareTile(style.title, badges: badges) {
                    ActivityCompactItemView(context: context, slot: .init(style: style, source: selectedSlot.source))
                } action: {
                    setSelectedStyle(style)
                }
            }
        }
    }

    private var minimalGallery: some View {
        let context = previewContext
        return LazyVGrid(columns: tileColumns, spacing: 18) {
            ForEach(LiveActivityLayout.MinimalStyle.allCases, id: \.self) { style in
                squareTile(style.title, badges: preferences.liveLayout.minimal == style ? ["M"] : []) {
                    ActivityMinimalView(context: context.with { $0.minimal = style })
                } action: {
                    layout.wrappedValue.minimal = style
                }
            }
        }
    }

    private var expandedGallery: some View {
        let context = previewContext
        return VStack(spacing: 22) {
            ForEach(LiveActivityLayout.ExpandedTemplate.allCases, id: \.self) { template in
                wideTile(template.title, badge: preferences.liveLayout.expanded == template ? "E" : nil) {
                    FittedPreview(width: 380) {
                        ActivityExpandedPreview(context: context.with { $0.expanded = template })
                            .foregroundStyle(.white)
                            .background(.black, in: .rect(cornerRadius: 44, style: .continuous))
                            .environment(\.colorScheme, .dark)
                    }
                } action: {
                    layout.wrappedValue.expanded = template
                }
            }
        }
    }

    private var lockScreenGallery: some View {
        let context = previewContext
        return VStack(spacing: 22) {
            ForEach(LiveActivityLayout.LockScreenTemplate.allCases, id: \.self) { template in
                wideTile(template.title, badge: preferences.liveLayout.lockScreen == template ? "L" : nil) {
                    FittedPreview(width: 390) {
                        ActivityLockScreenView(context: context.with { $0.lockScreen = template })
                            .modifier(LockScreenGlass())
                            .padding(10)
                            .background(
                                LinearGradient(colors: [Color(red: 0.42, green: 0.47, blue: 0.62),
                                                        Color(red: 0.28, green: 0.29, blue: 0.4)],
                                               startPoint: .topLeading, endPoint: .bottomTrailing),
                                in: .rect(cornerRadius: 34, style: .continuous)
                            )
                            .environment(\.colorScheme, .dark)
                    }
                } action: {
                    layout.wrappedValue.lockScreen = template
                }
            }
        }
    }

    /// A black squircle holding the live-rendered option, with a quiet shadow
    /// and its caption below; tiles in use carry letter badges.
    private func squareTile(
        _ caption: LocalizedStringKey,
        badges: [String],
        @ViewBuilder content: () -> some View,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(.black)
                    .aspectRatio(1, contentMode: .fit)
                    .overlay {
                        content()
                            .foregroundStyle(.white)
                            .environment(\.colorScheme, .dark)
                            .padding(5)
                    }
                    .shadow(color: .black.opacity(0.16), radius: 8, y: 5)
                TileCaption(caption: caption, badges: badges)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(caption))
        .accessibilityAddTraits(badges.isEmpty ? .isButton : [.isButton, .isSelected])
    }

    /// A full-width live-rendered template with its caption below.
    private func wideTile(
        _ caption: LocalizedStringKey,
        badge: String?,
        @ViewBuilder content: () -> some View,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 10) {
                content()
                    .accessibilityHidden(true)
                    .shadow(color: .black.opacity(0.16), radius: 10, y: 6)
                TileCaption(caption: caption, badges: badge.map { [$0] } ?? [])
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .overlay {
            Color.clear
                .contentShape(.rect)
                .onTapGesture(perform: action)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(caption))
        .accessibilityAddTraits(badge == nil ? .isButton : [.isButton, .isSelected])
    }

    private func setSelectedStyle(_ style: LiveActivityLayout.CompactStyle) {
        if slot == .leading {
            layout.wrappedValue.compactLeading.style = style
        } else {
            layout.wrappedValue.compactTrailing.style = style
        }
    }

    // MARK: - Data source

    /// Which data-source rows the current surface's appearance uses.
    private struct SourceNeeds {
        var quota = false
        var provider = false
        var usage = false
        var period = false

        var any: Bool { quota || provider || usage || period }
    }

    private var sourceNeeds: SourceNeeds {
        let layout = preferences.liveLayout
        switch surface {
        case .compact:
            switch selectedSlot.style {
            case .ring, .percent, .percentReset, .reset: return SourceNeeds(quota: true)
            case .providerIcon: return SourceNeeds(provider: true)
            case .tokens, .cost: return SourceNeeds(usage: true, period: true)
            case .speed: return SourceNeeds(period: true)
            case .appIcon, .agents, .none: return SourceNeeds()
            }
        case .minimal:
            return layout.minimal == .providerIcon ? SourceNeeds(provider: true) : SourceNeeds(quota: true)
        case .expanded:
            switch layout.expanded {
            case .quota: return SourceNeeds(quota: true)
            case .usage: return SourceNeeds(quota: true, usage: true, period: true)
            case .providers: return SourceNeeds()
            }
        case .lockScreen:
            switch layout.lockScreen {
            case .overview: return SourceNeeds(quota: true, usage: true, period: true)
            case .quota: return SourceNeeds(quota: true)
            }
        }
    }

    private var sourceTitle: LocalizedStringKey {
        switch surface {
        case .compact: slot == .leading ? "Left side data" : "Right side data"
        case .minimal: "Minimal data"
        case .expanded: "Expanded data"
        case .lockScreen: "Lock Screen data"
        }
    }

    private var sourceBinding: Binding<ActivitySource> {
        Binding(
            get: {
                let layout = preferences.liveLayout
                return switch surface {
                case .compact: slot == .leading ? layout.compactLeading.source : layout.compactTrailing.source
                case .minimal: layout.minimalSource
                case .expanded: layout.expandedSource
                case .lockScreen: layout.lockScreenSource
                }
            },
            set: { source in
                var layout = preferences.liveLayout
                switch surface {
                case .compact:
                    if slot == .leading { layout.compactLeading.source = source } else { layout.compactTrailing.source = source }
                case .minimal: layout.minimalSource = source
                case .expanded: layout.expandedSource = source
                case .lockScreen: layout.lockScreenSource = source
                }
                preferences.liveLayout = layout
            }
        )
    }

    /// The desktop composer's choices as a native form sheet.
    private var sourceSheet: some View {
        let needs = sourceNeeds
        let source = sourceBinding
        return NavigationStack {
            Form {
                if needs.quota || needs.provider {
                    Section {
                        Picker("AI tool", selection: toolBinding(source)) {
                            Label {
                                Text("Automatic · lowest remaining")
                            } icon: {
                                Image(uiImage: ProviderMenuArtwork.symbol("arrow.down.circle", colorScheme: colorScheme))
                            }
                                .tag("auto:lowest")
                            Label {
                                Text("Automatic · most recently used")
                            } icon: {
                                Image(uiImage: ProviderMenuArtwork.symbol("clock.arrow.circlepath", colorScheme: colorScheme))
                            }
                                .tag("auto:recent")
                            Divider()
                            ForEach(quotaProviderIDs, id: \.self) { providerID in
                                Label {
                                    Text(verbatim: ProviderPresentation.displayName(for: providerID))
                                } icon: {
                                    Image(uiImage: ProviderMenuArtwork.image(for: providerID, colorScheme: colorScheme))
                                }
                                .tag("provider:\(providerID)")
                            }
                        }
                        if needs.quota, let providerID = source.wrappedValue.providerID,
                           accounts(for: providerID).count > 1 {
                            Picker("Account", selection: source.accountKey) {
                                Text("Lowest remaining").tag(String?.none)
                                ForEach(accounts(for: providerID), id: \.id) { account in
                                    Text(verbatim: account.title).tag(Optional(account.id))
                                }
                            }
                        }
                    }
                }
                if needs.quota {
                    Section {
                        Picker("Quota window", selection: source.window) {
                            ForEach(ActivitySource.Window.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        Picker("Display", selection: source.value) {
                            ForEach(ActivitySource.Value.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                if needs.usage || needs.period {
                    Section {
                        if needs.usage {
                            Picker("Tools", selection: source.scope) {
                                ForEach(ActivitySource.Scope.allCases, id: \.self) { Text($0.title).tag($0) }
                            }
                        }
                        Picker("Period", selection: source.period) {
                            ForEach(ActivitySource.Period.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                }
            }
            .navigationTitle(sourceTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { editing = false }
                }
            }
        }
    }

    /// One picker for the provider choice: automatic by condition, or a named tool.
    private func toolBinding(_ source: Binding<ActivitySource>) -> Binding<String> {
        Binding(
            get: {
                let value = source.wrappedValue
                if let providerID = value.providerID { return "provider:\(providerID)" }
                return "auto:\(value.automatic.rawValue)"
            },
            set: { tag in
                var value = source.wrappedValue
                if tag.hasPrefix("provider:") {
                    let providerID = String(tag.dropFirst("provider:".count))
                    if value.providerID != providerID { value.accountKey = nil }
                    value.providerID = providerID
                } else {
                    value.providerID = nil
                    value.accountKey = nil
                    value.automatic = ActivitySource.Automatic(rawValue: String(tag.dropFirst("auto:".count))) ?? .lowest
                }
                source.wrappedValue = value
            }
        )
    }

    /// A provider's accounts as Limits shows them, honouring email masking.
    private func accounts(for providerID: String) -> [(id: String, title: String)] {
        ((store.stats ?? .sample).limits?.providers ?? [])
            .filter { $0.normalizedProviderID == providerID }
            .compactMap { provider in
                guard let key = provider.accountKey?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !key.isEmpty else { return nil }
                return (key, provider.accountTitle(maskingEmails: preferences.masksAccountEmails))
            }
    }

    /// Providers present in the Hub data, in the user's AI Limits order.
    private var quotaProviderIDs: [String] {
        let ids = ((store.stats ?? .sample).limits?.providers ?? [])
            .map(\.normalizedProviderID)
            .filter { !preferences.hiddenLimitProviders.contains($0) }
        return LimitProviderOrder.sortedIDs(ids, order: preferences.limitProviderOrder)
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

/// Lays a surface out at its on-device width, then scales it to the space
/// available, so a gallery tile keeps the phone's proportions instead of
/// re-wrapping its text.
private struct FittedPreview<Content: View>: View {
    let width: CGFloat
    @ViewBuilder var content: Content
    @State private var naturalHeight: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            let scale = min(1, proxy.size.width / width)
            content
                .frame(width: width)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { naturalHeight = $0 }
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: proxy.size.width, height: naturalHeight * scale, alignment: .topLeading)
        }
        .frame(height: naturalHeight * fittedScale)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { availableWidth = $0 }
    }

    @State private var availableWidth: CGFloat = 0
    private var fittedScale: CGFloat {
        availableWidth > 0 ? min(1, availableWidth / width) : 1
    }
}

/// A thin arc hugging the selected end of the island, as in the reference.
private struct SlotArc: View {
    let trailing: Bool
    let islandHeight: CGFloat

    var body: some View {
        let radius = islandHeight / 2 + 6
        Circle()
            // Bottom quadrant toward the selected end: 3 o'clock is 0, 6 o'clock 0.25.
            .trim(from: trailing ? 0.07 : 0.28, to: trailing ? 0.22 : 0.43)
            .stroke(Color.black, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            .frame(width: radius * 2, height: radius * 2)
            .offset(x: trailing ? 6 : -6)
            .accessibilityHidden(true)
    }
}

/// The caption under a tile, led by letter badges for where it is in use.
private struct TileCaption: View {
    let caption: LocalizedStringKey
    let badges: [String]

    var body: some View {
        HStack(spacing: 5) {
            ForEach(badges, id: \.self) { badge in
                Text(verbatim: badge)
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .frame(width: 17, height: 17)
                    .background(Color(uiColor: .label), in: Circle())
            }
            Text(caption)
                .font(.subheadline.weight(badges.isEmpty ? .regular : .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}

private struct DashedDivider: View {
    var body: some View {
        Line()
            .stroke(Color.secondary.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            .frame(height: 1)
            .accessibilityHidden(true)
    }

    nonisolated private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            Path { path in
                path.move(to: CGPoint(x: rect.minX, y: rect.midY))
                path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            }
        }
    }
}

/// iOS 26 renders the Lock Screen activity on host glass; the same treatment
/// in the preview keeps it honest.
private struct LockScreenGlass: ViewModifier {
    /// Darkening over the material, standing in for the host's vibrancy on a light wallpaper.
    var tint: Double = 0
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        content
            .background {
                if reduceTransparency {
                    Color(uiColor: .secondarySystemGroupedBackground)
                } else if tint > 0 {
                    Color.black.opacity(tint)
                } else {
                    Color.white.opacity(0.14)
                }
            }
            .background(.ultraThinMaterial)
            .clipShape(.rect(cornerRadius: 24, style: .continuous))
    }
}

// MARK: - Titles

extension LiveActivityLayout.CompactStyle {
    var title: LocalizedStringKey {
        switch self {
        case .ring: "Quota ring"
        case .providerIcon: "AI tool icon"
        case .appIcon: "Token Monitor"
        case .percent: "Percentage"
        case .percentReset: "Percentage + reset"
        case .reset: "Reset time"
        case .tokens: "Tokens"
        case .cost: "Cost"
        case .speed: "Speed"
        case .agents: "Running sessions"
        case .none: "Empty"
        }
    }
}

extension LiveActivityLayout.MinimalStyle {
    var title: LocalizedStringKey {
        switch self {
        case .appRing: "Σ ring"
        case .ring: "Quota ring"
        case .percent: "Percentage"
        case .providerIcon: "AI tool icon"
        }
    }
}

extension LiveActivityLayout.ExpandedTemplate {
    var title: LocalizedStringKey {
        switch self {
        case .quota: "Limits"
        case .usage: "Usage"
        case .providers: "All providers"
        }
    }
}

extension LiveActivityLayout.LockScreenTemplate {
    var title: LocalizedStringKey {
        switch self {
        case .overview: "Overview"
        case .quota: "Limits"
        }
    }
}

extension LiveActivityLayout.Source.Window {
    var title: LocalizedStringKey {
        switch self {
        case .primary: "Primary quota"
        case .secondary: "Secondary quota"
        case .session: "Session"
        case .daily: "Daily"
        case .weekly: "Weekly"
        case .billing: "Billing"
        }
    }
}

extension LiveActivityLayout.Source.Value {
    var title: LocalizedStringKey {
        switch self {
        case .remaining: "Remaining"
        case .used: "Used"
        }
    }
}

extension LiveActivityLayout.Source.Period {
    var title: LocalizedStringKey {
        switch self {
        case .today: "Today"
        case .month: "This month"
        }
    }
}

extension LiveActivityLayout.Source.Scope {
    var title: LocalizedStringKey {
        switch self {
        case .all: "All tools"
        case .recent: "Most recently used tool"
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
