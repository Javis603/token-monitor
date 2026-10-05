import SwiftUI

struct AppBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            DesignTokens.canvas(for: colorScheme)

            RadialGradient(
                colors: [
                    DesignTokens.accent.opacity(colorScheme == .dark ? 0.18 : 0.14),
                    .clear
                ],
                center: .topTrailing,
                startRadius: 10,
                endRadius: 520
            )
        }
        .ignoresSafeArea()
    }
}
