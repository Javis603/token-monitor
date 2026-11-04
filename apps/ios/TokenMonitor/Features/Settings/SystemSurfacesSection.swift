import SwiftUI

/// Compact discovery rows; each customizer owns its full preview and controls.
struct SystemSurfacesSection: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(LiveActivityController.self) private var liveActivity
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var surfaces = SystemSurfaceStatus()

    var body: some View {
        Section("Live Activity & Widgets") {
            NavigationLink {
                LiveActivityCustomizerView()
            } label: {
                featureRow(
                    "Live Activity",
                    detail: "Dynamic Island & Lock Screen",
                    icon: "platter.filled.bottom.and.arrow.down.iphone",
                    tint: Color(red: 0.28, green: 0.7, blue: 0.4)
                ) {
                    Text(liveStatus)
                        .foregroundStyle(hasLiveError ? DesignTokens.critical : Color.secondary)
                }
            }
            .task { await surfaces.refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await surfaces.refresh() } }
            }

            NavigationLink {
                WidgetSettingsView()
            } label: {
                featureRow(
                    "Widgets",
                    detail: "Home Screen & Lock Screen",
                    icon: "widget.small.badge.plus",
                    tint: Color(red: 0.62, green: 0.4, blue: 0.92)
                ) {
                    widgetCountValue
                }
            }
        }
    }

    private var hasLiveError: Bool {
        preferences.liveActivityEnabled && liveActivity.errorMessage != nil
    }

    private var liveStatus: LocalizedStringKey {
        guard preferences.liveActivityEnabled else { return "Off" }
        if hasLiveError { return "Error" }
        return liveActivity.isActive ? "Active" : "Waiting"
    }

    @ViewBuilder
    private var widgetCountValue: some View {
        if let count = surfaces.widgetCount {
            if count == 0 {
                Text("None added")
            } else {
                Text("\(count) widgets")
            }
        } else {
            Text(verbatim: "—").accessibilityLabel(Text("Unknown"))
        }
    }

    private func featureRow<Status: View>(
        _ title: LocalizedStringKey,
        detail: LocalizedStringKey,
        icon: String,
        tint: Color,
        @ViewBuilder status: () -> Status
    ) -> some View {
        HStack(spacing: 12) {
            SettingsIcon(systemImage: icon, tint: tint)
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.primary)
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                .layoutPriority(1)
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                status().font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
