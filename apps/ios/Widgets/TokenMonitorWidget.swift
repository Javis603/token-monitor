import SwiftUI
import WidgetKit

struct TokenMonitorWidget: Widget {
    let kind = "TokenMonitorWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: TokenMonitorWidgetIntent.self,
            provider: TokenMonitorWidgetProvider()
        ) { entry in
            TokenMonitorWidgetView(entry: entry)
        }
        .configurationDisplayName("Token Monitor")
        .description("Usage, AI limits, or your activity heatmap at a glance.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .systemLarge,
            .accessoryRectangular
        ])
        .contentMarginsDisabled()
        .containerBackgroundRemovable(true)
    }
}
