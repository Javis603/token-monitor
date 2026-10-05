import SwiftUI

struct SettingsView: View {
    @Environment(ConnectionSettings.self) private var settings
    @Environment(TokenMonitorStore.self) private var store
    @Environment(AppPreferences.self) private var preferences
    @Environment(LiveActivityController.self) private var liveActivity

    var body: some View {
        settingsForm
            .formStyle(.grouped)
            .listSectionSpacing(24)
            .scrollContentBackground(.hidden)
            .background {
                AppBackground()
            }
            .navigationTitle("Settings")
    }

    @ViewBuilder
    private var settingsForm: some View {
        Form {
            Section {
                NavigationLink {
                    HubConnectionView()
                } label: {
                    HStack(spacing: 12) {
                        SettingsIcon(systemImage: "network", tint: DesignTokens.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Hub")
                            Text(LocalizedStringKey(hubHost))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        if sampleMode && !hubConfigured {
                            // Sample mode has no Hub — never claim a live
                            // connection.
                            Text("Sample data")
                                .font(.caption)
                                .bold()
                                .foregroundStyle(DesignTokens.accent)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(
                                    DesignTokens.accent.opacity(0.13),
                                    in: .capsule
                                )
                        } else {
                            ConnectionBadge(phase: store.phase)
                        }
                    }
                }
            }

            Section("Customize") {
                customizeRow(
                    "Appearance",
                    icon: "circle.lefthalf.filled",
                    tint: Color(red: 0.42, green: 0.45, blue: 0.95)
                ) {
                    appearanceSection(preferences: preferences)
                }
                customizeRow(
                    "Language & Region",
                    icon: "globe",
                    tint: Color(red: 0.16, green: 0.6, blue: 0.86)
                ) {
                    regionalSection(preferences: preferences)
                }
                customizeRow(
                    "Overview",
                    icon: "house.fill",
                    tint: Color(red: 0.95, green: 0.58, blue: 0.2)
                ) {
                    overviewSection(preferences: preferences)
                }
                NavigationLink {
                    LimitProviderOrderEditor()
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    Label {
                        Text("AI Limits")
                    } icon: {
                        SettingsIcon(
                            systemImage: "gauge.with.needle",
                            tint: Color(red: 0.25, green: 0.62, blue: 0.55)
                        )
                    }
                }
                customizeRow(
                    "Widgets",
                    icon: "widget.small.badge.plus",
                    tint: Color(red: 0.62, green: 0.4, blue: 0.92)
                ) {
                    widgetSection(preferences: preferences)
                }
                NavigationLink {
                    LiveActivityCustomizerView()
                } label: {
                    Label {
                        Text("Live Activity")
                    } icon: {
                        SettingsIcon(
                            systemImage: "platter.filled.bottom.and.arrow.down.iphone",
                            tint: Color(red: 0.28, green: 0.7, blue: 0.4)
                        )
                    }
                }
            }

            Section {
                NavigationLink {
                    settingsPage("Status") { statusSection }
                } label: {
                    Label {
                        Text("Status")
                    } icon: {
                        SettingsIcon(
                            systemImage: "waveform.path.ecg",
                            tint: Color(red: 0.9, green: 0.3, blue: 0.35)
                        )
                    }
                }
                NavigationLink {
                    settingsPage("Privacy") { privacySection }
                } label: {
                    Label {
                        Text("Privacy")
                    } icon: {
                        SettingsIcon(
                            systemImage: "lock.shield.fill",
                            tint: Color(red: 0.2, green: 0.55, blue: 0.85)
                        )
                    }
                }
                NavigationLink {
                    settingsPage("About") { aboutSection }
                } label: {
                    Label {
                        Text("About")
                    } icon: {
                        SettingsIcon(
                            systemImage: "info.circle.fill",
                            tint: Color(red: 0.55, green: 0.6, blue: 0.66)
                        )
                    }
                }
            }
        }
    }

    private var hubHost: String {
        let raw = settings.hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            return sampleMode ? "Sample data" : "Not configured"
        }
        return URL(string: raw)?.host() ?? raw
    }

    private var hubConfigured: Bool {
        !settings.hubURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var sampleMode: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("--sample-data")
        #else
        return false
        #endif
    }

    private func customizeRow<Content: View>(
        _ title: LocalizedStringKey,
        icon: String,
        tint: Color,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        NavigationLink {
            settingsPage(title, content: content)
        } label: {
            Label {
                Text(title)
            } icon: {
                SettingsIcon(systemImage: icon, tint: tint)
            }
        }
    }

    private func settingsPage<Content: View>(
        _ title: LocalizedStringKey,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Form { content() }
            .formStyle(.grouped)
            .listSectionSpacing(24)
            .scrollContentBackground(.hidden)
            .background { AppBackground() }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .tint(DesignTokens.accent)
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
    private func appearanceSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            Picker("Appearance", selection: $preferences.appearance) {
                ForEach(AppAppearance.allCases) { appearance in
                    Text(LocalizedStringKey(appearance.title)).tag(appearance)
                }
            }
            .pickerStyle(.inline)
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
                Text(store.stats?.devices.map { $0.count.formatted() } ?? "—")
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
        LimitProviderOrder.sortedIDs(
            (store.stats?.limits?.providers ?? []).map(\.normalizedProviderID)
                + [preferences.widgetProviderID, preferences.liveProviderID].filter { !$0.isEmpty },
            order: preferences.limitProviderOrder
        )
    }

    private func saveAndConnect() {
        guard let configuration = settings.save() else {
            return
        }
        liveActivity.configure(configuration)
        store.configure(configuration)
    }
}

/// The Hub connection page — URL, secret, Save & Connect, last error.
struct HubConnectionView: View {
    @Environment(ConnectionSettings.self) private var settings
    @Environment(TokenMonitorStore.self) private var store
    @Environment(LiveActivityController.self) private var liveActivity

    var body: some View {
        @Bindable var settings = settings
        Form {
            Section {
                TextField("Hub URL", text: $settings.hubURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.URL)

                SecureField("Shared secret", text: $settings.secret)
                    .textContentType(.password)

                Button("Save & Connect", systemImage: "link") {
                    guard let configuration = settings.save() else { return }
                    liveActivity.configure(configuration)
                    store.configure(configuration)
                }
                .modifier(AppActionStyle())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)

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
        .formStyle(.grouped)
        .listSectionSpacing(24)
        .scrollContentBackground(.hidden)
        .background { AppBackground() }
        .navigationTitle("Hub")
        .navigationBarTitleDisplayMode(.inline)
        .tint(DesignTokens.accent)
    }
}

/// iOS-Settings-style colored rounded-square icon.
private struct SettingsIcon: View {
    let systemImage: String
    let tint: Color

    var body: some View {
        Image(systemName: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(tint, in: .rect(cornerRadius: 8, style: .continuous))
            .accessibilityHidden(true)
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
