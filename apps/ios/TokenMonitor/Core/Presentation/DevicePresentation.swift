import Foundation

nonisolated enum DevicePresentation {
    static func symbol(for platform: String?) -> String {
        switch platform?.lowercased() {
        case let value? where value.contains("darwin") || value.contains("mac"):
            "laptopcomputer"
        case let value? where value.contains("win"):
            "desktopcomputer"
        case let value? where value.contains("linux"):
            "server.rack"
        default:
            "display"
        }
    }
}
