import Foundation

nonisolated enum DevicePresentation {
    static func assetName(for platform: String?) -> String? {
        switch platform?.lowercased() {
        case let value? where value.contains("darwin") || value.contains("mac"): "OSApple"
        case let value? where value.contains("win"): "OSWindows"
        case let value? where value.contains("linux"): "OSLinux"
        default: nil
        }
    }

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
