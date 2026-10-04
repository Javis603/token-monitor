import Foundation

nonisolated enum MetricFormatter {
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

    static func accountCount(_ count: Int, locale: Locale) -> String {
        switch language(for: locale) {
        case "zh-Hant": "\(count) 個帳號"
        case "zh-Hans": "\(count) 个账户"
        case "ja": "\(count) アカウント"
        case "ko": "계정 \(count)개"
        default: count == 1 ? "1 account" : "\(count) accounts"
        }
    }

    static func attentionCount(_ count: Int, locale: Locale) -> String {
        switch language(for: locale) {
        case "zh-Hant": "\(count) 項需要留意"
        case "zh-Hans": "\(count) 项需要注意"
        case "ja": "要確認 \(count) 件"
        case "ko": "확인 필요 \(count)개"
        default: "\(count) need attention"
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
