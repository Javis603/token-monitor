import SwiftUI

nonisolated enum ProviderPresentation {
    static func displayName(for provider: String?) -> String {
        switch provider?.lowercased() {
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
        case "zai": "Z.ai"
        case "zaiteam": "Z.ai Team"
        case "volcengine": "Volcengine"
        case "qoder": "Qoder"
        case "kimi": "Kimi"
        case "ollama": "Ollama"
        case "thirdparty": "Custom Provider"
        default:
            provider?.capitalized ?? "Provider"
        }
    }

    static func assetName(for provider: String?) -> String {
        switch provider?.lowercased() {
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
        case "hermes": "VendorHermes"
        case "gemini": "VendorGemini"
        case "cline": "VendorCline"
        case "cohere": "VendorCohere"
        case "meta": "VendorMeta"
        case "mistral": "VendorMistral"
        case "moonshot": "VendorMoonshot"
        case "qwen": "VendorQwen"
        case "pi": "VendorPi"
        case "zed": "VendorZed"
        case "kilocode": "VendorKiloCode"
        case "codebuddy": "VendorCodeBuddy"
        case "workbuddy": "VendorWorkBuddy"
        case "proma": "VendorProma"
        case "openclaw": "VendorOpenClaw"
        case "doubao": "VendorDoubao"
        default: "VendorNewAPI"
        }
    }

    static func color(for provider: String?) -> Color {
        switch provider?.lowercased() {
        case "claude": Color(red: 0.80, green: 0.49, blue: 0.37)
        case "codex": Color(red: 0.29, green: 0.64, blue: 0.69)
        case "cursor": Color(red: 0.42, green: 0.71, blue: 0.94)
        case "antigravity", "gemini": Color(red: 0.26, green: 0.52, blue: 0.96)
        case "opencode": Color(red: 0.64, green: 0.69, blue: 0.75)
        case "openrouter": Color(red: 0.40, green: 0.40, blue: 0.95)
        case "deepseek": Color(red: 0.30, green: 0.42, blue: 1)
        case "minimax": Color(red: 0.95, green: 0.25, blue: 0.36)
        case "mimo", "micode", "xiaomi": Color(red: 1, green: 0.40, blue: 0)
        case "grok": .primary
        case "copilot": Color(red: 0.66, green: 0.70, blue: 0.75)
        case "kiro": Color(red: 0.56, green: 0.27, blue: 1)
        case "zai", "zaiteam": Color(red: 0.42, green: 0.71, blue: 0.94)
        case "volcengine": Color(red: 0, green: 0.43, blue: 1)
        case "qoder": Color(red: 0.16, green: 0.86, blue: 0.36)
        case "kimi", "moonshot": Color(red: 0.45, green: 0.55, blue: 0.70)
        case "ollama": Color(red: 0.53, green: 0.53, blue: 0.53)
        case "hermes": Color(red: 0.83, green: 0.69, blue: 0.22)
        default: Color(red: 0.42, green: 0.71, blue: 0.94)
        }
    }

    static func modelVendor(for model: String) -> String? {
        let name = model.lowercased()
        if name == "auto" || name == "cursor-auto" {
            return "cursor"
        }
        if name.contains("claude")
            || name.contains("anthropic")
            || name.contains("sonnet")
            || name.contains("opus")
            || name.contains("haiku") {
            return "claude"
        }
        if name.contains("gpt")
            || name.contains("openai")
            || name.contains("codex")
            || name.contains("chatgpt")
            || name.range(of: #"^o[134](?:-|$)"#, options: .regularExpression) != nil {
            return "codex"
        }
        if name.contains("gemini") || name.contains("gemma") || name.contains("google") {
            return "gemini"
        }
        if name.contains("grok") || name.contains("xai") {
            return "grok"
        }
        if name.contains("deepseek") {
            return "deepseek"
        }
        if name.contains("llama") || name.contains("meta") {
            return "meta"
        }
        if name.contains("mistral") || name.contains("mixtral") || name.contains("codestral") {
            return "mistral"
        }
        if name.contains("qwen") || name.contains("qwq") || name.contains("qvq") {
            return "qwen"
        }
        if name.contains("kimi") || name.contains("moonshot") {
            return "kimi"
        }
        if name.contains("chatglm")
            || name.contains("glm-")
            || name.contains("z.ai")
            || name.contains("zhipu") {
            return "zai"
        }
        if name.contains("cohere") || name.contains("command-r") {
            return "cohere"
        }
        if name.contains("mimo") || name.contains("xiaomi") {
            return "xiaomi"
        }
        if name.contains("minimax") || name.contains("abab") {
            return "minimax"
        }
        if name.contains("doubao") || name.hasPrefix("seed-") {
            return "doubao"
        }
        if name == "big-pickle" {
            return "opencode"
        }
        return nil
    }
}
