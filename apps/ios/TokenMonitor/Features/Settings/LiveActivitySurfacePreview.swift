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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            surfaceHeading(
                "Compact Dynamic Island",
                systemImage: "rectangle.portrait.and.arrow.forward"
            )
            compactIsland

            surfaceHeading(
                "Expanded Dynamic Island",
                systemImage: "rectangle.expand.vertical"
            )
            expandedIsland

            surfaceHeading(
                "Live Activity",
                systemImage: "platter.filled.bottom.and.arrow.down.iphone"
            )
            lockScreenActivity
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
        .accessibilityLabel("Live Activity and Dynamic Island preview")
    }

    private var compactIsland: some View {
        HStack(spacing: 10) {
            providerIcon(size: 18)
            Spacer(minLength: 8)
            previewField(compactTrailingField, compact: true)
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
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
        .frame(maxWidth: .infinity, minHeight: 106)
        .background(.black, in: .rect(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(.white.opacity(0.18), lineWidth: 1)
        }
    }

    private var lockScreenActivity: some View {
        HStack(spacing: 10) {
            providerIcon(size: 25)

            previewField(lockScreenPrimaryField)

            Spacer(minLength: 8)

            previewField(lockScreenSecondaryField, alignment: .trailing)
        }
        .padding(14)
        .overlay(alignment: .bottom) {
            previewField(lockScreenBottomField, alignment: .center)
                .padding(.horizontal, 14)
                .padding(.bottom, 7)
        }
        .frame(maxWidth: .infinity, minHeight: 72)
        .background(.black, in: .rect(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(.white.opacity(0.18), lineWidth: 1)
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
            ProgressView(value: 0.62)
                .tint(DesignTokens.accent)
                .frame(maxWidth: compact ? 44 : .infinity)
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
            fieldValue("Tokens", "62.8M", alignment: alignment, compact: compact)
        case .secondary:
            fieldValue("AI limit", "90% left", alignment: alignment, compact: compact)
        case .tokens:
            fieldValue("Tokens", "62.8M", alignment: alignment, compact: compact)
        case .cost:
            fieldValue("Cost", "$48.40", alignment: alignment, compact: compact)
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
                    .lineLimit(1)
                Text(value)
                    .font(.subheadline.monospacedDigit().weight(.semibold))
                    .lineLimit(1)
            }
        }
    }
}
