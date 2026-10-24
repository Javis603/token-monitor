import Foundation

nonisolated struct HubConfiguration: Codable, Equatable, Sendable {
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
            var components = URLComponents(string: candidate),
            let scheme = components.scheme?.lowercased(),
            ["http", "https"].contains(scheme),
            components.host?.isEmpty == false,
            components.user == nil, components.password == nil,
            components.query == nil, components.fragment == nil,
            components.port.map({ (1...65535).contains($0) }) ?? true,
            !secret.contains(where: { $0.isNewline || $0.asciiValue.map({ $0 < 32 || $0 == 127 }) == true }),
            components.url != nil
        else {
            return nil
        }
        components.scheme = scheme
        components.host = components.host?.lowercased()
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { return nil }
        return HubConfiguration(
            baseURL: url,
            secret: secret.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}
