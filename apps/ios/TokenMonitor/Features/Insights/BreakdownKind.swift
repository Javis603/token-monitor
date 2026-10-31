import SwiftUI

enum BreakdownKind: Hashable {
    case tool
    case model

    var title: String {
        switch self {
        case .tool: "Tools"
        case .model: "Models"
        }
    }

    func displayName(for id: String) -> String {
        switch self {
        case .tool:
            ClientPresentation.displayName(for: id)
        case .model:
            id
        }
    }

    func assetName(for id: String) -> String {
        switch self {
        case .tool:
            ClientPresentation.assetName(for: id)
        case .model:
            ProviderPresentation.assetName(
                for: ProviderPresentation.modelVendor(for: id)
            )
        }
    }

    func color(for id: String) -> Color {
        switch self {
        case .tool:
            ClientPresentation.color(for: id)
        case .model:
            ProviderPresentation.color(
                for: ProviderPresentation.modelVendor(for: id)
            )
        }
    }
}
