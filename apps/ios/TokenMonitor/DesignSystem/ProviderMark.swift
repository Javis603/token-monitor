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

/// Picker menus use the SVG asset's 1em intrinsic size and ignore view sizing.
/// Render a 20-point original image in the menu's semantic text color so iOS
/// doesn't apply the action tint to every provider and automatic option.
@MainActor
enum ProviderMenuArtwork {
    static func image(for providerID: String, colorScheme: ColorScheme) -> UIImage {
        render(UIImage(named: ProviderPresentation.assetName(for: providerID)), colorScheme: colorScheme)
    }

    static func symbol(_ name: String, colorScheme: ColorScheme) -> UIImage {
        render(UIImage(systemName: name), colorScheme: colorScheme)
    }

    private static func render(_ image: UIImage?, colorScheme: ColorScheme) -> UIImage {
        let size = CGSize(width: 20, height: 20)
        let style: UIUserInterfaceStyle = colorScheme == .dark ? .dark : .light
        let color = UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        return UIGraphicsImageRenderer(size: size).image { _ in
            image?.withTintColor(color, renderingMode: .alwaysOriginal)
                .draw(in: CGRect(origin: .zero, size: size))
        }.withRenderingMode(.alwaysOriginal)
    }
}
