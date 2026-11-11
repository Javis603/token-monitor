import Foundation

enum AppTab: Hashable {
    case overview
    case limits
    case insights
    case sessions
    case settings

    init?(url: URL) {
        guard url.scheme?.lowercased() == "tokenmonitor" else {
            return nil
        }

        switch url.host?.lowercased() {
        case "overview":
            self = url.path.lowercased() == "/sessions" ? .sessions : .overview
        case "sessions":
            self = .sessions
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
        AppTab(url: url) == .sessions
    }
}
