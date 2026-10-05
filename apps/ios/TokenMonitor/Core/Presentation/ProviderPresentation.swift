import SwiftUI

nonisolated enum ProviderPresentation {
    static func displayName(for provider: String?) -> String {
        switch normalizedID(provider) {
        case "claude": "Claude"
        case "codex": "Codex"
        case "cursor": "Cursor"
        case "antigravity": "Antigravity"
        case "opencode": "OpenCode"
        case "openrouter": "OpenRouter"
        case "deepseek": "DeepSeek"
        case "minimax": "MiniMax"
        case "mimo", "micode": "Xiaomi MiMo"
        case "grok": "Grok"
        case "copilot": "GitHub Copilot"
        case "kiro": "Kiro"
        case "zai": "GLM"
        case "zaiteam": "GLM Team"
        case "volcengine": "Volcengine"
        case "qoder": "Qoder"
        case "kimi": "Kimi"
        case "ollama": "Ollama"
        case "cline": "Cline"
        case "factory", "droid": "Factory Droid"
        case "zed": "Zed"
        case "commandcode": "Command Code"
        case "workbuddy": "WorkBuddy"
        case "codebuddy": "CodeBuddy"
        case "devin": "Devin"
        case "typesafe": "TypeSafe"
        case "trae": "Trae CN"
        case "alibaba": "Alibaba Cloud"
        case "stepfun": "StepFun"
        case "thirdparty": "Third-party APIs"
        case "newapi": "New API"
        case "sub2api": "Sub2API"
        case "qodercn": "Qoder CN"
        case "kilo", "kilocode": "Kilo"
        case "amp": "Amp"
        case "omp": "Oh My Pi"
        case "muse": "Muse Code"
        case "zcode": "ZCode"
        case "reasonix": "Reasonix"
        case "dsh": "DeepSeek Harness"
        case "cherrystudio": "Cherry Studio"
        case "lmstudio": "LM Studio"
        case "unsloth": "Unsloth"
        case "fx": "fx"
        case "mcode": "MiniMax Code"
        default:
            provider?.capitalized ?? "Provider"
        }
    }

    static func assetName(for provider: String?) -> String {
        switch normalizedID(provider) {
        case "claude": "VendorClaude"
        case "codex": "VendorCodex"
        case "cursor": "VendorCursor"
        case "antigravity": "VendorAntigravity"
        case "opencode": "VendorOpenCode"
        case "openrouter": "VendorOpenRouter"
        case "deepseek", "dsh": "VendorDeepSeek"
        case "minimax", "mcode": "VendorMiniMax"
        case "mimo", "micode", "xiaomi": "VendorXiaomi"
        case "grok", "xai": "VendorGrok"
        case "copilot": "VendorCopilot"
        case "kiro": "VendorKiro"
        case "zai", "zaiteam", "zcode": "VendorZai"
        case "volcengine": "VendorVolcengine"
        case "qoder", "qodercn": "VendorQoder"
        case "kimi": "VendorKimi"
        case "ollama": "VendorOllama"
        case "hermes": "VendorHermes"
        case "gemini": "VendorGemini"
        case "cline": "VendorCline"
        case "cohere": "VendorCohere"
        case "meta", "muse": "VendorMeta"
        case "mistral": "VendorMistral"
        case "moonshot": "VendorMoonshot"
        case "qwen", "alibaba": "VendorQwen"
        case "pi", "omp": "VendorPi"
        case "zed": "VendorZed"
        case "kilocode", "kilo": "VendorKiloCode"
        case "codebuddy": "VendorCodeBuddy"
        case "workbuddy": "VendorWorkBuddy"
        case "proma": "VendorProma"
        case "openclaw": "VendorOpenClaw"
        case "doubao": "VendorDoubao"
        default: "VendorNewAPI"
        }
    }

    /// Raw Desktop brand colors from src/shared/vendorPresentation.js.
    /// Monochrome brands use adaptive ink so meters remain visible in dark mode.
    static func color(for provider: String?) -> Color {
        switch normalizedID(provider) {
        case "claude": rgb(0xcc7c5e)
        case "codex": rgb(0x49a3b0)
        case "antigravity", "gemini": rgb(0x4285f4)
        case "openrouter": rgb(0x6566f1)
        case "deepseek", "dsh", "reasonix": rgb(0x4d6bfe)
        case "minimax", "mcode": rgb(0xf23f5d)
        case "kiro": rgb(0x9046ff)
        case "volcengine": rgb(0x006eff)
        case "qoder", "qodercn": rgb(0x2adb5c)
        case "ollama": rgb(0x888888)
        case "hermes": rgb(0xd4af37)
        case "cline": rgb(0x9d4edd)
        case "amp": rgb(0xf34e3f)
        case "openclaw": rgb(0xff4d4d)
        case "qwen", "alibaba": rgb(0x615ced)
        case "omp": rgb(0xed4abf)
        case "zed": rgb(0x4173e7)
        case "kilo", "kilocode": rgb(0xf8f676)
        case "commandcode": rgb(0x8c4edd)
        case "muse": rgb(0x0866ff)
        case "codebuddy": rgb(0x6c4dff)
        case "workbuddy": rgb(0x0dc8a5)
        case "cherrystudio": rgb(0xea5e5d)
        case "lmstudio": rgb(0x6c5ce7)
        case "unsloth": rgb(0x40b85a)
        case "meta": rgb(0x1d65c1)
        case "mistral": rgb(0xfa520f)
        case "cohere": rgb(0x39594d)
        case "doubao": rgb(0x1e37fc)
        case "hunyuan": rgb(0x0053e0)
        case "trae": rgb(0x32f08c)
        case "nvidia": rgb(0x74b71b)
        case "thirdparty": rgb(0x8090a6)
        case "opencode", "cursor", "factory", "droid", "kimi", "moonshot", "grok", "xai",
             "copilot", "pi", "mimo", "micode", "xiaomi", "zai", "zaiteam", "zcode",
             "proma", "devin", "fx", "stepfun", "typesafe": .primary
        default: rgb(0x6ab4f0)
        }
    }

    /// Use related bundled artwork where available, and meaningful SF Symbols otherwise.
    static func fallbackSymbol(for provider: String?) -> String? {
        switch normalizedID(provider) {
        case "factory", "droid": "terminal"
        case "commandcode", "amp", "fx": "chevron.left.forwardslash.chevron.right"
        case "devin": "person.crop.square"
        case "typesafe": "checkmark.shield"
        case "trae": "curlybraces"
        case "stepfun": "square.stack.3d.up"
        case "reasonix": "brain"
        case "cherrystudio": "bubble.left.and.bubble.right"
        case "lmstudio": "desktopcomputer"
        case "unsloth": "leaf"
        case "hunyuan": "sparkles"
        case "nvidia": "cpu"
        default: nil
        }
    }

    private static func normalizedID(_ provider: String?) -> String? {
        provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func rgb(_ hex: UInt32) -> Color {
        Color(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
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
