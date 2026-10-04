import SwiftUI

struct AppBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        DesignTokens.canvas(for: colorScheme)
            .ignoresSafeArea()
    }
}
