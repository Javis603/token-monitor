import SwiftUI
import WidgetKit

@main
struct TokenMonitorWidgetBundle: WidgetBundle {
    var body: some Widget {
        TokenMonitorWidget()
        TokenMonitorSummaryWidget()
        TokenMonitorActivityWidget()
        TokenMonitorBreakdownWidget()
        TokenMonitorQuotaWidget()
    }
}
