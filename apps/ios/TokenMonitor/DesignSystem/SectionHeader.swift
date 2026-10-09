import SwiftUI

/// A section title above a SurfaceCard, with an optional trailing accessory.
struct SectionHeader<Accessory: View>: View {
    let title: String
    let accessory: Accessory

    init(_ title: String, @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.accessory = accessory()
    }

    init(_ title: String) where Accessory == EmptyView {
        self.init(title) { EmptyView() }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(LocalizedStringKey(title))
                .font(DesignTokens.sectionTitle)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            accessory
        }
        .padding(.horizontal, 4)
    }
}

/// A shared compact title inside the system navigation bar for the four root tabs.
struct RootPageHeader<Controls: View>: ViewModifier {
    let title: LocalizedStringKey
    let brandMark: String?
    let controls: Controls
    @State private var contentWidth: CGFloat = 0

    init(_ title: LocalizedStringKey, brandMark: String? = nil, @ViewBuilder controls: () -> Controls) {
        self.title = title
        self.brandMark = brandMark
        self.controls = controls()
    }

    init(_ title: LocalizedStringKey) where Controls == EmptyView {
        self.init(title) { EmptyView() }
    }

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.width
            } action: { width in
                contentWidth = width
            }
            .navigationTitle(Text(title))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarVisibility(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 12) {
                        Group {
                            if let brandMark {
                                Text(verbatim: brandMark)
                                    .font(.system(.title2, design: .monospaced).weight(.bold))
                                    .accessibilityLabel(Text(verbatim: "Token Monitor"))
                            } else {
                                Text(title)
                                    .font(.title2.weight(.semibold))
                            }
                        }
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .layoutPriority(1)
                            .accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 8)
                        controls
                    }
                    .frame(width: contentWidth > 0
                        ? max(0, contentWidth - 2 * DesignTokens.screenPadding)
                        : nil)
                }
            }
    }
}
