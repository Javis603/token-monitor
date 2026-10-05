import SwiftUI

struct WidgetSurfacePreview: View {
    let content: AppPreferences.WidgetContent
    let period: UsagePeriodKey
    let providerName: String
    let showsCost: Bool
    let showsUpdateTime: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: content.systemImage)
                    .foregroundStyle(DesignTokens.accent)
                Text(LocalizedStringKey(content.title))
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                Text(LocalizedStringKey(period.title))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            switch content {
            case .overview:
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text("62.8M")
                        .font(.title2.weight(.bold))
                        .monospacedDigit()
                    Text("tokens")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            case .limits:
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(providerName)
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("91% left")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(DesignTokens.accent)
                    }
                    ProgressView(value: 0.91)
                        .tint(DesignTokens.accent)
                }
            case .activity:
                LazyVGrid(
                    columns: Array(
                        repeating: GridItem(.flexible(), spacing: 3),
                        count: 14
                    ),
                    spacing: 3
                ) {
                    ForEach(0..<42, id: \.self) { index in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(
                                DesignTokens.accent.opacity(
                                    0.12 + Double(index % 5) * 0.16
                                )
                            )
                            .frame(height: 7)
                    }
                }
            }

            HStack {
                if showsCost {
                    Label("$48.40", systemImage: "dollarsign.circle")
                }
                Spacer(minLength: 0)
                if showsUpdateTime {
                    Text("Just now")
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .foregroundStyle(.white)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.black, in: .rect(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(.white.opacity(0.12), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Widget preview")
    }
}
