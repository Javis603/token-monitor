import SwiftUI

struct SettingsView: View {
    @Environment(ConnectionSettings.self) private var settings
    @Environment(TokenMonitorStore.self) private var store
    @Environment(AppPreferences.self) private var preferences
    @Environment(LiveActivityController.self) private var liveActivity

    private let snapshotStore = SharedSnapshotStore()

    var body: some View {
        settingsForm
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background {
            AppBackground()
        }
        .navigationTitle("Settings")
        .onChange(of: preferences.liveActivityEnabled) { _, enabled in
            Task {
                await updateLiveActivity(enabled: enabled)
            }
        }
        .onChange(of: livePreferencesSignature) { _, _ in
            Task { await refreshLiveActivity() }
        }
    }

    private var livePreferencesSignature: String {
        [
            preferences.livePrimaryMetric.rawValue,
            preferences.livePeriod.rawValue,
            preferences.liveProviderID,
            preferences.liveShowsSecondaryMetric.description,
            preferences.liveShowsProgress.description,
            preferences.liveIconProviderID,
            preferences.liveCompactTrailingField,
            preferences.liveExpandedLeadingField,
            preferences.liveExpandedCenterField,
            preferences.liveExpandedTrailingField,
            preferences.liveExpandedBottomField,
            preferences.liveLockScreenPrimaryField,
            preferences.liveLockScreenSecondaryField,
            preferences.liveLockScreenBottomField,
            preferences.currency.rawValue,
            preferences.language.rawValue
        ].joined(separator: "|")
    }

    @ViewBuilder
    private var settingsForm: some View {
        Form {
            connectionSections(settings: settings, preferences: preferences)
            liveActivitySections(preferences: preferences)
            accountSections(preferences: preferences)
        }
    }

    @ViewBuilder
    private func connectionSections(
        settings: ConnectionSettings,
        preferences: AppPreferences
    ) -> some View {
        hubSection(settings: settings)
        regionalSection(preferences: preferences)
        overviewSection(preferences: preferences)
        widgetSection(preferences: preferences)
    }

    @ViewBuilder
    private func liveActivitySections(preferences: AppPreferences) -> some View {
        liveActivitySection(preferences: preferences)
        if preferences.liveActivityEnabled {
            liveActivityPreviewSection(preferences: preferences)
            liveActivityIconSection(preferences: preferences)
            liveActivityCompactSection(preferences: preferences)
            liveActivityExpandedSection(preferences: preferences)
            liveActivityLockScreenSection(preferences: preferences)
        }
    }

    @ViewBuilder
    private func accountSections(preferences: AppPreferences) -> some View {
        appearanceSection(preferences: preferences)
        statusSection
        privacySection
        aboutSection
    }

    @ViewBuilder
    private func regionalSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            Picker("Language", selection: $preferences.language) {
                ForEach(AppLanguage.allCases) { language in
                    Text(language.displayName).tag(language)
                }
            }

