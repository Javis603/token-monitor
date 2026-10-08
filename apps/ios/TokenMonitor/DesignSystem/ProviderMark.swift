import SwiftUI

struct ProviderMark: View {
    let provider: String?
    var size: CGFloat = 18

    var body: some View {
        Image(ProviderPresentation.assetName(for: provider))
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(.primary)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
