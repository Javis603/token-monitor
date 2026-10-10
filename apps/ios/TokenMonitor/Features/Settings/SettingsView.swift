import SwiftUI

struct SettingsView: View {
    @Environment(ConnectionSettings.self) private var settings
    @Environment(TokenMonitorStore.self) private var store
    @Environment(AppPreferences.self) private var preferences
    @Environment(LiveActivityController.self) private var liveActivity
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        settingsForm
            .formStyle(.grouped)
            .listSectionSpacing(DesignTokens.sectionSpacing)
            .scrollContentBackground(.hidden)
            .background {
                AppBackground()
            }
            .contentMargins(.top, 8, for: .scrollContent)
            .contentMargins(.horizontal, DesignTokens.screenPadding, for: .scrollContent)
            .modifier(RootPageHeader("Settings"))
    }

    @ViewBuilder
    private var settingsForm: some View {
        Form {
            Section {
                NavigationLink {
                    HubConnectionView()
                } label: {
                    let layout = dynamicTypeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                        : AnyLayout(HStackLayout(spacing: 12))
                    layout {
                        HStack(spacing: 12) {
                            SettingsIcon(systemImage: "network", tint: DesignTokens.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Hub")
                                Text(LocalizedStringKey(hubHost))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .layoutPriority(1)
                        if !dynamicTypeSize.isAccessibilitySize {
                            Spacer(minLength: 8)
                        }
                        if sampleMode && !hubConfigured {
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
                                .labelStyle(.titleAndIcon)
                                .fixedSize()
                        }
                    }
                }
            }

            Section("Customize") {
                customizeRow(
                    "Appearance",
                    icon: "circle.lefthalf.filled",
                    tint: Color(red: 0.42, green: 0.45, blue: 0.95),
                    value: Text(LocalizedStringKey(preferences.appearance.title))
                ) {
                    appearanceSection(preferences: preferences)
                }
                customizeRow(
                    "Language & Region",
                    icon: "globe",
                    tint: Color(red: 0.16, green: 0.6, blue: 0.86),
                    value: Text("\(Text(LocalizedStringKey(preferences.language.displayName))) · \(preferences.currency.rawValue)")
                ) {
                    regionalSection(preferences: preferences)
                }
                customizeRow(
                    "Overview",
                    icon: "house.fill",
                    tint: Color(red: 0.95, green: 0.58, blue: 0.2),
                    value: Text("\(visibleOverviewSectionCount) sections")
                ) {
                    overviewSection(preferences: preferences)
                }
                NavigationLink {
                    LimitProviderOrderEditor()
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    settingsLabel(
                        "AI Limits",
                        icon: "gauge.with.needle",
                        tint: Color(red: 0.25, green: 0.62, blue: 0.55),
                        value: Text("\(visibleLimitProviderCount) visible")
                    )
                }
                NavigationLink {
                    WidgetSettingsView()
                } label: {
                    settingsLabel(
                        "Widgets",
                        icon: "widget.small.badge.plus",
                        tint: Color(red: 0.62, green: 0.4, blue: 0.92),
                        value: Text(LocalizedStringKey(preferences.widgetContent.title))
                    )
                }
                NavigationLink {
                    LiveActivityCustomizerView()
                } label: {
                    settingsLabel(
                        "Live Activity",
                        icon: "platter.filled.bottom.and.arrow.down.iphone",
                        tint: Color(red: 0.28, green: 0.7, blue: 0.4),
                        value: Text(LocalizedStringKey(liveActivity.isActive ? "Active" : preferences.liveActivityEnabled ? "Waiting" : "Off"))
                    )
                }
            }

            Section("Information") {
                NavigationLink {
                    settingsPage("Privacy") { privacySection }
                } label: {
                    settingsLabel(
                        "Privacy",
                        icon: "lock.shield.fill",
                        tint: Color(red: 0.2, green: 0.55, blue: 0.85),
                        value: Text(LocalizedStringKey(preferences.masksAccountEmails ? "Emails masked" : "Emails visible"))
                    )
                }
                NavigationLink {
                    settingsPage("About") { aboutSection }
                } label: {
                    settingsLabel(
                        "About",
                        icon: "info.circle.fill",
                        tint: Color(red: 0.55, green: 0.6, blue: 0.66),
                        value: Text(appVersion)
                    )
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
        value: Text? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        NavigationLink {
            settingsPage(title, content: content)
        } label: {
            settingsLabel(title, icon: icon, tint: tint, value: value)
        }
    }

    private func settingsLabel(
        _ title: LocalizedStringKey,
        icon: String,
        tint: Color,
        value: Text? = nil
    ) -> some View {
        HStack(spacing: 12) {
            SettingsIcon(systemImage: icon, tint: tint)
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                Text(title)
                    .foregroundStyle(.primary)
                    .layoutPriority(1)
                if !dynamicTypeSize.isAccessibilitySize {
                    Spacer(minLength: 8)
                }
                if let value {
                    value
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                }
            }
        }
    }

    private var visibleLimitProviderCount: Int {
        let ids = (store.stats?.limits?.providers ?? []).map(\.normalizedProviderID)
            + preferences.limitProviderOrder
            + Array(preferences.hiddenLimitProviders)
        return LimitProviderOrder.sortedIDs(ids, order: preferences.limitProviderOrder)
            .filter { !preferences.hiddenLimitProviders.contains($0) }.count
    }

    private var visibleOverviewSectionCount: Int {
        OverviewSection.allCases.filter {
            !preferences.hiddenOverviewSections.contains($0.id)
        }.count
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    }

    private var appBuild: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
    }

    private func settingsPage<Content: View>(
        _ title: LocalizedStringKey,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Form { content() }
            .formStyle(.grouped)
            .listSectionSpacing(DesignTokens.sectionSpacing)
            .scrollContentBackground(.hidden)
            .background { AppBackground() }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarVisibility(.visible, for: .navigationBar)
            .tint(DesignTokens.accent)
    }

    @ViewBuilder
    private func regionalSection(preferences: AppPreferences) -> some View {
        @Bindable var preferences = preferences

        Section {
            Picker("Language", selection: $preferences.language) {
                ForEach(AppLanguage.allCases) { language in
                    Text(LocalizedStringKey(language.displayName)).tag(language)
                }
            }

            Picker("Currency", selection: $preferences.currency) {
                ForEach(AppCurrency.allCases) { currency in
                    Text(currency.displayName(locale: preferences.language.locale))
                        .tag(currency)
                }
            }
        } footer: {
            Text("Usage costs are converted from USD for display. Provider balances keep their original currency.")
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
            Toggle("Live speed", isOn: $preferences.showsLiveTokenRate)
            NavigationLink {
                OverviewSectionOrderEditor()
            } label: {
                LabeledContent("Sections") {
                    Text("\(visibleOverviewSectionCount) visible")
                        .foregroundStyle(.secondary)
                }
            }
        } footer: {
            Text("Show new timed output near the top of Overview. The rate returns to a dash when updates stop.")
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
            .labelsHidden()
        } footer: {
            Text("System follows your iPhone’s appearance. Display preferences do not change your desktop app.")
        }
    }

    @ViewBuilder
    private var privacySection: some View {
        @Bindable var preferences = preferences

        Section {
            Toggle("Mask account emails", isOn: $preferences.masksAccountEmails)
        } footer: {
            Text("Hide parts of account email addresses when displaying limits in the app.")
        }

        Section("Data protection") {
            Label(
                "The shared secret is stored in the iOS Keychain.",
                systemImage: "key.fill"
            )
            .accessibilityElement(children: .combine)
            Label(
                "Widgets receive only a versioned, privacy-safe usage snapshot.",
                systemImage: "rectangle.3.group.bubble.left.fill"
            )
            .accessibilityElement(children: .combine)
            Label(
                "Provider credentials stay on your reporting devices.",
                systemImage: "lock.shield.fill"
            )
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private var aboutSection: some View {
        Section {
            LabeledContent("App", value: "Token Monitor for iOS")
            LabeledContent("Version", value: appVersion)
            LabeledContent("Build", value: appBuild)
            LabeledContent("Minimum version", value: "iOS 26")
            LabeledContent("Data source", value: "Token Monitor Hub")
        }
        Section("Support") {
            if let url = URL(string: "https://github.com/Javis603/token-monitor") {
                Link(destination: url) {
                    Label("Project website", systemImage: "safari")
                }
            }
            if let url = URL(string: "https://github.com/Javis603/token-monitor/issues") {
                Link(destination: url) {
                    Label("Report an issue", systemImage: "bubble.left.and.exclamationmark.bubble.right")
                }
            }
        }
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
                VStack(alignment: .leading, spacing: 6) {
                    Text("Hub URL")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField(text: $settings.hubURL, prompt: Text(verbatim: "https://your-hub.example")) {
                        Text("Hub URL")
                    }
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.URL)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Shared secret")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    SecureField("Shared secret", text: $settings.secret)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Button {
                    guard let configuration = settings.save() else { return }
                    liveActivity.configure(configuration)
                    store.configure(configuration)
                } label: {
                    Label("Save & Connect", systemImage: "link")
                        .labelStyle(.titleAndIcon)
                        .frame(maxWidth: .infinity, minHeight: DesignTokens.controlHeight)
                }
                .modifier(AppActionStyle())
                .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))

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

            Section("Status") {
                HStack(spacing: 12) {
                    Text("Connection")
                    Spacer(minLength: 8)
                    ConnectionBadge(phase: store.phase)
                }
                .frame(minHeight: DesignTokens.controlHeight)
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                if let updatedDate = Date.hubTimestamp(from: store.stats?.updatedAt) {
                    LabeledContent("Last update") {
                        Text(updatedDate, style: .relative)
                    }
                }
                if case let .failed(message) = store.phase {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(DesignTokens.critical)
                }
            }

            if let devices = store.stats?.sortedDevices, !devices.isEmpty {
                Section("Devices") {
                    if devices.allSatisfy({ $0.stale != nil }) {
                        LabeledContent("Online") {
                            Text("\(devices.filter { $0.stale == false }.count) / \(devices.count)")
                                .monospacedDigit()
                        }
                    }
                    ForEach(devices) { device in
                        HubDeviceStatusRow(device: device)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .listSectionSpacing(DesignTokens.cardPadding)
        .scrollContentBackground(.hidden)
        .background { AppBackground() }
        .navigationTitle("Hub")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
        .tint(DesignTokens.accent)
    }
}

private struct HubDeviceStatusRow: View {
    let device: DeviceSnapshot

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: DevicePresentation.symbol(for: device.platform))
                .frame(width: 22)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(device.displayName)
                    .font(.subheadline.weight(.medium))
                if !deviceDetails.isEmpty {
                    Text(verbatim: deviceDetails)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if let stale = device.stale {
                    Text(stale ? "Offline" : "Online")
                        .font(.caption)
                        .foregroundStyle(Color(uiColor: stale ? .secondaryLabel : .systemGreen))
                }
                if let received = Date.hubTimestamp(from: device.receivedAt) {
                    Text(received, style: .relative)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Last sync")
                        .accessibilityValue(Text(received, style: .relative))
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var deviceDetails: String {
        let os = [device.osName, device.osVersion]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return [os, device.agentVersion.map { "v\($0)" } ?? ""]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }
}

/// iOS-Settings-style colored rounded-square icon.
private struct SettingsIcon: View {
    let systemImage: String
    let tint: Color

    @ScaledMetric(relativeTo: .subheadline) private var size = 30.0

    var body: some View {
        Image(systemName: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
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
