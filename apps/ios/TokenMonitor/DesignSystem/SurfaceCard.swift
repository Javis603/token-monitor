import SwiftUI

struct SurfaceCard<Content: View>: View {
    @ViewBuilder let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    @ViewBuilder
    var body: some View {
        if #available(iOS 26, *) {
            content
                .padding(DesignTokens.cardPadding)
                .glassEffect(
                    .regular,
                    in: .rect(cornerRadius: DesignTokens.cardRadius)
                )
        } else {
            content
                .padding(DesignTokens.cardPadding)
                .background(
                    .regularMaterial,
                    in: .rect(cornerRadius: DesignTokens.cardRadius)
                )
        }
    }
}
