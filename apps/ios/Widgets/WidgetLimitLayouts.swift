import SwiftUI
import WidgetKit

/// AI limits across home families: one provider's quota windows in the
/// desktop's fixed English vocabulary — `82% left`, `Reset 1h 52m` — with
/// vendor colour only on the meters.
struct WidgetLimitsView: View {
    @Environment(\.widgetInk) private var ink
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: TokenMonitorWidgetEntry
    let family: WidgetFamily

    private var accessible: Bool { typeSize.isAccessibilitySize }
    private var windows: [TokenMonitorSharedPayload.LimitWindow] {
        entry.visibleLimitWindows
    }
    private var providerID: String? { entry.preferredLimit?.providerID }

    var body: some View {
        switch family {
        case .systemMedium: medium
        case .systemLarge: large
        default: small
        }
    }

    // MARK: Small — one dominant reading, one compact second window

    private var small: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(entry: entry, isCompact: true)
            Spacer(minLength: 0)
            if let primary = windows.first {
                let column = WidgetWindowColumn(
                    window: primary, providerID: providerID,
                    now: entry.date, locale: entry.locale
                )
                VStack(alignment: .leading, spacing: 4) {
                    valueRow(column, size: 34)
                    Text(verbatim: labelWithReset(primary))
                        .font(.caption)
                        .foregroundStyle(ink.secondary)
                        .lineLimit(1)
                    meter(for: column, height: 6)
                }
            }
            if !accessible, let secondary = windows.dropFirst().first {
                let column = WidgetWindowColumn(
                    window: secondary, providerID: providerID,
                    now: entry.date, locale: entry.locale
                )
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(LocalizedStringKey(secondary.label))
                            .foregroundStyle(ink.secondary)
                        Spacer(minLength: 4)
                        Text(verbatim: column.shortValueText)
                            .monospacedDigit()
                    }
                    .font(.caption2)
                    .lineLimit(1)
                    meter(for: column, height: 4)
                }
            }
        }
    }

    // MARK: Medium — up to two equal window columns

    private var medium: some View {
        VStack(alignment: .leading, spacing: 12) {
            WidgetHeader(entry: entry, planLabel: entry.preferredLimit?.planLabel)
            Link(destination: Self.limitsURL) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(windows.prefix(accessible ? 1 : 2)) { window in
                        let column = WidgetWindowColumn(
                            window: window, providerID: providerID,
                            now: entry.date, locale: entry.locale
                        )
                        VStack(alignment: .leading, spacing: 5) {
                            Text(LocalizedStringKey(window.label))
                                .font(.caption)
                                .foregroundStyle(ink.secondary)
                                .lineLimit(1)
                            valueRow(column, size: 28)
                            meter(for: column, height: 6)
                            Text(verbatim: column.resetText ?? " ")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(ink.secondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
    }

    // MARK: Large — AI Limits header, provider blocks

    private var large: some View {
        let limits = Array(entry.orderedLimits.prefix(accessible ? 1 : 3))
        let configured = entry.providerID != nil
        return VStack(alignment: .leading, spacing: 12) {
            WidgetHeader(
                entry: entry,
                title: "AI Limits",
                systemImage: "gauge.with.dots.needle.50percent"
            )
            Link(destination: Self.limitsURL) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(limits.enumerated()), id: \.offset) { index, limit in
                        if index > 0 { Divider() }
                        providerBlock(
                            limit,
                            windows: windowList(for: limit, cap: configured ? 4 : 2),
                            grid: configured
                        )
                    }
                }
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
    }

    private func windowList(
        for limit: TokenMonitorSharedPayload.Limit,
        cap: Int
    ) -> [TokenMonitorSharedPayload.LimitWindow] {
        Array(limit.windows.filter {
            $0.remainingPercent?.isFinite == true || $0.amount?.isFinite == true
        }.prefix(cap))
    }

    /// Mark + name (+ plan, + per-account stale badge), then its windows —
    /// a 2×2 grid for a configured provider, two columns otherwise.
    private func providerBlock(
        _ limit: TokenMonitorSharedPayload.Limit,
        windows: [TokenMonitorSharedPayload.LimitWindow],
        grid: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 6) {
                ActivityMark(providerID: limit.providerID, size: 15)
                Text(verbatim: WidgetPresentation.displayName(for: limit.providerID))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let plan = limit.planLabel, !plan.isEmpty {
                    Text(verbatim: plan)
                        .font(.caption)
                        .foregroundStyle(ink.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if limit.sourceStale == true {
                    Image(systemName: "clock.badge.exclamationmark")
                        .font(.caption2)
                        .foregroundStyle(ink.secondary)
                        .accessibilityLabel("Data may be out of date")
                }
            }
            if grid {
                Grid(horizontalSpacing: 16, verticalSpacing: 10) {
                    GridRow {
                        columnCell(limit.providerID, windows, at: 0)
                        columnCell(limit.providerID, windows, at: 1)
                    }
                    GridRow {
                        columnCell(limit.providerID, windows, at: 2)
                        columnCell(limit.providerID, windows, at: 3)
                    }
                }
            } else {
                HStack(alignment: .top, spacing: 16) {
                    columnCell(limit.providerID, windows, at: 0)
                    columnCell(limit.providerID, windows, at: 1)
                }
            }
        }
    }

    private func columnCell(
        _ providerID: String,
        _ windows: [TokenMonitorSharedPayload.LimitWindow],
        at index: Int
    ) -> some View {
        Group {
            if windows.indices.contains(index) {
                WidgetWindowColumn(
                    window: windows[index],
                    providerID: providerID,
                    now: entry.date,
                    locale: entry.locale
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Shared pieces

    /// `82%` with a baseline-aligned `left` — or the credits amount alone.
    private func valueRow(_ column: WidgetWindowColumn, size: CGFloat) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(verbatim: column.shortValueText)
                .font(.system(size: size, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.65)
                .widgetAccentable()
            if column.isPercent {
                Text(verbatim: "left")
                    .font(.caption)
                    .foregroundStyle(ink.secondary)
            }
        }
    }

    private func meter(for column: WidgetWindowColumn, height: CGFloat) -> some View {
        Group {
            if let fraction = column.fraction {
                ActivityMeter(
                    fraction: fraction,
                    tint: ActivityPalette.quotaTint(providerID),
                    height: height
                )
            } else {
                Capsule()
                    .fill(.clear)
                    .frame(height: height)
            }
        }
        .accessibilityHidden(true)
    }

    /// `Session · 1h 30m` — window label plus its reset countdown.
    private func labelWithReset(_ window: TokenMonitorSharedPayload.LimitWindow) -> String {
        let label = String(localized: String.LocalizationValue(window.label), locale: entry.locale)
        guard let resetAt = window.resetAt else { return label }
        return label + " · " + WidgetPresentation.resetCountdown(to: resetAt, now: entry.date)
    }

    static let limitsURL = URL(string: "tokenmonitor://limits")!
}
