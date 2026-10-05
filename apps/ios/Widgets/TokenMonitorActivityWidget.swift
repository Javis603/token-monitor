import ActivityKit
import SwiftUI
import WidgetKit

struct TokenMonitorActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(
            for: TokenMonitorActivityAttributes.self
        ) { context in
            lockScreenView(context: context)
                .activityBackgroundTint(.clear)
                .activitySystemActionForegroundColor(.primary)
                .widgetURL(URL(string: "tokenmonitor://overview"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    fieldView(
                        rawField: context.state.expandedLeadingField,
                        fallback: .provider,
                        state: context.state
                    )
                }

                DynamicIslandExpandedRegion(.trailing) {
                    fieldView(
                        rawField: context.state.expandedTrailingField,
                        fallback: .primary,
                        state: context.state,
                        alignment: .trailing
                    )
                }

                DynamicIslandExpandedRegion(.center) {
                    fieldView(
                        rawField: context.state.expandedCenterField,
                        fallback: .primary,
                        state: context.state,
                        alignment: .center
                    )
                }

                DynamicIslandExpandedRegion(.bottom) {
                    fieldView(
                        rawField: context.state.expandedBottomField,
                        fallback: .progress,
                        state: context.state,
                        alignment: .center
                    )
                }
            } compactLeading: {
                activityMark(for: context.state, size: 17)
            } compactTrailing: {
                fieldView(
                    rawField: context.state.compactTrailingField,
                    fallback: .primary,
                    state: context.state,
                    compact: true
                )
            } minimal: {
                activityMark(for: context.state, size: 20)
                    .padding(5)
            }
            .widgetURL(URL(string: "tokenmonitor://overview"))
            .keylineTint(WidgetPresentation.accent)
        }
    }

    private func lockScreenView(
        context: ActivityViewContext<TokenMonitorActivityAttributes>
    ) -> some View {
        HStack(spacing: 14) {
            activityMark(for: context.state, size: 26)

            fieldView(
                rawField: context.state.lockScreenPrimaryField,
                fallback: .primary,
                state: context.state
            )

            Spacer(minLength: 8)

            fieldView(
                rawField: context.state.lockScreenSecondaryField,
                fallback: .secondary,
                state: context.state,
                alignment: .trailing
            )
        }
        .padding(16)
        .overlay(alignment: .bottom) {
            fieldView(
                rawField: context.state.lockScreenBottomField,
                fallback: .progress,
                state: context.state,
                alignment: .center
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
    }

    private func activityMark(
        for state: TokenMonitorActivityAttributes.ContentState,
        size: CGFloat
    ) -> some View {
        Image(
            WidgetPresentation.assetName(
                for: state.iconProviderID ?? state.providerID
            )
        )
        .resizable()
        .scaledToFit()
        .foregroundStyle(WidgetPresentation.accent)
        .frame(width: size, height: size)
        .accessibilityLabel(state.providerName ?? "AI provider")
    }

    @ViewBuilder
    private func fieldView(
        rawField: String?,
        fallback: TokenMonitorActivityAttributes.Field,
        state: TokenMonitorActivityAttributes.ContentState,
        alignment: HorizontalAlignment = .leading,
        compact: Bool = false
    ) -> some View {
        let field = resolvedField(rawField, fallback: fallback)

        switch field {
        case .none:
            EmptyView()
        case .progress:
            if let progress = state.progress {
                ProgressView(value: progress)
                    .tint(WidgetPresentation.accent)
                    .frame(maxWidth: compact ? 46 : .infinity)
            }
        case .updated:
            if compact {
                Text(state.updatedAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                VStack(alignment: alignment, spacing: 2) {
                    Text("Updated")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(state.updatedAt, style: .relative)
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                }
            }
        default:
            if let value = value(for: field, state: state) {
                if compact {
                    Text(value.value)
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .foregroundStyle(WidgetPresentation.accent)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                } else {
                    VStack(alignment: alignment, spacing: 2) {
                        Text(value.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Text(value.value)
                            .font(.subheadline.monospacedDigit().weight(.semibold))
                            .minimumScaleFactor(0.7)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    private func resolvedField(
        _ rawField: String?,
        fallback: TokenMonitorActivityAttributes.Field
    ) -> TokenMonitorActivityAttributes.Field {
        guard let rawField,
              let field = TokenMonitorActivityAttributes.Field(rawValue: rawField)
        else {
            return fallback
        }
        return field
    }

    private func value(
        for field: TokenMonitorActivityAttributes.Field,
        state: TokenMonitorActivityAttributes.ContentState
    ) -> (label: String, value: String)? {
        switch field {
        case .primary:
            return (state.primaryLabel, state.primaryValue)
        case .secondary:
            guard let label = state.secondaryLabel,
                  let value = state.secondaryValue else { return nil }
            return (label, value)
        case .provider:
            guard let providerName = state.providerName else { return nil }
            return ("Provider", providerName)
        case .tokens:
            guard let tokensValue = state.tokensValue else { return nil }
            return ("Tokens", tokensValue)
        case .cost:
            guard let costValue = state.costValue else { return nil }
            return ("Cost", costValue)
        case .limit:
            guard let limitValue = state.limitValue else { return nil }
            return ("AI limit", limitValue)
        case .progress, .updated, .none:
            return nil
        }
    }
}
