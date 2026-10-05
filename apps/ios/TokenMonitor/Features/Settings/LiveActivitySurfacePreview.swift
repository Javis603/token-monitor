import SwiftUI

struct LiveActivitySurfacePreview: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

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
    var quotaProviderID: String? = nil
    // These are explicitly sample values, never a fallback for real Activity data.
    var sampleTokens: String? = "62.8M"
    var sampleCost: String? = "USD 48.40"
    var sampleLimit: String? = "90% left"
    var sampleProgress: Double? = 0.9
    var sourceStale = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            surfaceHeading("Compact Dynamic Island", systemImage: "rectangle.portrait.and.arrow.forward")
            compactIsland
                .environment(\.colorScheme, .dark)

            surfaceHeading("Expanded Dynamic Island", systemImage: "rectangle.expand.vertical")
            expandedIsland
                .environment(\.colorScheme, .dark)

            surfaceHeading("Live Activity", systemImage: "platter.filled.bottom.and.arrow.down.iphone")
            lockScreenActivity
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Live Activity and Dynamic Island preview, sample data")
    }

    private var compactIsland: some View {
        HStack(spacing: 10) {
            if sourceStale {
                Image(systemName: "clock.badge.exclamationmark")
                    .font(.system(size: 18))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Data may be out of date")
            } else {
                providerIcon(size: 18)
            }
            Spacer(minLength: 8)
            previewField(compactTrailingField, compact: true)
                .frame(maxWidth: 72)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 46)
        .foregroundStyle(.primary)
        .background(.black, in: .capsule)
    }

    private var expandedIsland: some View {
        VStack(spacing: 6) {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 10))
            layout {
                if expandedLeadingField != .none {
                    previewField(expandedLeadingField, includesProviderMark: true)
                }
                if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                if expandedTrailingField != .none {
                    previewField(expandedTrailingField, alignment: typeSize.isAccessibilitySize ? .leading : .trailing)
                }
            }
            if expandedCenterField != .none {
                previewField(expandedCenterField, alignment: .center)
                    .frame(maxWidth: .infinity)
            }
            if expandedBottomField != .none || sourceStale {
                VStack(alignment: .leading, spacing: 6) {
                    previewField(expandedBottomField)
                    if sourceStale { staleLabel }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
            }
        }
        .padding(14)
        .foregroundStyle(.primary)
        .frame(maxWidth: .infinity)
        .background(.black, in: .rect(cornerRadius: 26))
    }

    private var lockScreenContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            let headerLayout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 8))
            headerLayout {
                HStack(spacing: 6) {
                    providerIcon(size: 16)
                    if !lockScreenFields.contains(.provider), !providerName.isEmpty {
                        Text(providerName).font(.caption.weight(.semibold))
                            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    }
                }
                if !typeSize.isAccessibilitySize { Spacer(minLength: 4) }
                if sourceStale {
                    staleLabel
                } else if !lockScreenFields.contains(.updated) {
                    HStack(spacing: 4) {
                        Text("Updated")
                        Text("Just now")
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                }
            }
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 20))
            if lockScreenPrimaryField != .none || lockScreenSecondaryField != .none {
                layout {
                    if lockScreenPrimaryField != .none {
                        previewField(lockScreenPrimaryField, prominent: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if lockScreenSecondaryField != .none {
                        previewField(lockScreenSecondaryField,
                                     alignment: typeSize.isAccessibilitySize ? .leading : .trailing,
                                     prominent: true)
                            .frame(maxWidth: .infinity, alignment: typeSize.isAccessibilitySize ? .leading : .trailing)
                    }
                }
            }
            if lockScreenBottomField != .none {
                previewField(lockScreenBottomField)
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var lockScreenActivity: some View {
        if reduceTransparency {
            lockScreenContent
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 26))
        } else {
            // App-only simulation. ActivityKit supplies this material in the actual widget.
            lockScreenContent
                .glassEffect(.regular, in: .rect(cornerRadius: 26))
        }
    }

    private var staleLabel: some View {
        Label("Data may be out of date", systemImage: "clock.badge.exclamationmark")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var lockScreenFields: [TokenMonitorActivityAttributes.Field] {
        [lockScreenPrimaryField, lockScreenSecondaryField, lockScreenBottomField]
    }

    private var configuredFields: [TokenMonitorActivityAttributes.Field] {
        [compactTrailingField, expandedLeadingField, expandedCenterField,
         expandedTrailingField, expandedBottomField] + lockScreenFields
    }

    private var progress: Double? {
        guard showsProgress || configuredFields.contains(.progress),
              let sampleProgress, sampleProgress.isFinite else { return nil }
        return min(1, max(0, sampleProgress))
    }

    private var progressColor: Color {
        sourceStale ? .secondary : ProviderPresentation.color(for: quotaProviderID ?? iconProviderID)
    }

    private func surfaceHeading(_ title: LocalizedStringKey, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    @ViewBuilder private func providerIcon(size: CGFloat) -> some View {
        if let iconProviderID {
            Image(ProviderPresentation.assetName(for: iconProviderID))
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(.primary)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "chart.bar.fill")
                .font(.system(size: size))
                .foregroundStyle(.primary)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder private func previewField(
        _ field: TokenMonitorActivityAttributes.Field,
        alignment: HorizontalAlignment = .leading,
        compact: Bool = false,
        prominent: Bool = false,
        includesProviderMark: Bool = false
    ) -> some View {
        switch field {
        case .none:
            EmptyView()
        case .progress:
            if let progress {
                if compact {
                    ProgressView(value: progress)
                        .tint(progressColor)
                        .frame(width: 32)
                        .accessibilityLabel("AI limit")
                        .accessibilityValue(progress.formatted(.percent.precision(.fractionLength(0))))
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        let layout = typeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                            : AnyLayout(HStackLayout(spacing: 4))
                        layout {
                            Text("AI limit")
                            if !typeSize.isAccessibilitySize { Spacer(minLength: 4) }
                            Text(displayValue(sampleLimit)).monospacedDigit()
                        }
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                        ProgressView(value: progress)
                            .tint(progressColor)
                            .progressViewStyle(.linear)
                            .accessibilityLabel("AI limit")
                    }
                    .accessibilityElement(children: .combine)
                }
            } else {
                Text("—")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityLabel("No limit data")
            }
        case .updated:
            VStack(alignment: alignment, spacing: 3) {
                if !compact {
                    Text("Updated").font(.caption2).foregroundStyle(.secondary)
                }
                Text(LocalizedStringKey(sourceStale ? "—" : "Just now"))
                    .font(compact ? .caption.monospacedDigit() : .subheadline.monospacedDigit().weight(.semibold))
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            }
            .accessibilityElement(children: .combine)
        case .provider where includesProviderMark:
            HStack(spacing: 6) {
                providerIcon(size: 16)
                Text(displayValue(providerName))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            }
            .accessibilityElement(children: .combine)
        default:
            let metric = value(field)
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
                        .font(field == .provider
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

    private func value(_ field: TokenMonitorActivityAttributes.Field) -> (label: String, value: String) {
        switch field {
        case .primary:
            switch primaryMetric {
            case .tokens: ("Tokens", displayValue(sampleTokens))
            case .cost: ("Cost", displayValue(sampleCost))
            case .limit: (displayValue(providerName), displayValue(sampleLimit))
            }
        case .secondary:
            if showsSecondary || configuredFields.contains(.secondary) {
                if primaryMetric == .limit {
                    ("Cost", displayValue(sampleCost))
                } else if sampleLimit != nil {
                    (displayValue(providerName), displayValue(sampleLimit))
                } else {
                    ("Secondary metric", "—")
                }
            } else {
                ("Secondary metric", "—")
            }
        case .provider: ("Provider", displayValue(providerName))
        case .tokens: ("Tokens", displayValue(sampleTokens))
        case .cost: ("Cost", displayValue(sampleCost))
        case .limit: ("AI limit", displayValue(sampleLimit))
        case .progress, .updated, .none: ("", "—")
        }
    }

    private func displayValue(_ value: String?) -> String {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "—" }
        return value
    }
}
