import AppIntents

enum WidgetContentOption: String, AppEnum {
    case appDefault
    case overview
    case limits
    case activity

    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Widget Content"
    )

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .overview: "Usage Overview",
        .limits: "AI Limits",
        .activity: "Activity Heatmap"
    ]
}
