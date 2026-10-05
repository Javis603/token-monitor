import SwiftUI

/// The Overview summary uses native glass; other enclosed surfaces remain opaque.
struct SurfaceCard<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let content: Content
    let glass: Bool

    init(glass: Bool = false, @ViewBuilder content: () -> Content) {
        self.content = content()
        self.glass = glass
    }

    var body: some View {
        if #available(iOS 26, *), glass, !reduceTransparency {
            paddedContent
                .glassEffect(.regular, in: .rect(cornerRadius: DesignTokens.cardRadius))
        } else {
            paddedContent
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: .rect(cornerRadius: DesignTokens.cardRadius)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: DesignTokens.cardRadius)
                        .strokeBorder(DesignTokens.border(for: colorScheme), lineWidth: 0.5)
                }
        }
    }

    private var paddedContent: some View {
        content
            .padding(DesignTokens.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct AppActionStyle: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            content.buttonStyle(.glassProminent)
        } else {
            content.buttonStyle(.borderedProminent)
        }
    }
}
