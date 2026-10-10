import Foundation

nonisolated enum MetricFormatter {
    /// Quota cards keep the desktop app's English window vocabulary
    /// (`100% left`, `Reset 3d 15h`) even when the rest of the UI is localized.
    static let desktopQuotaLocale = Locale(identifier: "en")

    static func tokens(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        return value.formatted(
            .number
                .notation(.compactName)
                .precision(.fractionLength(0...1))
        )
    }

    static func exactTokens(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        return value.formatted(.number.precision(.fractionLength(0)))
    }

    static func currency(_ value: Double, code: String = "USD") -> String {
        guard value.isFinite else { return "—" }
        let normalizedCode = normalizedCurrencyCode(code)
        let symbol = AppCurrency(rawValue: normalizedCode)?.symbol ?? normalizedCode + " "
        return symbol + decimalCurrency(value)
    }

    static func currencyFromUSD(
        _ value: Double,
        currency: AppCurrency
    ) -> String {
        guard value.isFinite else { return "—" }
        return currency.symbol + decimalCurrency(value * currency.rateFromUSD)
    }

    static func usageCostFromUSD(_ value: Double, currency: AppCurrency) -> String {
        guard value.isFinite else { return "—" }
        let amount = (value * currency.rateFromUSD * 1_000_000).rounded() / 1_000_000
        let digits = abs(amount) >= (currency == .usd ? 10 : 1) ? 2 : 4
        return currency.symbol + amount.formatted(.number.precision(.fractionLength(digits)))
    }

    static func currency(
        _ value: Double,
        sourceCode: String,
        displayCurrency: AppCurrency
    ) -> String {
        let source = AppCurrency(rawValue: normalizedCurrencyCode(sourceCode))
        guard let source else {
            return currency(value, code: sourceCode)
        }
        let valueInUSD = value / source.rateFromUSD
        return currencyFromUSD(valueInUSD, currency: displayCurrency)
    }

    static func percent(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        return (value / 100).formatted(.percent.precision(.fractionLength(0)))
    }

    static func remaining(_ value: Double, locale: Locale) -> String {
        let percentage = percent(value)
        return switch language(for: locale) {
        case "zh-Hant": "\(percentage) 剩餘"
        case "zh-Hans": "\(percentage) 剩余"
        case "ja": "残り \(percentage)"
        case "ko": "\(percentage) 남음"
        default: "\(percentage) left"
        }
    }

    static func resetCount(_ count: Int, locale: Locale) -> String {
        switch language(for: locale) {
        case "zh-Hant": "\(count) 次重設"
        case "zh-Hans": "\(count) 次重置"
        case "ja": "リセット \(count) 回"
        case "ko": "재설정 \(count)회"
        default: count == 1 ? "1 reset" : "\(count) resets"
        }
    }

    static func limitCountdown(to date: Date, now: Date = .now, locale: Locale) -> String {
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else {
            return switch language(for: locale) {
            case "zh-Hant": "現在"
            case "zh-Hans": "现在"
            case "ja": "今"
            case "ko": "지금"
            default: "Now"
            }
        }
        let totalMinutes = Int((seconds / 60).rounded())
        let days = totalMinutes / 1440
        let hours = (totalMinutes % 1440) / 60
        let minutes = totalMinutes % 60
        let units: (String, String, String) = switch language(for: locale) {
        case "zh-Hant": ("日", "小時", "分鐘")
        case "zh-Hans": ("天", "小时", "分钟")
        case "ja": ("日", "時間", "分")
        case "ko": ("일", "시간", "분")
        default: ("d", "h", "m")
        }
        if days > 0 { return "\(days)\(units.0) \(hours)\(units.1)" }
        if hours > 0 { return "\(hours)\(units.1) \(minutes)\(units.2)" }
        return minutes > 0 ? "\(minutes)\(units.2)" : "<1\(units.2)"
    }

    static func accountCount(_ count: Int, locale: Locale) -> String {
        switch language(for: locale) {
        case "zh-Hant": "\(count) 個帳號"
        case "zh-Hans": "\(count) 个账户"
        case "ja": "\(count) アカウント"
        case "ko": "계정 \(count)개"
        default: count == 1 ? "1 account" : "\(count) accounts"
        }
    }

    static func duration(
        milliseconds: Double,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let hours = max(0, milliseconds) / 3_600_000
        if hours >= 24 {
            let value = (hours / 24).formatted(
                .number.precision(.fractionLength(0...1))
            )
            return value + durationSuffix(unit: "d", locale: locale)
        }
        let value = hours.formatted(
            .number.precision(.fractionLength(0...1))
        )
        return value + durationSuffix(unit: "h", locale: locale)
    }

    static func days(_ value: Double, locale: Locale) -> String {
        exactTokens(value) + durationSuffix(unit: "d", locale: locale)
    }

    private static func normalizedCurrencyCode(_ value: String) -> String {
        let code = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return code.isEmpty ? "USD" : code
    }

    private static func decimalCurrency(_ value: Double) -> String {
        value.formatted(
            .number
                .grouping(.automatic)
                .precision(.fractionLength(2))
        )
    }

    private static func language(for locale: Locale) -> String {
        let identifier = locale.identifier.lowercased()
        if identifier.hasPrefix("zh") {
            return identifier.contains("hant")
                || identifier.contains("tw")
                || identifier.contains("hk")
                ? "zh-Hant"
                : "zh-Hans"
        }
        if identifier.hasPrefix("ja") { return "ja" }
        if identifier.hasPrefix("ko") { return "ko" }
        return "en"
    }

    private static func durationSuffix(unit: String, locale: Locale) -> String {
        switch language(for: locale) {
        case "zh-Hant", "zh-Hans": unit == "d" ? " 天" : " 小時"
        case "ja": unit == "d" ? "日" : "時間"
        case "ko": unit == "d" ? "일" : "시간"
        default: unit
        }
    }
}
