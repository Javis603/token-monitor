import SwiftUI
import WidgetKit

/// WidgetKit exposes `widgetFamily` read-only in the environment; the root
/// view takes it explicitly so the app can pick a family too. This wrapper
/// bridges the two inside the extension.
private struct FamilyHost: View {
    @Environment(\.widgetFamily) private var family
    let entry: TokenMonitorWidgetEntry
    let surface: TokenMonitorWidgetSurface

    var body: some View {
        TokenMonitorWidgetView(entry: entry, surface: surface, family: family)
    }
}

struct TokenMonitorWidget: Widget {
    let surface: TokenMonitorWidgetSurface

    init() { surface = .solid }
    init(surface: TokenMonitorWidgetSurface) { self.surface = surface }

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: surface.kind,
            intent: TokenMonitorWidgetIntent.self,
            provider: TokenMonitorWidgetProvider()
        ) { entry in
            FamilyHost(entry: entry, surface: surface)
        }
        .configurationDisplayName(surface.name)
        .description("Usage, AI limits, or your activity heatmap at a glance.")
        .supportedFamilies(surface == .solid
            ? [.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular, .accessoryInline]
            : [.systemSmall, .systemMedium, .systemLarge])
        .containerBackgroundRemovable(true)
    }
}
