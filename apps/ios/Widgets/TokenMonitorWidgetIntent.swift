import AppIntents
import WidgetKit

struct TokenMonitorWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Token Monitor"
    static let description = IntentDescription(
        "Choose which Hub data appears in this widget."
    )

    @Parameter(title: "Content", default: .appDefault)
    var content: WidgetContentOption

    @Parameter(title: "Period", default: .appDefault)
    var period: WidgetPeriodOption

    @Parameter(title: "Limit Provider")
    var provider: ProviderEntity?

    @Parameter(title: "Cost", default: .appDefault)
    var costVisibility: WidgetVisibilityOption

    @Parameter(title: "Update Time", default: .appDefault)
    var updateTimeVisibility: WidgetVisibilityOption

    @Parameter(title: "Text Contrast", default: .recommended)
    var textContrast: WidgetTextContrastOption

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$content), \(\.$period)") {
            \.$provider
            \.$costVisibility
            \.$updateTimeVisibility
            \.$textContrast
        }
    }
}
