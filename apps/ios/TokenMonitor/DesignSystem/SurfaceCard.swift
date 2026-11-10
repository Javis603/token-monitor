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

/// Dashboard cards use the window's available space, including iPad multitasking.
struct DashboardScrollView<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let content: (Int) -> Content

    init(@ViewBuilder content: @escaping (Int) -> Content) {
        self.content = content
    }

    var body: some View {
        GeometryReader { geometry in
            // Keep at least 418 pt per card, and retain one column in portrait.
            let twoColumns = UIDevice.current.userInterfaceIdiom == .pad
                && geometry.size.width >= 900
                && geometry.size.width > geometry.size.height
                && !dynamicTypeSize.isAccessibilitySize
            ScrollView {
                content(twoColumns ? 2 : 1)
            }
        }
    }
}

/// Each card follows the shortest column, so tall neighbors never create empty rows.
struct DashboardCardLayout: Layout {
    let columns: Int
    private let spacing: CGFloat

    @MainActor init(columns: Int) {
        self.columns = columns
        spacing = DesignTokens.sectionSpacing
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.replacingUnspecifiedDimensions().width
        let frames = frames(width: width, subviews: subviews)
        return CGSize(width: width, height: frames.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = frames(width: bounds.width, subviews: subviews)
        for (index, subview) in subviews.enumerated() {
            let frame = frames[index]
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        let cardWidth = max(0, (width - spacing * CGFloat(columns - 1)) / CGFloat(columns))
        var nextY = Array(repeating: CGFloat.zero, count: columns)
        return subviews.map { subview in
            var column = 0
            for candidate in 1..<columns where nextY[candidate] < nextY[column] {
                column = candidate
            }
            let height = subview.sizeThatFits(ProposedViewSize(width: cardWidth, height: nil)).height
            let frame = CGRect(x: CGFloat(column) * (cardWidth + spacing), y: nextY[column],
                               width: cardWidth, height: height)
            nextY[column] = frame.maxY + spacing
            return frame
        }
    }
}
