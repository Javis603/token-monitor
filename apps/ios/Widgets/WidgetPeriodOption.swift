import AppIntents

enum WidgetPeriodOption: String, AppEnum {
    case appDefault
    case today
    case month
    case allTime

    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Usage Period"
    )

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .appDefault: "App Default",
        .today: "Today",
        .month: "This Month",
        .allTime: "All Time"
    ]
}
