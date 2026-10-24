import SwiftUI

/// Render shared system content at device width before fitting the Form row.
/// GeometryReader accepts the row proposal, so the intrinsic preview cannot
/// widen its own measurement and overflow the screen.
struct SystemSurfaceFittedPreview<Content: View>: View {
    let width: CGFloat
    @ViewBuilder var content: Content
    @State private var naturalHeight: CGFloat = 0
    @State private var availableWidth: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            let scale = min(1, proxy.size.width / width)
            content
                .frame(width: width)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self, of: \.size.height) { naturalHeight = $0 }
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: proxy.size.width, height: naturalHeight * scale, alignment: .topLeading)
        }
        .frame(height: naturalHeight * fittedScale)
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { availableWidth = $0 }
    }

    private var fittedScale: CGFloat {
        availableWidth > 0 ? min(1, availableWidth / width) : 1
    }
}
