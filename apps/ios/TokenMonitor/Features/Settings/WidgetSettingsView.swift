import SwiftUI
import WidgetKit

/// Settings → Widgets. The preview renders the real `TokenMonitorWidgetView`
/// at each family's true point size, fed by the stored Hub snapshot (or the
/// widget's sample snapshot), so every toggle below re-renders exactly what
/// the Home Screen will draw.
struct WidgetSettingsView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var previewFamily: PreviewFamily
    @State private var rowWidth: CGFloat = 0

    /// Loaded once rather than on every body evaluation.
    @State private var storedSnapshot = Self.loadStoredSnapshot()

    init() {
        var initial = PreviewFamily.small
        #if DEBUG
        let prefix = "--sample-widget-preview="
        if let value = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix(prefix) })
            .map({ String($0.dropFirst(prefix.count)) }) {
            initial = switch value {
            case "medium": .medium
            case "large": .large
            default: .small
            }
        }
        #endif
        _previewFamily = State(initialValue: initial)
    }

    enum PreviewFamily: CaseIterable, Identifiable {
        case small, medium, large

        var id: Self { self }

        var title: LocalizedStringKey {
            switch self {
            case .small: "Small"
            case .medium: "Medium"
            case .large: "Large"
            }
        }

        var family: WidgetFamily {
            switch self {
            case .small: .systemSmall
            case .medium: .systemMedium
            case .large: .systemLarge
            }
        }

        /// The family's true point size on an iPhone (system margins included).
        var size: CGSize {
            switch self {
            case .small: CGSize(width: 170, height: 170)
            case .medium: CGSize(width: 364, height: 170)
            case .large: CGSize(width: 364, height: 382)
            }
        }
    }

    var body: some View {
        @Bindable var preferences = preferences
        Form {
            previewSection
            contentSection(preferences: $preferences)
            addSection
        }
        .formStyle(.grouped)
        .listSectionSpacing(DesignTokens.sectionSpacing)
        .scrollContentBackground(.hidden)
        .background { AppBackground() }
        .navigationTitle("Widgets")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
        .tint(DesignTokens.accent)
    }

    // MARK: - Preview

    private static func loadStoredSnapshot() -> TokenMonitorSharedPayload.Snapshot? {
        try? SharedSnapshotStore().load().snapshot
    }

    /// Built live from the current preferences so toggles below re-render the
    /// preview instantly; the widget intent's App Default maps here.
    private var previewEntry: TokenMonitorWidgetEntry {
        let preferences = preferences.sharedPreferences
        return TokenMonitorWidgetEntry(
            date: .now,
            snapshot: storedSnapshot ?? TokenMonitorWidgetEntry.placeholderSnapshot,
            preferences: preferences,
            content: preferences.widgetContent,
            period: preferences.widgetPeriod,
            providerID: preferences.widgetProviderID,
            showsCost: preferences.widgetShowsCost,
            showsUpdateTime: preferences.widgetShowsUpdateTime,
            ink: .recommended
        )
    }

    private var previewSection: some View {
        Section {
            Picker("Preview size", selection: $previewFamily) {
                ForEach(PreviewFamily.allCases) { family in
                    Text(family.title).tag(family)
                }
            }
            .pickerStyle(.segmented)

            VStack(spacing: 10) {
                previewCard
                Text(storedSnapshot != nil ? "Latest data from your Hub" : "Sample data")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .onGeometryChange(for: CGFloat.self, of: \.size.width) { width in
                rowWidth = width
            }
        }
    }

    private var previewCard: some View {
        let size = previewFamily.size
        let scale = rowWidth > 0 ? min(1, rowWidth / size.width) : 1
        return TokenMonitorWidgetView(
            entry: previewEntry,
            surface: .solid,
            family: previewFamily.family
        )
        .padding(16) // the system's widget content margins
        .frame(width: size.width, height: size.height)
        .background(.background, in: .rect(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(DesignTokens.border(for: colorScheme), lineWidth: 1)
        }
        .clipShape(.rect(cornerRadius: 24, style: .continuous))
        .scaleEffect(scale)
        .frame(width: size.width * scale, height: size.height * scale)
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: previewFamily)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: scale)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Widget preview"))
    }

    // MARK: - Content defaults

    @ViewBuilder
    private func contentSection(preferences: Bindable<AppPreferences>) -> some View {
        Section {
            Picker("Content", selection: preferences.widgetContent) {
                ForEach(AppPreferences.WidgetContent.allCases) { content in
                    Text(LocalizedStringKey(content.shortTitle)).tag(content)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if preferences.wrappedValue.widgetContent == .overview {
                Picker("Period", selection: preferences.widgetPeriod) {
                    ForEach(UsagePeriodKey.allCases) { period in
                        Text(LocalizedStringKey(period.title)).tag(period)
                    }
                }
                .pickerStyle(.menu)
            }

            if preferences.wrappedValue.widgetContent == .limits {
                Picker("Limit provider", selection: preferences.widgetProviderID) {
                    Text("Automatic").tag("")
                    ForEach(providerIDs, id: \.self) { providerID in
                        Label {
                            Text(verbatim: ProviderPresentation.displayName(for: providerID))
                        } icon: {
                            Image(uiImage: ProviderMenuArtwork.image(for: providerID, colorScheme: colorScheme))
                        }
                        .tag(providerID)
                    }
                }
            }

            if preferences.wrappedValue.widgetContent == .overview {
                Toggle("Show cost", isOn: preferences.widgetShowsCost)
            }
            Toggle("Show update time", isOn: preferences.widgetShowsUpdateTime)
        } footer: {
            Text("These are defaults. Touch and hold a widget and choose Edit Widget to change just that one.")
        }
    }

    // MARK: - Add to Home Screen

    private var addSection: some View {
        Section {
            Label(
                "Touch and hold an empty area of the Home Screen, then tap Edit › Add Widget.",
                systemImage: "hand.tap"
            )
            Label(
                "Search for Token Monitor.",
                systemImage: "magnifyingglass"
            )
            Label(
                "Choose Liquid Glass, Transparent or Solid, then a size.",
                systemImage: "square.on.square"
            )
        } header: {
            Text("Add to Home Screen")
        } footer: {
            Text("Solid also offers Lock Screen widgets. iOS decides when widgets refresh.")
        }
    }

    private var providerIDs: [String] {
        LimitProviderOrder.sortedIDs(
            (store.stats?.limits?.providers ?? []).map(\.normalizedProviderID)
                + [preferences.widgetProviderID].filter { !$0.isEmpty },
            order: preferences.limitProviderOrder
        )
    }
}
