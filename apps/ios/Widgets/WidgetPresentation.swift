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

    static func tokens(_ value: Double) -> String {
        value.formatted(
            .number
                .notation(.compactName)
                .precision(.fractionLength(0...1))
        )
    }

    static func currencyFromUSD(_ value: Double, displayCode: String) -> String {
        currency(value, sourceCode: "USD", displayCode: displayCode)
    }

    static func currency(
        _ value: Double,
        sourceCode: String,
        displayCode: String
    ) -> String {
        let sourceRate = rate(for: sourceCode)
        let displayRate = rate(for: displayCode)
        guard let sourceRate, let displayRate else {
            return symbol(for: sourceCode) + decimal(value)
        }
        return symbol(for: displayCode) + decimal(value / sourceRate * displayRate)
    }

    private static func rate(for code: String) -> Double? {
        switch code.uppercased() {
        case "USD": 1
        case "TWD": 31.5
        case "HKD": 7.8
        case "CNY": 6.8
        default: nil
        }
    }

    private static func symbol(for code: String) -> String {
        switch code.uppercased() {
        case "USD": "$"
        case "TWD": "NT$"
        case "HKD": "HK$"
        case "CNY": "¥"
        default: code.uppercased() + " "
        }
    }

    private static func decimal(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...2)))
    }

    static func percent(_ value: Double) -> String {
        "\(Int(value.rounded()))%"
    }

    static func remaining(_ value: Double, locale: Locale) -> String {
        let percentage = percent(value)
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
