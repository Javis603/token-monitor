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

    // Artwork matches the desktop row icons for tools, models, and limits.
    static func assetName(for providerID: String?) -> String {
        switch providerID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "claude": "VendorClaude"
        case "codex": "VendorCodex"
        case "opencode": "VendorOpenCode"
        case "hermes": "VendorHermes"
        case "openclaw": "VendorOpenClaw"
        case "cursor": "VendorCursor"
        case "antigravity": "VendorAntigravity"
        case "cline": "VendorCline"
        case "amp": "VendorAmp"
        case "droid", "factory": "VendorDroid"
        case "kimi": "VendorKimi"
        case "qwen": "VendorQwen"
        case "grok": "VendorGrok"
        case "copilot": "VendorCopilot"
        case "pi": "VendorPi"
        case "omp": "VendorOMP"
        case "zed": "VendorZed"
        case "kilo", "kilocode": "VendorKiloCode"
        case "commandcode": "VendorCommandCode"
        case "mimo", "xiaomi", "micode": "VendorXiaomi"
        case "muse", "meta": "VendorMeta"
        case "zcode", "zai", "zaiteam": "VendorZai"
        case "kiro": "VendorKiro"
        case "codebuddy": "VendorCodeBuddy"
        case "workbuddy": "VendorWorkBuddy"
        case "proma": "VendorProma"
        case "qodercn": "VendorQoderCN"
        case "reasonix": "VendorReasonix"
        case "dsh": "VendorDSH"
        case "cherrystudio": "VendorCherryStudio"
        case "lmstudio": "VendorLMStudio"
        case "unsloth": "VendorUnsloth"
        case "devin": "VendorDevin"
        case "fx": "VendorFX"
        case "mcode", "minimax": "VendorMiniMax"
        case "openrouter": "VendorOpenRouter"
        case "gemini": "VendorGemini"
        case "qoder": "VendorQoder"
        case "deepseek": "VendorDeepSeek"
        case "xai": "VendorXAI"
        case "mistral": "VendorMistral"
        case "moonshot": "VendorMoonshot"
        case "cohere": "VendorCohere"
        case "doubao": "VendorDoubao"
        case "hunyuan": "VendorHunyuan"
        case "volcengine": "VendorVolcengine"
        case "ollama": "VendorOllama"
        case "trae": "VendorTrae"
        case "alibaba": "VendorAlibaba"
        case "stepfun": "VendorStepFun"
        case "nvidia": "VendorNvidia"
        case "typesafe": "VendorTypeSafe"
        case "thirdparty": "VendorThirdParty"
        case "newapi": "VendorNewAPI"
        case "sub2api": "VendorSub2API"
        default: "VendorTokenMonitor"
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
        return "VendorTokenMonitor"
    }

    static func tokens(_ value: Double, locale: Locale = .autoupdatingCurrent) -> String {
        guard value.isFinite, value >= 0 else { return "—" }
        return value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)).locale(locale))
    }

    static func currencyFromUSD(_ value: Double, displayCode: String, locale: Locale = .autoupdatingCurrent,
                                compact: Bool = false) -> String {
        currency(value, sourceCode: "USD", displayCode: displayCode, locale: locale, compact: compact)
    }

    /// `compact` drops the cents from amounts of 100 or more, for the Dynamic Island.
    static func currency(_ value: Double, sourceCode: String, displayCode: String, locale: Locale = .autoupdatingCurrent,
                         compact: Bool = false) -> String {
        guard value.isFinite else { return "—" }
        let source = sourceCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let display = displayCode.uppercased()
        // Match the fixed display rates used by AppCurrency and the Hub.
        let rates: [String: Double] = ["USD": 1, "TWD": 31.5, "HKD": 7.8, "CNY": 6.8]
        let symbols = ["USD": "$", "TWD": "NT$", "HKD": "HK$", "CNY": "¥"]
        if let sourceRate = rates[source], let displayRate = rates[display], let symbol = symbols[display] {
            let converted = value / sourceRate * displayRate
            let digits = compact && abs(converted) >= 100 ? 0 : 2
            return symbol + converted.formatted(
                .number.grouping(.automatic).precision(.fractionLength(digits)).locale(locale)
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

    /// Quota rows keep the desktop app's English vocabulary even when the
    /// rest of the widget follows the app language.
    static let desktopQuotaLocale = Locale(identifier: "en")

    static func updateDescription(for date: Date, relativeTo referenceDate: Date = .now) -> String {
        let seconds = max(0, referenceDate.timeIntervalSince(date))
        if seconds < 60 { return "Updated just now" }
        let value: Int
        let unit: String
        if seconds < 3_600 {
            value = max(1, Int(seconds / 60))
            unit = "m"
        } else if seconds < 86_400 {
            value = max(1, Int(seconds / 3_600))
            unit = "h"
        } else {
            value = max(1, Int(seconds / 86_400))
            unit = "d"
        }
        return "Updated \(value)\(unit) ago"
    }

    /// Compact header age: `now`, `5m`, `3h`, `2d` — same bucketing as
    /// `updateDescription` without the sentence.
    static func compactAge(since date: Date, now: Date = .now) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3_600 { return "\(max(1, Int(seconds / 60)))m" }
        if seconds < 86_400 { return "\(max(1, Int(seconds / 3_600)))h" }
        return "\(max(1, Int(seconds / 86_400)))d"
    }

    static func resetDescription(to date: Date, now: Date = .now) -> String {
        "Reset \(resetCountdown(to: date, now: now))"
    }

    static func resetCountdown(to date: Date, now: Date = .now) -> String {
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return "Now" }
        let totalMinutes = Int((seconds / 60).rounded())
        let days = totalMinutes / 1_440
        let hours = (totalMinutes % 1_440) / 60
        let minutes = totalMinutes % 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return minutes > 0 ? "\(minutes)m" : "<1m"
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
