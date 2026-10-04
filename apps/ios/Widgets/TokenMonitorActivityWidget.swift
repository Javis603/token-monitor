import ActivityKit
import SwiftUI
import WidgetKit

struct TokenMonitorActivityWidget: Widget {
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TokenMonitorActivityAttributes.self) { context in
            lockScreen(context)
                // Leave the Lock Screen material and contrast treatment to ActivityKit.
                .activitySystemActionForegroundColor(.primary)
                .widgetURL(URL(string: "tokenmonitor://overview"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    field(context.state.expandedLeadingField, fallback: .provider, context: context)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    field(context.state.expandedTrailingField, fallback: .primary, context: context, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.center) {
                    field(context.state.expandedCenterField, fallback: .primary, context: context, alignment: .center)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        field(context.state.expandedBottomField, fallback: .progress, context: context)
                        if isStale(context) { staleLabel }
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                mark(context, size: 18)
            } compactTrailing: {
                field(context.state.compactTrailingField, fallback: .primary, context: context, compact: true)
                    .frame(maxWidth: 64)
            } minimal: {
                mark(context, size: 20)
            }
            .widgetURL(URL(string: "tokenmonitor://overview"))
            .keylineTint(isStale(context) ? .secondary : WidgetPresentation.accent)
        }
    }

    private func lockScreen(_ context: ActivityViewContext<TokenMonitorActivityAttributes>) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                mark(context, size: 18)
                Text(context.attributes.title).font(.caption.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 0)
                if isStale(context) { staleLabel }
            }
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 20))
            layout {
                field(context.state.lockScreenPrimaryField, fallback: .primary, context: context)
                    .frame(maxWidth: .infinity, alignment: .leading)
                field(context.state.lockScreenSecondaryField, fallback: .secondary, context: context,
                      alignment: typeSize.isAccessibilitySize ? .leading : .trailing)
                    .frame(maxWidth: .infinity, alignment: typeSize.isAccessibilitySize ? .leading : .trailing)
            }
            // A real layout row reserves space; it cannot overlap the metrics.
            field(context.state.lockScreenBottomField, fallback: .progress, context: context)
        }
        .padding(16)
    }

    private func isStale(_ context: ActivityViewContext<TokenMonitorActivityAttributes>) -> Bool {
        context.isStale || context.state.sourceStale == true
    }

    private var staleLabel: some View {
        Label("Data may be out of date", systemImage: "clock.badge.exclamationmark")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func mark(_ context: ActivityViewContext<TokenMonitorActivityAttributes>, size: CGFloat) -> some View {
        if isStale(context) {
            Image(systemName: "clock.badge.exclamationmark")
                .font(.system(size: size))
                .accessibilityLabel("Data may be out of date")
        } else if let provider = context.state.iconProviderID ?? context.state.providerID {
            Image(WidgetPresentation.assetName(for: provider))
                .resizable().scaledToFit().frame(width: size, height: size)
                .accessibilityLabel(context.state.providerName ?? "Token Monitor")
        } else {
            Image(systemName: "chart.bar.fill")
                .font(.system(size: size))
                .foregroundStyle(WidgetPresentation.accent)
                .accessibilityLabel("Token Monitor")
        }
    }

    @ViewBuilder private func field(
        _ raw: String?,
        fallback: TokenMonitorActivityAttributes.Field,
        context: ActivityViewContext<TokenMonitorActivityAttributes>,
        alignment: HorizontalAlignment = .leading,
        compact: Bool = false
    ) -> some View {
        let selected = raw.flatMap(TokenMonitorActivityAttributes.Field.init(rawValue:)) ?? fallback
        let state = context.state
        switch selected {
        case .none:
            EmptyView()
        case .progress:
            if let progress = WidgetPresentation.fraction(state.progress) {
                if compact {
                    Gauge(value: progress) { Text("AI limit") }
                        .gaugeStyle(.accessoryCircularCapacity)
                        .frame(width: 22, height: 22)
                        .scaleEffect(0.6)
                        .accessibilityValue(WidgetPresentation.percent(progress * 100))
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("AI limit")
                            Spacer(minLength: 4)
                            if let limit = state.limitValue { Text(limit).monospacedDigit() }
                        }
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        ProgressView(value: progress)
                            .tint(isStale(context) ? .secondary : WidgetPresentation.accent)
                            .accessibilityLabel("AI limit")
                    }
                    .accessibilityElement(children: .combine)
                }
            } else {
                Text("—").accessibilityLabel("No limit data")
                    .foregroundStyle(.secondary)
            }
        case .updated:
            VStack(alignment: alignment, spacing: 3) {
                if !compact {
                    Text("Updated").font(.caption).foregroundStyle(.secondary)
                }
                Text(state.updatedAt, style: .relative)
                    .font(compact ? .caption.monospacedDigit() : .subheadline.monospacedDigit())
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
        default:
            let metric = value(selected, state: state)
            if compact {
                Text(metric.value)
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .lineLimit(1).minimumScaleFactor(0.85)
                    .accessibilityLabel(LocalizedStringKey(metric.label))
                    .accessibilityValue(metric.value)
            } else {
                VStack(alignment: alignment, spacing: 3) {
                    Text(LocalizedStringKey(metric.label))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(metric.value)
                        .font(.system(.title3, design: .rounded, weight: .semibold))
                        .monospacedDigit()
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                        .minimumScaleFactor(0.8)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func value(_ field: TokenMonitorActivityAttributes.Field, state: TokenMonitorActivityAttributes.ContentState) -> (label: String, value: String) {
        switch field {
        case .primary: (state.primaryLabel, state.primaryValue.isEmpty ? "—" : state.primaryValue)
        case .secondary: (state.secondaryLabel ?? "Secondary metric", state.secondaryValue ?? "—")
        case .provider: ("Provider", state.providerName ?? "—")
        case .tokens: ("Tokens", state.tokensValue ?? "—")
        case .cost: ("Cost", state.costValue ?? "—")
        case .limit: ("AI limit", state.limitValue ?? "—")
        case .progress, .updated, .none: ("", "—")
        }
    }
}
