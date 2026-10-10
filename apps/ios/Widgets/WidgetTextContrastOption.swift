import AppIntents

enum WidgetTextContrastOption: String, AppEnum {
    case recommended
    case light
    case dark

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Text Contrast")

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .recommended: "Recommended",
        .light: "Light Text",
        .dark: "Dark Text"
    ]
}
