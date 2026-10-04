import SwiftUI

enum DesignTokens {
    static let screenPadding = 20.0
    static let sectionSpacing = 28.0
    static let cardPadding = 20.0
    static let cardRadius = 24.0
    static let compactRadius = 16.0
    static let controlHeight = 44.0
    static let accent = Color.blue
    static let critical = Color.red
    static let warning = Color.orange

    static func canvas(for colorScheme: ColorScheme) -> Color {
        Color(uiColor: .systemGroupedBackground)
    }

    static func border(for colorScheme: ColorScheme) -> Color {
        Color(uiColor: .separator).opacity(0.25)
    }
}
