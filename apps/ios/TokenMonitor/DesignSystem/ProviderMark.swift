import SwiftUI

struct ProviderMark: View {
    let provider: String?

    var body: some View {
        Image(ProviderPresentation.assetName(for: provider))
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(ProviderPresentation.color(for: provider))
            .frame(width: 30, height: 30)
            .accessibilityHidden(true)
    }
}
