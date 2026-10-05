import SwiftUI

/// The one section container: glass where the system supports it, opaque elsewhere.
struct SurfaceCard<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        if #available(iOS 26, *), !reduceTransparency {
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