            Picker("Currency", selection: $preferences.currency) {
                ForEach(AppCurrency.allCases) { currency in
                    Text(currency.displayName(locale: preferences.language.locale))
                        .tag(currency)
                }
            }
        } header: {
            Label("Language & Region", systemImage: "globe")
        } footer: {
            Text("Hub costs are stored in USD and converted for display using the same rates as Token Monitor Desktop.")
        }
    }

    @ViewBuilder
    private func hubSection(settings: ConnectionSettings) -> some View {
        @Bindable var settings = settings

        Section {
            TextField("Hub URL", text: $settings.hubURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.URL)

            SecureField("Shared secret", text: $settings.secret)
                .textContentType(.password)

            Button("Save & Connect", systemImage: "link", action: saveAndConnect)
                .buttonStyle(.glassProminent)
                .frame(maxWidth: .infinity)

            if let validationMessage = settings.validationMessage {
                Label(validationMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(DesignTokens.critical)
            }
        } header: {
            Label("Hub Connection", systemImage: "network")
        } footer: {
            Text(
                "The iOS app reads your existing Token Monitor Hub. It never runs local collectors."
            )
        }
    }

    @ViewBuilder
    private func overviewSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            Stepper(
                value: $preferences.homeLimitCount,
                in: 1...8,
                step: 1
            ) {
                LabeledContent("AI limits on Overview") {
                    Text(preferences.homeLimitCount, format: .number)
                        .monospacedDigit()
                        .foregroundStyle(DesignTokens.accent)
                }
            }
        } header: {
            Label("Overview", systemImage: "house")
        } footer: {
            Text("Choose how many provider limits appear on the Overview tab. The default is three.")
        }
    }

    @ViewBuilder
    private func widgetSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            WidgetSurfacePreview(
                content: preferences.widgetContent,
                period: preferences.widgetPeriod,
                providerName: preferences.widgetProviderID.isEmpty
                    ? "Automatic"
                    : ProviderPresentation.displayName(
                        for: preferences.widgetProviderID
                    ),
                showsCost: preferences.widgetShowsCost,
                showsUpdateTime: preferences.widgetShowsUpdateTime
            )

            Picker("Default content", selection: $preferences.widgetContent) {
                ForEach(AppPreferences.WidgetContent.allCases) { content in
                    Text(LocalizedStringKey(content.title)).tag(content)
                }
            }

            Picker("Period", selection: $preferences.widgetPeriod) {
                ForEach(UsagePeriodKey.allCases) { period in
                    Text(LocalizedStringKey(period.title)).tag(period)
                }
            }

            Picker("Limit provider", selection: $preferences.widgetProviderID) {
                Text("Automatic").tag("")
                ForEach(providerIDs, id: \.self) { providerID in
                    Label(
                        ProviderPresentation.displayName(for: providerID),
                        image: ProviderPresentation.assetName(for: providerID)
                    )
                    .tag(providerID)
                }
            }

            Toggle("Show cost", isOn: $preferences.widgetShowsCost)
            Toggle("Show update time", isOn: $preferences.widgetShowsUpdateTime)
        } header: {
            Label("Widgets", systemImage: "widget.small")
        } footer: {
            Text(
                "These are the defaults for new widgets. Long-press a widget and choose Edit Widget to override its content."
            )
        }
    }

    @ViewBuilder
    private func liveActivitySection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            Toggle("Live Activity", isOn: $preferences.liveActivityEnabled)

            if preferences.liveActivityEnabled {
                Picker("Period", selection: $preferences.livePeriod) {
                    ForEach(UsagePeriodKey.allCases) { period in
                        Text(LocalizedStringKey(period.title)).tag(period)
                    }
                }

                Picker("Default metric", selection: $preferences.livePrimaryMetric) {
                    ForEach(AppPreferences.LiveMetric.allCases) { metric in
                        Text(LocalizedStringKey(metric.title)).tag(metric)
                    }
                }

                providerPicker(
                    "Limit data",
                    selection: $preferences.liveProviderID
                )

                LabeledContent("Status") {
                    Text(
                        liveActivity.isActive
                            ? (liveActivity.remoteUpdatesEnabled
                                ? "Active · Remote"
                                : "Active · Local")
                            : "Waiting"
                    )
                        .foregroundStyle(
                            liveActivity.isActive
                                ? DesignTokens.accent
                                : .secondary
                        )
                }
            }

            if let errorMessage = liveActivity.errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(DesignTokens.critical)
            }
            if let remoteUpdateMessage = liveActivity.remoteUpdateMessage {
                Label(remoteUpdateMessage, systemImage: "network.slash")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Label("Live Activity & Dynamic Island", systemImage: "platter.filled.bottom.and.arrow.down.iphone")
        } footer: {
            Text(
                "Choose the icon and content independently for the compact island, expanded island, and Lock Screen activity. With Hub APNs configured, updates can arrive while the app is suspended; otherwise open the app periodically for fresh Hub data."
            )
        }
    }

    @ViewBuilder
    private func liveActivityPreviewSection(preferences: AppPreferences) -> some View {
        Section {
            AnyView(LiveActivitySurfacePreview(
                iconProviderID: previewProviderID(preferences: preferences),
                providerName: previewProviderName(preferences: preferences),
                compactTrailingField: liveField(
                    preferences.liveCompactTrailingField,
                    fallback: .primary
                ),
                expandedLeadingField: liveField(
                    preferences.liveExpandedLeadingField,
                    fallback: .provider
                ),
                expandedCenterField: liveField(
                    preferences.liveExpandedCenterField,
                    fallback: .primary
                ),
                expandedTrailingField: liveField(
                    preferences.liveExpandedTrailingField,
                    fallback: .secondary
                ),
                expandedBottomField: liveField(
                    preferences.liveExpandedBottomField,
                    fallback: .progress
                ),
                lockScreenPrimaryField: liveField(
                    preferences.liveLockScreenPrimaryField,
                    fallback: .primary
                ),
                lockScreenSecondaryField: liveField(
                    preferences.liveLockScreenSecondaryField,
                    fallback: .secondary
                ),
                lockScreenBottomField: liveField(
                    preferences.liveLockScreenBottomField,
                    fallback: .progress
                )
            ))
        } header: {
            Text("Preview")
        }
    }

    @ViewBuilder
    private func liveActivityIconSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    iconChoice(
                        providerID: "",
                        title: "Automatic",
                        selection: $preferences.liveIconProviderID
                    )

                    ForEach(
                        iconProviderIDs(preferences: preferences),
                        id: \.self
                    ) { providerID in
                        iconChoice(
                            providerID: providerID,
                            title: ProviderPresentation.displayName(for: providerID),
                            selection: $preferences.liveIconProviderID
                        )
                    }
                }
                .padding(.vertical, 3)
            }
            .scrollIndicators(.hidden)
        } header: {
            Text("Activity icon")
        } footer: {
            Text("Automatic follows the selected limit provider, then the most active model.")
        }
    }

    @ViewBuilder
    private func liveActivityCompactSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            liveFieldPicker(
                "Trailing item",
                selection: $preferences.liveCompactTrailingField,
                excluding: [.progress]
            )
        } header: {
            Text("Compact Dynamic Island")
        }
    }

    @ViewBuilder
    private func liveActivityExpandedSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            liveFieldPicker(
                "Leading",
                selection: $preferences.liveExpandedLeadingField
            )
            liveFieldPicker(
                "Center",
                selection: $preferences.liveExpandedCenterField
            )
            liveFieldPicker(
                "Trailing",
                selection: $preferences.liveExpandedTrailingField
            )
            liveFieldPicker(
                "Bottom",
                selection: $preferences.liveExpandedBottomField
            )
        } header: {
            Text("Expanded Dynamic Island")
        }
    }

    @ViewBuilder
    private func liveActivityLockScreenSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            liveFieldPicker(
                "Primary",
                selection: $preferences.liveLockScreenPrimaryField
            )
            liveFieldPicker(
                "Secondary",
                selection: $preferences.liveLockScreenSecondaryField
            )
            liveFieldPicker(
                "Bottom",
                selection: $preferences.liveLockScreenBottomField
            )
        } header: {
            Text("Live Activity")
        }
    }

    @ViewBuilder
    private func appearanceSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            Picker("Appearance", selection: $preferences.appearance) {
                ForEach(AppAppearance.allCases) { appearance in
                    Text(LocalizedStringKey(appearance.title)).tag(appearance)
                }
            }
            .pickerStyle(.segmented)
        } header: {
            Label("Appearance", systemImage: "circle.lefthalf.filled")
        }
    }

    private var statusSection: some View {
        Section("Status") {
            LabeledContent("Connection") {
                ConnectionBadge(phase: store.phase)
            }

            if let updatedDate = Date.hubTimestamp(from: store.stats?.updatedAt) {
                LabeledContent("Last update") {
                    Text(updatedDate.updateDescription(locale: preferences.language.locale))
                }
            }

            LabeledContent("Devices") {
                Text(store.stats?.devices?.count ?? 0, format: .number)
                    .monospacedDigit()
            }
        }
    }

    private var privacySection: some View {
        Section("Privacy") {
            Label(
                "The shared secret is stored in the iOS Keychain.",
                systemImage: "key.fill"
            )
            Label(
                "Widgets receive only a versioned, privacy-safe usage snapshot.",
                systemImage: "rectangle.3.group.bubble.left.fill"
            )
            Label(
                "Provider credentials stay on your reporting devices.",
                systemImage: "lock.shield.fill"
            )
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("App", value: "Token Monitor for iOS")
            LabeledContent("Minimum version", value: "iOS 26")
            LabeledContent("Data source", value: "Token Monitor Hub")
        }
    }

    private var providerIDs: [String] {
        Array(
            Set(
                (store.stats?.sortedLimits ?? []).compactMap {
                    $0.provider?.lowercased()
                }
            )
        )
        .sorted {
            ProviderPresentation.displayName(for: $0)
                .localizedStandardCompare(
                    ProviderPresentation.displayName(for: $1)
                ) == .orderedAscending
        }
    }

    private func providerPicker(
        _ title: LocalizedStringKey,
        selection: Binding<String>
    ) -> some View {
        Picker(title, selection: selection) {
            Text("Automatic").tag("")
            ForEach(providerIDs, id: \.self) { providerID in
                Label(
                    ProviderPresentation.displayName(for: providerID),
                    image: ProviderPresentation.assetName(for: providerID)
                )
                .tag(providerID)
            }
        }
    }

    private func iconChoice(
        providerID: String,
        title: String,
        selection: Binding<String>
    ) -> some View {
        let isSelected = selection.wrappedValue == providerID

        return Button {
            selection.wrappedValue = providerID
        } label: {
            VStack(spacing: 5) {
                if providerID.isEmpty {
                    Image(systemName: "sparkles")
                        .font(.title3)
                        .foregroundStyle(DesignTokens.accent)
                        .frame(width: 32, height: 32)
                } else {
                    Image(ProviderPresentation.assetName(for: providerID))
                        .resizable()
                        .scaledToFit()
                        .frame(width: 32, height: 32)
                }

                Text(title)
                    .font(.caption2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(width: 72, height: 68)
            .background(
                isSelected
                    ? DesignTokens.accent.opacity(0.18)
                    : Color.clear,
                in: .rect(cornerRadius: 14)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(
                        isSelected
                            ? DesignTokens.accent
                            : Color.primary.opacity(0.12),
                        lineWidth: isSelected ? 1.5 : 1
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func liveFieldPicker(
        _ title: LocalizedStringKey,
        selection: Binding<String>,
        excluding fields: Set<TokenMonitorActivityAttributes.Field> = []
    ) -> some View {
        Picker(title, selection: selection) {
            ForEach(
                TokenMonitorActivityAttributes.Field.allCases.filter {
                    !fields.contains($0)
                }
            ) { field in
                Label(
                    LocalizedStringKey(field.title),
                    systemImage: field.systemImage
                )
                .tag(field.rawValue)
            }
        }
    }

    private func liveField(
        _ rawValue: String,
        fallback: TokenMonitorActivityAttributes.Field
    ) -> TokenMonitorActivityAttributes.Field {
        TokenMonitorActivityAttributes.Field(rawValue: rawValue) ?? fallback
    }

    private func previewProviderID(preferences: AppPreferences) -> String? {
        if !preferences.liveIconProviderID.isEmpty {
            return preferences.liveIconProviderID
        }
        if !preferences.liveProviderID.isEmpty {
            return preferences.liveProviderID
        }
        return providerIDs.first ?? "codex"
    }

    private func previewProviderName(preferences: AppPreferences) -> String {
        if !preferences.liveIconProviderID.isEmpty {
            return ProviderPresentation.displayName(
                for: preferences.liveIconProviderID
            )
        }
        if !preferences.liveProviderID.isEmpty {
            return ProviderPresentation.displayName(
                for: preferences.liveProviderID
            )
        }
        return providerIDs.first.map {
            ProviderPresentation.displayName(for: $0)
        } ?? "Automatic"
    }

    private func iconProviderIDs(preferences: AppPreferences) -> [String] {
        let modelVendors = store.currentPeriod.modelEntries.compactMap {
            ProviderPresentation.modelVendor(for: $0.id)
        }
        let commonVendors = ["claude", "codex", "cursor", "gemini", "opencode"]
        let selectedVendor = preferences.liveIconProviderID.isEmpty
            ? []
            : [preferences.liveIconProviderID]
        return Array(
            Set(providerIDs + modelVendors + commonVendors + selectedVendor)
        ).sorted {
            ProviderPresentation.displayName(for: $0)
                .localizedStandardCompare(
                    ProviderPresentation.displayName(for: $1)
                ) == .orderedAscending
        }
    }

    private func saveAndConnect() {
        guard let configuration = settings.save() else {
            return
        }
        liveActivity.configure(configuration)
        store.configure(configuration)
    }

    private func updateLiveActivity(enabled: Bool) async {
        let payload = try? snapshotStore.load()
        await liveActivity.setEnabled(
            enabled,
            snapshot: payload?.snapshot,
            preferences: preferences.sharedPreferences
        )
    }

    private func refreshLiveActivity() async {
        guard preferences.liveActivityEnabled,
              let payload = try? snapshotStore.load(),
              let snapshot = payload.snapshot else {
            return
        }
        await liveActivity.update(
            snapshot: snapshot,
            preferences: preferences.sharedPreferences
        )
    }
}

#Preview {
    NavigationStack {
        SettingsView()
            .environment(TokenMonitorStore.preview)
            .environment(ConnectionSettings.preview)
            .environment(AppPreferences.preview)
            .environment(LiveActivityController())
    }
}
