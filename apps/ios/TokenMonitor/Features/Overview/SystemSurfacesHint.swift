import SwiftUI

/// A one-time invitation based on the system's reported widget configuration.
struct SystemSurfacesHint: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage("systemSurfacesHintDismissed") private var dismissed = false
    let widgetCount: Int?

    var body: some View {
        Group {
            if !dismissed, !preferences.liveActivityEnabled, widgetCount == 0 {
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top, spacing: 12) {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("Your usage, at a glance")
                                    .font(.subheadline.weight(.semibold))
                                Text("Keep readings on your Home Screen or Lock Screen.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Button("Dismiss", systemImage: "xmark") {
                                dismissed = true
                            }
                            .labelStyle(.iconOnly)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: DesignTokens.controlHeight, minHeight: DesignTokens.controlHeight)
                            .contentShape(.rect)
                            .buttonStyle(.plain)
                        }
                        let layout = dynamicTypeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                            : AnyLayout(HStackLayout(spacing: 16))
                        layout {
                            NavigationLink {
                                LiveActivityCustomizerView()
                            } label: {
                                Label("Live Activity", systemImage: "capsule")
                                    .frame(minHeight: DesignTokens.controlHeight)
                            }
                            NavigationLink {
                                WidgetSettingsView()
                            } label: {
                                Label("Widgets", systemImage: "square.grid.2x2")
                                    .frame(minHeight: DesignTokens.controlHeight)
                            }
                        }
                        .font(.subheadline.weight(.medium))
                        .buttonStyle(.plain)
                        .foregroundStyle(DesignTokens.accent)
                    }
                }
            }
        }
    }
}
