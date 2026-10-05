import SwiftUI

enum DesignTokens {
    static let screenPadding = 16.0
    static let sectionSpacing = 14.0
    static let cardPadding = 16.0
    static let cardRadius = 16.0
    static let compactRadius = 12.0
    static let controlHeight = 44.0
    static let accent = Color(red: 115 / 255, green: 189 / 255, blue: 245 / 255)
    static let critical = Color(red: 244 / 255, green: 119 / 255, blue: 136 / 255)
    static let warning = Color(red: 244 / 255, green: 160 / 255, blue: 115 / 255)

    static func canvas(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark
            ? Color(red: 0.025, green: 0.035, blue: 0.05)
            : Color(red: 0.955, green: 0.97, blue: 0.985)
    }

    static func border(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark
            ? .white.opacity(0.1)
            : .white.opacity(0.8)
    }
}
