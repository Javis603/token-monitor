import SwiftUI
import WidgetKit

/// Quota surfaces grow from a focused account to desktop-ordered providers
/// and accounts. An explicit provider selection scopes every family.
struct WidgetLimitsView: View {
    @Environment(\.widgetInk) private var ink
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: TokenMonitorWidgetEntry
    let family: WidgetFamily

    private var accessible: Bool { typeSize.isAccessibilitySize }
    private var limits: [TokenMonitorSharedPayload.Limit] {
        entry.orderedLimits.filter { !$0.windows.isEmpty }
    }

    var body: some View {
        switch family {
        case .systemMedium: medium
        case .systemLarge: large
        default: small
        }
    }

    // MARK: Small — focused account, tightly grouped reading

    private var small: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let limit = entry.preferredLimit {
                WidgetLimitHeader(entry: entry, limit: limit)
                if let primary = limit.windows.first {
                    VStack(alignment: .leading, spacing: 4) {
                        WidgetQuotaValue(column: column(primary, for: limit))
                        Text(verbatim: labelWithReset(primary))
                            .font(.caption2)
                            .foregroundStyle(ink.secondary)
                            .lineLimit(1)
                        meter(primary, providerID: limit.providerID, height: 6)
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                if !accessible, let secondary = limit.windows.dropFirst().first {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(verbatim: secondary.label)
                                .foregroundStyle(ink.secondary)
                            Spacer(minLength: 4)
                            Text(verbatim: column(secondary, for: limit).shortValueText)
                                .monospacedDigit()
                        }
                        .font(.caption2)
                        .lineLimit(1)
                        meter(secondary, providerID: limit.providerID, height: 4)
                    }
                }
            }
        }
    }

    // MARK: Medium — two accounts, or a focused provider's windows

    @ViewBuilder private var medium: some View {
        if limits.count > 1, !accessible {
            HStack(alignment: .top, spacing: 16) {
                ForEach(limits.prefix(2)) { limit in
                    VStack(alignment: .leading, spacing: 8) {
                        WidgetLimitHeader(entry: entry, limit: limit, accountLabel: accountLabel(for: limit))
                        ForEach(limit.windows.prefix(2)) { window in
                            column(window, for: limit)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
        } else if let limit = limits.first {
            VStack(alignment: .leading, spacing: 12) {
                WidgetLimitHeader(entry: entry, limit: limit)
                let rows = entry.preferences.widgetLimitLayout == "rows" && limit.windows.count > 1
                (rows
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
                    : AnyLayout(HStackLayout(alignment: .top, spacing: 16))) {
                    ForEach(limit.windows.prefix(accessible ? 1 : 2)) { window in
                        if rows {
                            column(window, for: limit)
                        } else {
                            expandedWindow(window, for: limit, size: 30)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }

    // MARK: Large — as many complete accounts as the host can fit

    @ViewBuilder private var large: some View {
        if limits.count == 1, let limit = limits.first {
            VStack(alignment: .leading, spacing: 16) {
                WidgetLimitHeader(entry: entry, limit: limit)
                ForEach(limit.windows.prefix(accessible ? 1 : 4)) { window in
                    expandedWindow(window, for: limit, size: 36)
                        .frame(maxHeight: .infinity, alignment: .center)
                }
            }
        } else {
            ViewThatFits(in: .vertical) {
                accountList(capacity: accessible ? 1 : 4)
                accountList(capacity: accessible ? 1 : 3)
                accountList(capacity: accessible ? 1 : 2)
                accountList(capacity: 1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func accountList(capacity: Int) -> some View {
        let visible = Array(limits.prefix(capacity))
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, limit in
                let sameProvider = index > 0 && visible[index - 1].providerID == limit.providerID
                if index > 0 { Divider() }
                VStack(alignment: .leading, spacing: 8) {
                    WidgetLimitHeader(
                        entry: entry, limit: limit,
                        accountLabel: accountLabel(for: limit),
                        showsProvider: !sameProvider
                    )
                    if accessible {
                        if let window = limit.windows.first {
                            column(window, for: limit)
                        }
                    } else {
                        ForEach(Array(stride(from: 0, to: limit.windows.count, by: 2)), id: \.self) { offset in
                            HStack(alignment: .top, spacing: 16) {
                                column(limit.windows[offset], for: limit)
                                if limit.windows.indices.contains(offset + 1) {
                                    column(limit.windows[offset + 1], for: limit)
                                }
                            }
                        }
                    }
                }
            }
            if limits.count > visible.count {
                HStack(spacing: 4) {
                    Text(verbatim: "+\(limits.count - visible.count)")
                    Image(systemName: "chevron.right")
                }
                .font(.caption2)
                .foregroundStyle(ink.secondary)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .accessibilityLabel(Text("Open Token Monitor"))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func accountLabel(for limit: TokenMonitorSharedPayload.Limit) -> String? {
        let accounts = limits.filter { $0.providerID == limit.providerID }
        guard accounts.count > 1 else { return nil }
        return limit.maskedAccountLabel
            ?? accounts.firstIndex(where: { $0.id == limit.id }).map { "#\($0 + 1)" }
    }

    private func column(
        _ window: TokenMonitorSharedPayload.LimitWindow,
        for limit: TokenMonitorSharedPayload.Limit
    ) -> WidgetWindowColumn {
        WidgetWindowColumn(
            window: window, providerID: limit.providerID,
            now: entry.date, locale: entry.locale,
            showsResetTime: entry.preferences.widgetShowsResetTime
        )
    }

    private func expandedWindow(
        _ window: TokenMonitorSharedPayload.LimitWindow,
        for limit: TokenMonitorSharedPayload.Limit,
        size: CGFloat
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(verbatim: window.label)
                .font(.caption)
                .foregroundStyle(ink.secondary)
                .lineLimit(1)
            WidgetQuotaValue(column: column(window, for: limit), size: size)
            meter(window, providerID: limit.providerID, height: 6)
            if entry.preferences.widgetShowsResetTime, let reset = column(window, for: limit).resetText {
                Text(verbatim: reset)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(ink.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func meter(_ window: TokenMonitorSharedPayload.LimitWindow, providerID: String, height: CGFloat) -> some View {
        Group {
            if let fraction = WidgetPresentation.fraction(window.remainingPercent, total: 100) {
                ActivityMeter(fraction: fraction, tint: ActivityPalette.quotaTint(providerID), height: height)
            } else {
                Capsule().fill(.clear).frame(height: height)
            }
        }
        .accessibilityHidden(true)
    }

    private func labelWithReset(_ window: TokenMonitorSharedPayload.LimitWindow) -> String {
        guard entry.preferences.widgetShowsResetTime, let resetAt = window.resetAt else { return window.label }
        return window.label + " · " + WidgetPresentation.resetCountdown(to: resetAt, now: entry.date)
    }

    static let limitsURL = URL(string: "tokenmonitor://limits")!
}
