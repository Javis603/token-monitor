import SwiftUI

nonisolated enum WidgetPresentation {
    static let accent = Color(
        red: 115 / 255,
        green: 189 / 255,
        blue: 245 / 255
    )

    static func displayName(for providerID: String?) -> String {
        switch providerID?.lowercased() {
        case "claude": "Claude"
        case "codex": "Codex"
        case "cursor": "Cursor"
        case "antigravity": "Antigravity"
        case "opencode": "OpenCode"
        case "openrouter": "OpenRouter"
        case "deepseek": "DeepSeek"
        case "minimax": "MiniMax"
        case "mimo": "MiMo"
        case "grok": "Grok"
        case "copilot": "GitHub Copilot"
        case "kiro": "Kiro"
        case "zai", "zaiteam": "Z.ai"
        case "volcengine": "Volcengine"
        case "qoder": "Qoder"
        case "kimi": "Kimi"
        case "ollama": "Ollama"
        default: providerID?.capitalized ?? "Provider"
        }
    }

    static func assetName(for providerID: String?) -> String {
        switch providerID?.lowercased() {
        case "claude": "VendorClaude"
        case "codex": "VendorCodex"
        case "cursor": "VendorCursor"
        case "antigravity": "VendorAntigravity"
        case "opencode": "VendorOpenCode"
        case "openrouter": "VendorOpenRouter"
        case "deepseek": "VendorDeepSeek"
        case "minimax": "VendorMiniMax"
        case "mimo", "micode", "xiaomi": "VendorXiaomi"
        case "grok", "xai": "VendorGrok"
        case "copilot": "VendorCopilot"
        case "kiro": "VendorKiro"
        case "zai", "zaiteam": "VendorZai"
        case "volcengine": "VendorVolcengine"
        case "qoder": "VendorQoder"
        case "kimi": "VendorKimi"
        case "ollama": "VendorOllama"
        default: "VendorNewAPI"
        }
    }

    static func modelAssetName(for model: String) -> String {
        let name = model.lowercased()
        if name.contains("claude")
            || name.contains("sonnet")
            || name.contains("opus")
            || name.contains("haiku") {
            return "VendorClaude"
        }
        if name.contains("gpt")
            || name.contains("openai")
            || name.contains("codex")
            || name.hasPrefix("o1-")
            || name.hasPrefix("o3-")
            || name.hasPrefix("o4-") {
            return "VendorCodex"
        }
        if name.contains("gemini") || name.contains("gemma") {
            return "VendorGemini"
        }
        if name.contains("grok") {
            return "VendorGrok"
        }
        if name.contains("deepseek") {
            return "VendorDeepSeek"
        }
        if name.contains("qwen") {
            return "VendorQwen"
        }
        if name.contains("mistral") || name.contains("codestral") {
            return "VendorMistral"
        }
        return "VendorNewAPI"
    }

    static func tokens(_ value: Double, locale: Locale = .autoupdatingCurrent) -> String {
        guard value.isFinite, value >= 0 else { return "—" }
        return value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)).locale(locale))
    }

    static func currencyFromUSD(_ value: Double, displayCode: String, locale: Locale = .autoupdatingCurrent) -> String {
        currency(value, sourceCode: "USD", displayCode: displayCode, locale: locale)
    }

    static func currency(_ value: Double, sourceCode: String, displayCode: String, locale: Locale = .autoupdatingCurrent) -> String {
        guard value.isFinite else { return "—" }
        let source = sourceCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let display = displayCode.uppercased()
        // Match the fixed display rates used by AppCurrency and the Hub.
        let rates: [String: Double] = ["USD": 1, "TWD": 31.5, "HKD": 7.8, "CNY": 6.8]
        let symbols = ["USD": "$", "TWD": "NT$", "HKD": "HK$", "CNY": "¥"]
        if let sourceRate = rates[source], let displayRate = rates[display], let symbol = symbols[display] {
            return symbol + (value / sourceRate * displayRate).formatted(
                .number.grouping(.automatic).precision(.fractionLength(2)).locale(locale)
            )
        }
        return value.formatted(.currency(code: source).presentation(.isoCode).precision(.fractionLength(0...2)).locale(locale))
    }

    static func fraction(_ value: Double?, total: Double = 1) -> Double? {
        guard let value, value.isFinite, total.isFinite, total > 0 else { return nil }
        return min(1, max(0, value / total))
    }

    static func percent(_ value: Double, locale: Locale = .autoupdatingCurrent) -> String {
        guard let fraction = fraction(value, total: 100) else { return "—" }
        return fraction.formatted(.percent.precision(.fractionLength(0)).locale(locale))
    }

    static func remaining(_ value: Double, locale: Locale) -> String {
        let percentage = percent(value, locale: locale)
        let identifier = locale.identifier.lowercased()
        if identifier.hasPrefix("zh") {
            let traditional = identifier.contains("hant")
                || identifier.contains("tw")
                || identifier.contains("hk")
            return traditional
                ? "\(percentage) 剩餘"
                : "\(percentage) 剩余"
        }
        if identifier.hasPrefix("ja") { return "残り \(percentage)" }
        if identifier.hasPrefix("ko") { return "\(percentage) 남음" }
        return "\(percentage) left"
    }

    static func heatColor(level: Int) -> Color {
        switch level {
        case 4: Color(red: 180 / 255, green: 230 / 255, blue: 1)
        case 3: Color(red: 150 / 255, green: 210 / 255, blue: 1).opacity(0.8)
        case 2: Color(red: 120 / 255, green: 190 / 255, blue: 1).opacity(0.45)
        case 1: Color(red: 90 / 255, green: 170 / 255, blue: 1).opacity(0.18)
        default: Color.primary.opacity(0.07)
        }
    }
}
