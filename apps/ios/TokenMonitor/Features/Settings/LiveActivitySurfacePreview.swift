import SwiftUI

struct LiveActivitySurfacePreview: View {
    let iconProviderID: String?
    let providerName: String
    let compactTrailingField: TokenMonitorActivityAttributes.Field
    let expandedLeadingField: TokenMonitorActivityAttributes.Field
    let expandedCenterField: TokenMonitorActivityAttributes.Field
    let expandedTrailingField: TokenMonitorActivityAttributes.Field
    let expandedBottomField: TokenMonitorActivityAttributes.Field
    let lockScreenPrimaryField: TokenMonitorActivityAttributes.Field
    let lockScreenSecondaryField: TokenMonitorActivityAttributes.Field
    let lockScreenBottomField: TokenMonitorActivityAttributes.Field
    var primaryMetric: AppPreferences.LiveMetric = .tokens
    var showsProgress = true
    var showsSecondary = true

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            surfaceHeading(
                "Compact Dynamic Island",
                systemImage: "rectangle.portrait.and.arrow.forward"
            )
            compactIsland
                .environment(\.colorScheme, .dark)

            surfaceHeading(
                "Expanded Dynamic Island",
                systemImage: "rectangle.expand.vertical"
            )
            expandedIsland
                .environment(\.colorScheme, .dark)

            surfaceHeading(
                "Live Activity",
                systemImage: "platter.filled.bottom.and.arrow.down.iphone"
            )
            lockScreenActivity
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Live Activity and Dynamic Island preview, sample data")
    }

    private var compactIsland: some View {
        HStack(spacing: 10) {
            providerIcon(size: 18)
            Spacer(minLength: 8)
            previewField(compactTrailingField, compact: true)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 46)
        .padding(.vertical, 10)
        .foregroundStyle(.white)
        .background(.black, in: .capsule)
        .overlay {
            Capsule()
                .stroke(.white.opacity(0.18), lineWidth: 1)
        }
    }

    private var expandedIsland: some View {
        VStack(spacing: 10) {
            HStack(alignment: .top) {
                previewField(expandedLeadingField)
                Spacer(minLength: 10)
                previewField(expandedTrailingField, alignment: .trailing)
            }

            previewField(expandedCenterField, alignment: .center)
                .frame(maxWidth: .infinity)

            previewField(expandedBottomField, alignment: .center)
                .frame(maxWidth: .infinity)
        }
        .padding(14)
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, minHeight: 106)
        .background(.black, in: .rect(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(.white.opacity(0.18), lineWidth: 1)
        }
    }

    private var lockScreenActivity: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                providerIcon(size: 18)
                Text("Token Monitor").font(.caption.weight(.semibold))
            }
            HStack(alignment: .top, spacing: 20) {
                previewField(lockScreenPrimaryField)
                    .frame(maxWidth: .infinity, alignment: .leading)
                previewField(lockScreenSecondaryField, alignment: .trailing)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            previewField(lockScreenBottomField)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .tertiarySystemGroupedBackground), in: .rect(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22)
                .stroke(Color(uiColor: .separator).opacity(0.2), lineWidth: 1)
        }
    }

    private func surfaceHeading(
        _ title: LocalizedStringKey,
        systemImage: String
    ) -> some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func providerIcon(size: CGFloat) -> some View {
        Image(
            ProviderPresentation.assetName(
                for: iconProviderID ?? "codex"
            )
        )
        .resizable()
        .scaledToFit()
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func previewField(
        _ field: TokenMonitorActivityAttributes.Field,
        alignment: HorizontalAlignment = .leading,
        compact: Bool = false
    ) -> some View {
        switch field {
        case .none:
            EmptyView()
        case .progress:
            if showsProgress {
                VStack(alignment: .leading, spacing: 4) {
                    if !compact {
                        HStack {
                            Text("AI limit")
                            Spacer()
                            Text("90% left").monospacedDigit()
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                    ProgressView(value: 0.9)
                        .tint(DesignTokens.accent)
                        .frame(maxWidth: compact ? 44 : .infinity)
                }
            }
        case .updated:
            if compact {
                Text("Now")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: alignment, spacing: 2) {
                    Text(LocalizedStringKey(field.title))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Just now")
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                }
            }
        case .provider:
            fieldValue("Provider", providerName, alignment: alignment, compact: compact)
        case .primary:
            switch primaryMetric {
            case .tokens: fieldValue("Tokens", "62.8M", alignment: alignment, compact: compact)
            case .cost: fieldValue("Cost", "USD 48.40", alignment: alignment, compact: compact)
            case .limit: fieldValue("AI limit", "90% left", alignment: alignment, compact: compact)
            }
        case .secondary:
            if showsSecondary {
                if primaryMetric == .limit {
                    fieldValue("Tokens", "62.8M", alignment: alignment, compact: compact)
                } else {
                    fieldValue("AI limit", "90% left", alignment: alignment, compact: compact)
                }
            }
        case .tokens:
            fieldValue("Tokens", "62.8M", alignment: alignment, compact: compact)
        case .cost:
            fieldValue("Cost", "USD 48.40", alignment: alignment, compact: compact)
        case .limit:
            fieldValue("AI limit", "90% left", alignment: alignment, compact: compact)
        }
    }

    @ViewBuilder
    private func fieldValue(
        _ label: LocalizedStringKey,
        _ value: String,
        alignment: HorizontalAlignment,
        compact: Bool
    ) -> some View {
        if compact {
            Text(value)
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(DesignTokens.accent)
                .lineLimit(1)
        } else {
            VStack(alignment: alignment, spacing: 2) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(value)
                    .font(.subheadline.monospacedDigit().weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
