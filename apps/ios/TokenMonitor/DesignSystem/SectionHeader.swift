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
