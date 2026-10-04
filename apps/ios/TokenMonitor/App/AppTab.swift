import Foundation

enum AppTab: Hashable {
    case overview
    case limits
    case insights
    case settings

    init?(url: URL) {
        guard url.scheme?.lowercased() == "tokenmonitor" else {
            return nil
        }

        switch url.host?.lowercased() {
        case "overview", "sessions":
            self = .overview
        case "limits":
            self = .limits
        case "insights":
            self = .insights
        case "settings":
            self = .settings
        default:
            return nil
        }
    }

    static func opensSessions(_ url: URL) -> Bool {
        guard AppTab(url: url) == .overview else { return false }
        return url.host?.lowercased() == "sessions"
            || url.path.lowercased() == "/sessions"
    }
}
