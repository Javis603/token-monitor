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
        case "overview":
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
}
