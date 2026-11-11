import Foundation

nonisolated enum AppCurrency: String, CaseIterable, Identifiable, Sendable {
    case usd = "USD"
    case twd = "TWD"
    case hkd = "HKD"
    case cny = "CNY"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .usd: "$"
        case .twd: "NT$"
        case .hkd: "HK$"
        case .cny: "¥"
        }
    }

    var rateFromUSD: Double {
        switch self {
        case .usd: 1
        case .twd: 31.5
        case .hkd: 7.8
        case .cny: 6.8
        }
    }

    func displayName(locale: Locale) -> String {
        let identifier = locale.identifier.lowercased()
        let language: String
        if identifier.hasPrefix("zh") {
            language = identifier.contains("hant")
                || identifier.contains("tw")
                || identifier.contains("hk")
                ? "zh-Hant"
                : "zh-Hans"
        } else if identifier.hasPrefix("ja") {
            language = "ja"
        } else if identifier.hasPrefix("ko") {
            language = "ko"
        } else {
            language = "en"
        }

        let name: String = switch (self, language) {
        case (.usd, "zh-Hant"): "美元"
        case (.twd, "zh-Hant"): "新台幣"
        case (.hkd, "zh-Hant"): "港幣"
        case (.cny, "zh-Hant"): "人民幣"
        case (.usd, "zh-Hans"): "美元"
        case (.twd, "zh-Hans"): "新台币"
        case (.hkd, "zh-Hans"): "港币"
        case (.cny, "zh-Hans"): "人民币"
        case (.usd, "ja"): "米ドル"
        case (.twd, "ja"): "ニュー台湾ドル"
        case (.hkd, "ja"): "香港ドル"
        case (.cny, "ja"): "人民元"
        case (.usd, "ko"): "미국 달러"
        case (.twd, "ko"): "신 타이완 달러"
        case (.hkd, "ko"): "홍콩 달러"
        case (.cny, "ko"): "중국 위안"
        case (.usd, _): "US Dollar"
        case (.twd, _): "New Taiwan Dollar"
        case (.hkd, _): "Hong Kong Dollar"
        case (.cny, _): "Chinese Yuan"
        }
        return "\(rawValue) — \(name)"
    }
}
