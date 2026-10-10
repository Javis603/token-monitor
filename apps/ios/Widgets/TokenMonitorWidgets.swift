import SwiftUI
import WidgetKit

@main
struct TokenMonitorWidgets: WidgetBundle {
    var body: some Widget {
        TokenMonitorWidget(surface: .liquidGlass)
        TokenMonitorWidget(surface: .transparent)
        TokenMonitorWidget(surface: .solid)
        TokenMonitorActivityWidget()
    }
}
