import ActivityKit
import SwiftUI
import WidgetKit

struct TokenMonitorActivityWidget: Widget {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TokenMonitorActivityAttributes.self) { context in
            lockScreen(context)
                // A clear tint exposes the iOS 26 host glass. Accessibility uses the host default.
                .activityBackgroundTint(reduceTransparency ? nil : .clear)
                .widgetURL(URL(string: "tokenmonitor://overview"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    field(context.state.expandedLeadingField, fallback: .provider, context: context, includesProviderMark: true)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    field(context.state.expandedTrailingField, fallback: .secondary, context: context, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.center) {
                    field(context.state.expandedCenterField, fallback: .primary, context: context, alignment: .center)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if selectedField(context.state.expandedBottomField, fallback: .progress) != .none || isStale(context) {
                        VStack(alignment: .leading, spacing: 6) {
                            field(context.state.expandedBottomField, fallback: .progress, context: context)
                            if isStale(context) { staleLabel }
                        }
                        .padding(.vertical, 2)
                    }
                }
            } compactLeading: {
                mark(context, size: 18)
            } compactTrailing: {
                field(context.state.compactTrailingField, fallback: .primary, context: context, compact: true)
                    .frame(maxWidth: 72)
            } minimal: {
                mark(context, size: 20)
            }
            .widgetURL(URL(string: "tokenmonitor://overview"))
        }
    }

    private func lockScreen(_ context: ActivityViewContext<TokenMonitorActivityAttributes>) -> some View {
        let primary = selectedField(context.state.lockScreenPrimaryField, fallback: .primary)
        let secondary = selectedField(context.state.lockScreenSecondaryField, fallback: .secondary)
        let bottom = selectedField(context.state.lockScreenBottomField, fallback: .progress)
        return VStack(alignment: .leading, spacing: 8) {
            let headerLayout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 8))
            headerLayout {
                HStack(spacing: 6) {
                    mark(context, size: 16, indicatesStaleness: false)
                    if ![primary, secondary, bottom].contains(.provider),
                       let name = nonEmpty(context.state.providerName) {
                        Text(name).font(.caption.weight(.semibold))
                            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    }
                }
                if !typeSize.isAccessibilitySize { Spacer(minLength: 4) }
                if isStale(context) {
                    staleLabel
                } else if ![primary, secondary, bottom].contains(.updated) {
                    HStack(spacing: 4) {
                        Text("Updated")
                        Text(context.state.updatedAt, style: .relative).monospacedDigit()
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityElement(children: .combine)
                }
            }
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 20))
            if primary != .none || secondary != .none {
                layout {
                    if primary != .none {
                        field(primary.rawValue, fallback: .primary, context: context, prominent: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if secondary != .none {
                        field(secondary.rawValue, fallback: .secondary, context: context,
                              alignment: typeSize.isAccessibilitySize ? .leading : .trailing, prominent: true)
                            .frame(maxWidth: .infinity, alignment: typeSize.isAccessibilitySize ? .leading : .trailing)
                    }
                }
            }
            if bottom != .none {
                field(bottom.rawValue, fallback: .progress, context: context)
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func isStale(_ context: ActivityViewContext<TokenMonitorActivityAttributes>) -> Bool {
        context.isStale || context.state.sourceStale == true
    }

    private var staleLabel: some View {
        Label("Data may be out of date", systemImage: "clock.badge.exclamationmark")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func mark(
        _ context: ActivityViewContext<TokenMonitorActivityAttributes>,
        size: CGFloat,
        indicatesStaleness: Bool = true
    ) -> some View {
        if indicatesStaleness && isStale(context) {
            Image(systemName: "clock.badge.exclamationmark")
                .font(.system(size: size))
                .foregroundStyle(.secondary)
                .accessibilityLabel("Data may be out of date")
        } else if let provider = context.state.iconProviderID ?? context.state.providerID {
            Image(WidgetPresentation.assetName(for: provider))
                .renderingMode(.template)
                .resizable().scaledToFit().frame(width: size, height: size)
                .foregroundStyle(.primary)
                .accessibilityLabel(context.state.providerName ?? "Provider")
        } else {
            Image(systemName: "chart.bar.fill")
                .font(.system(size: size))
                .foregroundStyle(.primary)
                .accessibilityLabel("Tokens")
        }
    }

    @ViewBuilder private func field(
        _ raw: String?,
        fallback: TokenMonitorActivityAttributes.Field,
        context: ActivityViewContext<TokenMonitorActivityAttributes>,
        alignment: HorizontalAlignment = .leading,
        compact: Bool = false,
        prominent: Bool = false,
        includesProviderMark: Bool = false
    ) -> some View {
        let selected = selectedField(raw, fallback: fallback)
        let state = context.state
        switch selected {
        case .none:
            EmptyView()
        case .progress:
            if let progress = WidgetPresentation.fraction(state.progress) {
                if compact {
                    ProgressView(value: progress)
                        .tint(isStale(context) ? .secondary : progressColor(for: state.providerID))
                        .frame(width: 32)
                        .accessibilityLabel("AI limit")
                        .accessibilityValue(WidgetPresentation.percent(progress * 100))
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        let layout = typeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                            : AnyLayout(HStackLayout(spacing: 4))
                        layout {
                            Text("AI limit")
                            if !typeSize.isAccessibilitySize { Spacer(minLength: 4) }
                            Text(nonEmpty(state.limitValue) ?? "—").monospacedDigit()
                        }
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                        ProgressView(value: progress)
                            .tint(isStale(context) ? .secondary : progressColor(for: state.providerID))
                            .progressViewStyle(.linear)
                            .accessibilityLabel("AI limit")
                    }
                    .accessibilityElement(children: .combine)
                }
            } else {
                Text("—").accessibilityLabel("No limit data")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .updated:
            VStack(alignment: alignment, spacing: 3) {
                if !compact {
                    Text("Updated").font(.caption2).foregroundStyle(.secondary)
                }
                Group {
                    if state.updatedAt <= .distantPast {
                        Text("—")
                    } else {
                        Text(state.updatedAt, style: .relative)
                    }
                }
                .font(compact ? .caption.monospacedDigit() : .subheadline.monospacedDigit().weight(.semibold))
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            }
            .accessibilityElement(children: .combine)
        case .provider where includesProviderMark:
            HStack(spacing: 6) {
                mark(context, size: 16, indicatesStaleness: false)
                    .accessibilityHidden(true)
                Text(nonEmpty(state.providerName) ?? "—")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
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
                        .font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(metric.value)
                        .font(selected == .provider
                              ? .subheadline.weight(.semibold)
                              : .system(prominent ? .title2 : .title3, design: .rounded, weight: .semibold))
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
        case .primary: (state.primaryLabel, nonEmpty(state.primaryValue) ?? "—")
        case .secondary: (state.secondaryLabel ?? "Secondary metric", nonEmpty(state.secondaryValue) ?? "—")
        case .provider: ("Provider", nonEmpty(state.providerName) ?? "—")
        case .tokens: ("Tokens", nonEmpty(state.tokensValue) ?? "—")
        case .cost: ("Cost", nonEmpty(state.costValue) ?? "—")
        case .limit: ("AI limit", nonEmpty(state.limitValue) ?? "—")
        case .progress, .updated, .none: ("", "—")
        }
    }

    private func selectedField(_ raw: String?, fallback: TokenMonitorActivityAttributes.Field) -> TokenMonitorActivityAttributes.Field {
        raw.flatMap(TokenMonitorActivityAttributes.Field.init(rawValue:)) ?? fallback
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    // Widget extensions cannot import the app's ProviderPresentation. Only the quota bar is tinted.
    private func progressColor(for provider: String?) -> Color {
        switch provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "claude": rgb(0xcc7c5e)
        case "codex": rgb(0x49a3b0)
        case "antigravity", "gemini": rgb(0x4285f4)
        case "openrouter": rgb(0x6566f1)
        case "deepseek", "dsh", "reasonix": rgb(0x4d6bfe)
        case "minimax", "mcode": rgb(0xf23f5d)
        case "kiro": rgb(0x9046ff)
        case "volcengine": rgb(0x006eff)
        case "qoder", "qodercn": rgb(0x2adb5c)
        case "ollama": rgb(0x888888)
        case "hermes": rgb(0xd4af37)
        case "cline": rgb(0x9d4edd)
        case "amp": rgb(0xf34e3f)
        case "openclaw": rgb(0xff4d4d)
        case "qwen", "alibaba": rgb(0x615ced)
        case "omp": rgb(0xed4abf)
        case "zed": rgb(0x4173e7)
        case "kilo", "kilocode": rgb(0xf8f676)
        case "commandcode": rgb(0x8c4edd)
        case "muse": rgb(0x0866ff)
        case "codebuddy": rgb(0x6c4dff)
        case "workbuddy": rgb(0x0dc8a5)
        case "cherrystudio": rgb(0xea5e5d)
        case "lmstudio": rgb(0x6c5ce7)
        case "unsloth": rgb(0x40b85a)
        case "meta": rgb(0x1d65c1)
        case "mistral": rgb(0xfa520f)
        case "cohere": rgb(0x39594d)
        case "doubao": rgb(0x1e37fc)
        case "hunyuan": rgb(0x0053e0)
        case "trae": rgb(0x32f08c)
        case "nvidia": rgb(0x74b71b)
        case "thirdparty": rgb(0x8090a6)
        case "opencode", "cursor", "factory", "droid", "kimi", "moonshot", "grok", "xai",
             "copilot", "pi", "mimo", "micode", "xiaomi", "zai", "zaiteam", "zcode",
             "proma", "devin", "fx", "stepfun", "typesafe": .primary
        default: rgb(0x6ab4f0)
        }
    }

    private func rgb(_ hex: UInt32) -> Color {
        Color(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}
