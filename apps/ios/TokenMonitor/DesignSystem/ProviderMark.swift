import SwiftUI

struct ProviderMark: View {
    let provider: String?

    var body: some View {
        Group {
            if let symbol = ProviderPresentation.fallbackSymbol(for: provider) {
                Image(systemName: symbol)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(ProviderPresentation.assetName(for: provider))
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
            }
        }
        .foregroundStyle(.primary)
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}
