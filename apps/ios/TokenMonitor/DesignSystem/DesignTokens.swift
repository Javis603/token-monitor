import SwiftUI

enum DesignTokens {
    static let rowTitle = Font.subheadline.weight(.semibold)
    static let rowValue = Font.subheadline.weight(.medium)
    static let rowMetadata = Font.caption
    static let rowLineSpacing = 2.0
    static let rowBarSpacing = 6.0
    static let rowDividerSpacing = 10.0
    static let contextCaution = Color(red: 241 / 255, green: 217 / 255, blue: 115 / 255)
    static let contextLow = Color(red: 244 / 255, green: 160 / 255, blue: 115 / 255)
    static let sectionTitle = Font.headline

    static let screenPadding = 20.0
    static let sectionSpacing = 24.0
    static let cardPadding = 16.0
    static let cardRadius = 24.0
    static let compactRadius = 16.0
    static let headerToCardSpacing = 10.0
    static let controlHeight = 44.0
    static let accent = Color.blue
    static let critical = Color.red
    static let warning = Color.orange

    static func trendLine(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark
            ? Color(red: 115 / 255, green: 189 / 255, blue: 245 / 255)
            : Color(red: 0.22, green: 0.55, blue: 0.81)
    }

    static func canvas(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark
            ? Color(red: 0.07, green: 0.085, blue: 0.10)
            : Color(red: 0.95, green: 0.975, blue: 0.99)
    }

    static func border(for colorScheme: ColorScheme) -> Color {
        Color(uiColor: .separator).opacity(0.25)
    }
}
