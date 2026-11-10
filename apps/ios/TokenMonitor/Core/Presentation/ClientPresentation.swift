import SwiftUI

nonisolated enum ClientPresentation {
    static func displayName(for client: String) -> String {
        switch client.lowercased() {
        case "claude": "Claude Code"
        case "codex": "Codex"
        case "hermes": "Hermes"
        case "cursor": "Cursor"
        case "antigravity": "Antigravity"
        case "opencode": "OpenCode"
        case "copilot": "GitHub Copilot"
        case "micode": "MiMo Code"
        case "muse": "Muse Code"
        case "mistral": "Mistral Vibe"
        case "gemini": "Gemini CLI"
        case "grok": "Grok Build"
        default: ProviderPresentation.displayName(for: client)
        }
    }

    static func assetName(for client: String) -> String {
        client.lowercased() == "gemini" ? "VendorGeminiCLI" : ProviderPresentation.assetName(for: client)
    }

    static func color(for client: String) -> Color {
        client.lowercased() == "gemini" ? .primary : ProviderPresentation.color(for: client)
    }
}
