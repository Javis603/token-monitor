import SwiftUI

/// Title and dismissal share one row; optional detail belongs beneath it.
struct PopoverHeader: View {
    @Environment(\.dismiss) private var dismiss
    let title: LocalizedStringKey

    init(_ title: LocalizedStringKey) {
        self.title = title
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Button("Dismiss", systemImage: "xmark") { dismiss() }
                .labelStyle(.iconOnly)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: DesignTokens.controlHeight, height: DesignTokens.controlHeight)
                .contentShape(.rect)
                .buttonStyle(.plain)
                .padding(.vertical, -12)
                .padding(.trailing, -12)
        }
    }
}
