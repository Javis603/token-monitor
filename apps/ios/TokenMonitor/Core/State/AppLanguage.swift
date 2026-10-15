import Foundation

nonisolated enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case system = "auto"
    case english = "en"
    case traditionalChinese = "zh-TW"
    case simplifiedChinese = "zh-CN"
    case japanese = "ja"
    case korean = "ko"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .system: "Auto (System)"
        case .english: "English"
        case .traditionalChinese: "繁體中文"
        case .simplifiedChinese: "简体中文"
        case .japanese: "日本語"
        case .korean: "한국어"
        }
    }

    var locale: Locale {
        switch self {
        case .system: .autoupdatingCurrent
        case .english: Locale(identifier: "en")
        case .traditionalChinese: Locale(identifier: "zh-Hant")
        case .simplifiedChinese: Locale(identifier: "zh-Hans")
        case .japanese: Locale(identifier: "ja")
        case .korean: Locale(identifier: "ko")
        }
    }
}
