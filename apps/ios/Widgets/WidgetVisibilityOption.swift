import AppIntents

enum WidgetVisibilityOption: String, AppEnum {
    case appDefault
    case show
    case hide

    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Visibility"
    )

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .show: "Show",
        .hide: "Hide"
    ]
}
