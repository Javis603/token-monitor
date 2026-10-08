import SwiftUI

struct SectionNavigationLink<Destination: View>: View {
    let title: String
    @ViewBuilder let destination: () -> Destination

    var body: some View {
        NavigationLink(destination: destination) {
            Label("All", systemImage: "chevron.right").labelStyle(ReversedTitleIcon())
                .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                .frame(minHeight: DesignTokens.controlHeight)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(LocalizedStringKey(title)))
    }
}
