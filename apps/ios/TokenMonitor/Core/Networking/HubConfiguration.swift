import Foundation

nonisolated struct HubConfiguration: Equatable, Sendable {
    let baseURL: URL
    let secret: String

    static func make(urlText: String, secret: String) -> HubConfiguration? {
        var candidate = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else {
            return nil
        }
        if !candidate.contains("://") {
            candidate = "http://\(candidate)"
        }
        guard
            let components = URLComponents(string: candidate),
            let scheme = components.scheme?.lowercased(),
            ["http", "https"].contains(scheme),
            components.host?.isEmpty == false,
            let url = components.url
        else {
            return nil
        }
        return HubConfiguration(
            baseURL: url,
            secret: secret.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}
