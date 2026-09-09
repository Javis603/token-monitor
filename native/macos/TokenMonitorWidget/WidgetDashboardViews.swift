import AppKit
import SwiftUI
import WidgetKit

struct SmallUsageWidgetView: View {
    let snapshot: WidgetSnapshot
    let period: WidgetPeriod

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(period.displayTitle)
                .font(.caption.weight(.medium))
                .foregroundStyle(WidgetDesignTokens.muted)

            Spacer(minLength: 7)

            Text(WidgetFormat.tokens(snapshot.overview.totalTokens, style: "compact", presentation: snapshot.presentation))
                .font(.system(size: 37, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(WidgetDesignTokens.number)
                .lineLimit(1)
                .minimumScaleFactor(0.68)
                .contentTransition(.numericText())
                .frame(maxWidth: .infinity, alignment: .leading)
                .offset(x: -1.5)

            if snapshot.presentation.showCost {
                Text(WidgetFormat.cost(snapshot.overview.costUsd, presentation: snapshot.presentation))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(WidgetDesignTokens.muted)
                    .padding(.top, 4)
            }

            Spacer(minLength: 10)

            SmoothTrendChart(points: snapshot.trend.points)
                .frame(height: 34)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(period.accessibilityName)
    }
}

struct MediumUsageWidgetView: View {
    let snapshot: WidgetSnapshot
    let period: WidgetPeriod
    let page: WidgetPage
    let referenceDate: Date
    let selectedActivityDate: String?
    let selectedQuotaProviderIDs: [String]

    var body: some View {
        GeometryReader { proxy in
            detail(availableSize: proxy.size)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private func detail(availableSize: CGSize) -> some View {
        switch page {
        case .overview, .activity:
            MediumActivityModule(
                snapshot: snapshot,
                referenceDate: referenceDate,
                selectedActivityDate: selectedActivityDate,
                availableSize: availableSize
            )
        case .quota:
            MediumQuotaModule(snapshot: snapshot, selectedProviderIDs: selectedQuotaProviderIDs)
        case .tools:
            MediumBreakdownModule(rows: toolRows, presentation: snapshot.presentation)
        case .models:
            MediumBreakdownModule(rows: modelRows, presentation: snapshot.presentation)
        case .trend:
            MediumTrendModule(snapshot: snapshot, period: period)
        }
    }

    private var toolRows: [WidgetBreakdownRow] {
        snapshot.tools.map {
            WidgetBreakdownRow(
                id: $0.id,
                label: WidgetFormat.provider($0.id),
                vendorID: $0.id,
                tokens: $0.totalTokens,
                share: $0.sharePercent
            )
        }
    }

    private var modelRows: [WidgetBreakdownRow] {
        snapshot.models.map {
            WidgetBreakdownRow(
                id: $0.id,
                label: $0.displayName,
                vendorID: WidgetVendorIdentity.modelVendor(for: $0.displayName),
                tokens: $0.totalTokens,
                share: $0.sharePercent
            )
        }
    }
}

struct LargeDashboardWidgetView: View {
    let snapshot: WidgetSnapshot
    let period: WidgetPeriod
    let page: WidgetPage
    let referenceDate: Date
    let selectedActivityDate: String?
    let selectedQuotaProviderIDs: [String]

    var body: some View {
        GeometryReader { proxy in
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .bottom, spacing: 16) {
                    WidgetMetricBlock(snapshot: snapshot, period: period, metricSize: 36)
                    Spacer(minLength: 10)
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(trendDelta)
                            .font(.caption.weight(.medium))
                            .monospacedDigit()
                            .foregroundStyle(WidgetDesignTokens.muted)
                        SmoothTrendChart(points: snapshot.trend.points)
                            .frame(width: 108, height: 32)
                    }
                    .padding(.bottom, 3)
                }
                .frame(height: 63, alignment: .top)

                Divider().opacity(WidgetDesignTokens.dividerOpacity)

                DashboardQuotaModule(snapshot: snapshot, selectedProviderIDs: selectedQuotaProviderIDs)
                    .frame(height: 76, alignment: .topLeading)

                Divider().opacity(WidgetDesignTokens.dividerOpacity)

                HStack(alignment: .center, spacing: 12) {
                    DashboardActivityModule(
                        snapshot: snapshot,
                        referenceDate: referenceDate,
                        selectedActivityDate: selectedActivityDate,
                        availableWidth: proxy.size.width * 0.44
                    )
                    .frame(width: proxy.size.width * 0.44, alignment: .leading)
                    .frame(maxHeight: .infinity, alignment: .leading)

                    Divider().opacity(WidgetDesignTokens.dividerOpacity)

                    DashboardBreakdownModule(
                        title: breakdownTitle,
                        rows: breakdownRows,
                        presentation: snapshot.presentation
                    )
                    .frame(maxHeight: .infinity, alignment: .leading)
                }
                .frame(maxHeight: .infinity, alignment: .leading)
            }
        }
    }

    private var usesTools: Bool { page == .tools }
    private var breakdownTitle: String { usesTools ? WidgetL10n.text("Tools") : WidgetL10n.text("Models") }

    private var breakdownRows: [WidgetBreakdownRow] {
        if usesTools {
            return snapshot.tools.map {
                WidgetBreakdownRow(id: $0.id, label: WidgetFormat.provider($0.id), vendorID: $0.id, tokens: $0.totalTokens, share: $0.sharePercent)
            }
        }
        return snapshot.models.map {
            WidgetBreakdownRow(id: $0.id, label: $0.displayName, vendorID: WidgetVendorIdentity.modelVendor(for: $0.displayName), tokens: $0.totalTokens, share: $0.sharePercent)
        }
    }

    private var trendDelta: String {
        guard let first = snapshot.trend.points.first?.totalTokens,
              let last = snapshot.trend.points.last?.totalTokens,
              first > 0 else { return "—" }
        let percent = Int((Double(last - first) / Double(first) * 100).rounded())
        if percent == 0 { return "0%" }
        return percent > 0 ? "+\(percent)%" : "−\(abs(percent))%"
    }
}

struct WidgetMetricBlock: View {
    let snapshot: WidgetSnapshot
    let period: WidgetPeriod
    let metricSize: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(period.displayTitle.uppercased())
                .font(.caption2.weight(.medium))
                .foregroundStyle(WidgetDesignTokens.muted)
            Text(WidgetFormat.tokens(snapshot.overview.totalTokens, style: "compact", presentation: snapshot.presentation))
                .font(.system(size: metricSize, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(WidgetDesignTokens.number)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .contentTransition(.numericText())
            if snapshot.presentation.showCost {
                Text(WidgetFormat.cost(snapshot.overview.costUsd, presentation: snapshot.presentation))
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(WidgetDesignTokens.muted)
            }
        }
    }
}

struct WidgetBreakdownRow: Identifiable {
    let id: String
    let label: String
    let vendorID: String
    let tokens: Int
    let share: Double
}

struct MediumBreakdownModule: View {
    let rows: [WidgetBreakdownRow]
    let presentation: WidgetPresentation

    var body: some View {
        if rows.isEmpty {
            Text(WidgetL10n.text("No data"))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
        } else {
            let visibleRows = Array(rows.prefix(4))
            GeometryReader { proxy in
                let rowHeight = proxy.size.height / 4
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(0..<4, id: \.self) { index in
                        Group {
                            if visibleRows.indices.contains(index) {
                                BreakdownRow(row: visibleRows[index], presentation: presentation)
                            } else {
                                Color.clear
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: rowHeight, maxHeight: rowHeight, alignment: .leading)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }
}

struct BreakdownRow: View {
    let row: WidgetBreakdownRow
    let presentation: WidgetPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                WidgetVendorMark(vendorID: row.vendorID, size: 13)
                Text(row.label)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text(WidgetFormat.tokens(row.tokens, style: "compact", presentation: presentation))
                    .font(.caption2.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Text("\(Int(row.share.rounded()))%")
                    .font(.caption2.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .frame(width: 30, alignment: .trailing)
            }
            PercentageBar(value: row.share, color: WidgetVendorIdentity.color(for: row.vendorID))
        }
    }
}

struct DashboardBreakdownModule: View {
    let title: String
    let rows: [WidgetBreakdownRow]
    let presentation: WidgetPresentation

    var body: some View {
        let visibleRows = Array(rows.prefix(4))
        VStack(alignment: .leading, spacing: 0) {
            ModuleTitle(title)
                .padding(.bottom, 6)
            if rows.isEmpty {
                Text(WidgetL10n.text("No data"))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(visibleRows) { row in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                WidgetVendorMark(vendorID: row.vendorID, size: 11)
                                Text(row.label)
                                    .font(.caption.weight(.semibold))
                                    .lineLimit(1)
                                Spacer(minLength: 3)
                                Text(WidgetFormat.tokens(row.tokens, style: "compact", presentation: presentation))
                                    .font(.caption2.weight(.medium))
                                    .monospacedDigit()
                                    .foregroundStyle(.secondary)
                            }
                            PercentageBar(value: row.share, color: WidgetVendorIdentity.color(for: row.vendorID))
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct MediumQuotaModule: View {
    let snapshot: WidgetSnapshot
    let selectedProviderIDs: [String]

    var body: some View {
        let providers = WidgetQuotaSelectionResolver.providers(
            in: snapshot,
            selectedIDs: selectedProviderIDs,
            limit: 2
        )
        Group {
            if providers.isEmpty {
                Text(WidgetL10n.text("Not configured"))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(providers) { provider in
                        QuotaProviderRow(
                            provider: provider,
                            showAccountLabel: shouldShowAccountLabel(for: provider)
                        )
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }
    }

    private func shouldShowAccountLabel(for provider: WidgetQuotaProvider) -> Bool {
        snapshot.quota.filter { $0.provider.caseInsensitiveCompare(provider.provider) == .orderedSame }.count > 1
    }
}

struct DashboardQuotaModule: View {
    let snapshot: WidgetSnapshot
    let selectedProviderIDs: [String]

    var body: some View {
        let providers = WidgetQuotaSelectionResolver.providers(
            in: snapshot,
            selectedIDs: selectedProviderIDs,
            limit: 2
        )
        VStack(alignment: .leading, spacing: 4) {
            ModuleTitle(WidgetL10n.text("Quota"))
            if providers.isEmpty {
                Text(WidgetL10n.text("Not configured"))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(providers) { provider in
                        DashboardQuotaProviderRow(
                            provider: provider,
                            showAccountLabel: shouldShowAccountLabel(for: provider)
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func shouldShowAccountLabel(for provider: WidgetQuotaProvider) -> Bool {
        snapshot.quota.filter { $0.provider.caseInsensitiveCompare(provider.provider) == .orderedSame }.count > 1
    }
}

private struct DashboardQuotaProviderRow: View {
    let provider: WidgetQuotaProvider
    let showAccountLabel: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    WidgetVendorMark(vendorID: provider.provider, size: 12)
                    Text(provider.displayName ?? WidgetFormat.provider(provider.provider))
                        .font(.system(size: 10, weight: .semibold))
                        .lineLimit(1)
                }
                if showAccountLabel, let accountLabel = provider.accountLabel, !accountLabel.isEmpty {
                    Text(accountLabel)
                        .font(.system(size: 8, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
            }
            .frame(width: 92, alignment: .leading)

            if !provider.windows.isEmpty {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(Array(provider.windows.prefix(2))) { window in
                        DashboardQuotaWindowCell(
                            window: window,
                            color: WidgetVendorIdentity.color(for: provider.provider)
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(WidgetFormat.quotaValue(provider))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DashboardQuotaWindowCell: View {
    let window: WidgetLimitWindow
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(WidgetFormat.windowTitle(window.kind))
                    .font(.system(size: 8.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 2)
                Text(value)
                    .font(.system(size: 8.5, weight: .semibold))
                    .monospacedDigit()
                    .lineLimit(1)
            }
            if window.showMeter, let remaining = window.remainingPercent {
                PercentageBar(value: remaining, color: color)
            }
            if let resetsAt = window.resetsAt {
                Text(WidgetFormat.reset(resetsAt))
                    .font(.system(size: 7.5, weight: .regular))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var value: String {
        if window.metric == "credits", window.detail == "unlimited" { return WidgetL10n.text("Unlimited") }
        if window.metric == "credits", let remaining = window.remaining {
            return String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), remaining)
        }
        if let remaining = window.remainingPercent { return "\(Int(remaining.rounded()))% left" }
        return "—"
    }
}

struct QuotaProviderRow: View {
    let provider: WidgetQuotaProvider
    let showAccountLabel: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                WidgetVendorMark(vendorID: provider.provider, size: 13)
                Text(provider.displayName ?? WidgetFormat.provider(provider.provider))
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                if showAccountLabel, let accountLabel = provider.accountLabel, !accountLabel.isEmpty {
                    Text(accountLabel)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 6)
                if provider.windows.isEmpty {
                    Text(WidgetFormat.quotaValue(provider))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if !provider.windows.isEmpty {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(Array(provider.windows.prefix(2))) { window in
                        QuotaWindowCell(window: window, color: WidgetVendorIdentity.color(for: provider.provider))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct QuotaWindowCell: View {
    let window: WidgetLimitWindow
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(WidgetFormat.windowTitle(window.kind))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                Text(value)
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            if window.showMeter, let remaining = window.remainingPercent {
                PercentageBar(value: remaining, color: color)
            }
            if let resetsAt = window.resetsAt {
                Text(WidgetFormat.reset(resetsAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var value: String {
        if window.metric == "credits", window.detail == "unlimited" { return WidgetL10n.text("Unlimited") }
        if window.metric == "credits", let remaining = window.remaining {
            return String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), remaining)
        }
        if let remaining = window.remainingPercent { return "\(Int(remaining.rounded()))% left" }
        return "—"
    }
}

struct MediumActivityModule: View {
    let snapshot: WidgetSnapshot
    let referenceDate: Date
    let selectedActivityDate: String?
    let availableSize: CGSize

    var body: some View {
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: snapshot.activity.days,
            referenceDate: referenceDate,
            availableSize: CGSize(width: availableSize.width, height: max(60, availableSize.height - 42)),
            maxWeeks: 26,
            minCellSize: 5.5,
            maxCellSize: 9.5,
            spacing: 2.5
        )
        VStack(alignment: .leading, spacing: 8) {
            ActivityHeatmapWithMonthLabels(layout: layout, family: .medium, selectedDate: selectedActivityDate)
                .frame(maxWidth: .infinity, alignment: .center)
            Text(activitySummary)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private var activitySummary: String {
        let tokens = snapshot.activity.days.reduce(0) { $0 + $1.totalTokens }
        let tokenText = WidgetFormat.tokens(tokens, style: "compact", presentation: snapshot.presentation)
        return "\(tokenText) tokens · \(snapshot.activity.activeDays) active days"
    }
}

struct MediumTrendModule: View {
    let snapshot: WidgetSnapshot
    let period: WidgetPeriod

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(period.displayTitle)
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text(WidgetFormat.tokens(snapshot.overview.totalTokens, style: "compact", presentation: snapshot.presentation))
                        .font(.system(size: 24, weight: .medium))
                        .monospacedDigit()
                }
                Spacer(minLength: 8)
                Text(delta)
                    .font(.system(size: 11, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            SmoothTrendChart(points: snapshot.trend.points)
                .frame(maxHeight: .infinity)
            if let start = snapshot.trend.startDate, let end = snapshot.trend.endDate {
                HStack {
                    Text(start)
                    Spacer()
                    Text(end)
                }
                .font(.system(size: 8.5, weight: .medium))
                .foregroundStyle(.tertiary)
            }
        }
    }

    private var delta: String {
        guard let first = snapshot.trend.points.first?.totalTokens,
              let last = snapshot.trend.points.last?.totalTokens,
              first > 0 else { return "—" }
        let percent = Int((Double(last - first) / Double(first) * 100).rounded())
        return percent > 0 ? "+\(percent)%" : "\(percent)%"
    }
}

struct DashboardActivityModule: View {
    let snapshot: WidgetSnapshot
    let referenceDate: Date
    let selectedActivityDate: String?
    let availableWidth: CGFloat

    var body: some View {
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: snapshot.activity.days,
            referenceDate: referenceDate,
            availableSize: CGSize(width: availableWidth, height: 64),
            maxWeeks: 16,
            minCellSize: 5,
            maxCellSize: 7.5,
            spacing: 2.25
        )
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                ModuleTitle(WidgetL10n.text("Activity"))
                Spacer(minLength: 8)
                Text(WidgetL10n.format("%lld days", layout.activeDays))
                    .font(.system(size: 9, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            ActivityHeatmapWithMonthLabels(layout: layout, family: .large, selectedDate: selectedActivityDate)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct ActivityHeatmapWithMonthLabels: View {
    let layout: WidgetHeatmapLayout
    let family: WidgetFamilyScope
    let selectedDate: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ActivityHeatmap(layout: layout, family: family, selectedDate: selectedDate)
            HeatmapMonthLabels(layout: layout)
        }
        .frame(width: layout.renderedWidth, alignment: .leading)
    }
}

private struct HeatmapMonthLabels: View {
    let layout: WidgetHeatmapLayout

    var body: some View {
        ZStack(alignment: .leading) {
            ForEach(markers) { marker in
                Text(marker.title)
                    .font(.system(size: 8, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .offset(x: min(markerOffset(marker.week), max(0, layout.renderedWidth - 22)))
            }
        }
        .frame(width: layout.renderedWidth, height: 10, alignment: .leading)
        .clipped()
        .accessibilityHidden(true)
    }

    private var markers: [HeatmapMonthMarker] {
        var result: [HeatmapMonthMarker] = []
        var previousMonth: String?

        for week in 0..<layout.weekCount {
            let monthKeys = (0..<7).compactMap { weekday in
                layout.cell(week: week, weekday: weekday)?.date.split(separator: "-").prefix(2).joined(separator: "-")
            }
            let monthKey = previousMonth.flatMap { previous in
                monthKeys.first(where: { $0 != previous })
            } ?? monthKeys.first
            guard let monthKey else { continue }
            if monthKey != previousMonth {
                result.append(HeatmapMonthMarker(week: week, title: monthTitle(monthKey)))
                previousMonth = monthKey
            }
        }
        return result
    }

    private func markerOffset(_ week: Int) -> CGFloat {
        CGFloat(week) * (layout.cellWidth + layout.spacing)
    }

    private func monthTitle(_ key: String) -> String {
        let parts = key.split(separator: "-")
        guard parts.count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let date = Calendar.current.date(from: DateComponents(year: year, month: month, day: 1))
        else { return key }
        return date.formatted(.dateTime.month(.abbreviated))
    }
}

private struct HeatmapMonthMarker: Identifiable {
    let week: Int
    let title: String

    var id: Int { week }
}

struct ModuleTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title.uppercased())
            .font(.caption2.weight(.medium))
            .foregroundStyle(WidgetDesignTokens.muted)
    }
}

enum WidgetVendorIdentity {
    static func modelVendor(for model: String) -> String {
        let value = model.lowercased()
        if value.contains("claude") || value.contains("anthropic") || value.contains("sonnet") || value.contains("opus") || value.contains("haiku") { return "claude" }
        if value.contains("gpt") || value.contains("openai") || value.contains("codex") || value.hasPrefix("o1-") || value.hasPrefix("o3-") || value.hasPrefix("o4-") { return "codex" }
        if value.contains("gemini") || value.contains("gemma") || value.contains("google") { return "gemini" }
        if value.contains("deepseek") { return "deepseek" }
        if value.contains("grok") || value.contains("xai") { return "xai" }
        if value.contains("llama") || value.contains("meta") { return "meta" }
        if value.contains("mistral") || value.contains("mixtral") || value.contains("codestral") { return "mistral" }
        if value.contains("qwen") { return "qwen" }
        if value.contains("kimi") || value.contains("moonshot") { return "kimi" }
        if value.contains("glm") || value.contains("zai") { return "zai" }
        return "default"
    }

    static func iconName(for vendorID: String) -> String {
        switch vendorID.lowercased() {
        case "chatgpt": "codex"
        case "hermes": "hermes-agent"
        case "mimo", "micode": "xiaomi"
        case "zcode", "zaiteam": "zai"
        default: vendorID.lowercased()
        }
    }

    static func color(for vendorID: String) -> Color {
        let colors: [String: String] = [
            "claude": "#CC7C5E", "codex": "#49A3B0", "hermes": "#D4AF37",
            "gemini": "#4285F4", "antigravity": "#4285F4", "cline": "#53616D",
            "deepseek": "#4D6BFE", "openrouter": "#6566F1", "openclaw": "#FF4D4D",
            "meta": "#4385DB", "mistral": "#FA520F", "qwen": "#7771F4",
            "zed": "#5C8BFF", "kilo": "#F8F676", "commandcode": "#9D66E7",
            "kiro": "#A66AFF", "codebuddy": "#8064FF", "workbuddy": "#0DC8A5",
            "qodercn": "#2ADB5C", "qoder": "#2ADB5C", "reasonix": "#4D6BFE",
            "dsh": "#4D6BFE", "cherrystudio": "#EA5E5D", "lmstudio": "#8074E8",
            "unsloth": "#40B85A", "cohere": "#66937D", "xiaomi": "#FF6700",
            "mimo": "#FF6700", "micode": "#FF6700", "minimax": "#F23F5D",
            "doubao": "#5064FF", "hunyuan": "#277DE3", "volcengine": "#2A88FF",
            "trae": "#32F08C", "alibaba": "#7771F4", "thirdparty": "#8090A6",
            "default": "#6AB4F0"
        ]
        let adaptiveInk = ["grok", "xai", "copilot", "cursor", "opencode", "pi", "zai", "zaiteam", "zcode", "proma", "kimi", "moonshot", "ollama"]
        if adaptiveInk.contains(vendorID.lowercased()) { return Color.white.opacity(0.86) }
        return Color(widgetHex: colors[vendorID.lowercased()] ?? colors["default"]!)
    }
}

struct WidgetVendorMark: View {
    let vendorID: String
    let size: CGFloat

    var body: some View {
        Group {
            if let image = image {
                Image(nsImage: image)
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
            } else {
                Circle()
            }
        }
        .foregroundStyle(.primary.opacity(0.88))
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var image: NSImage? {
        let name = WidgetVendorIdentity.iconName(for: vendorID)
        guard let url = Bundle.main.url(forResource: name, withExtension: "svg", subdirectory: "icons") else { return nil }
        guard
            let data = try? Data(contentsOf: url),
            var source = String(data: data, encoding: .utf8)
        else { return nil }

        // Most web icons use CSS-sized `1em` canvases. NSImage interprets that
        // as a literal 1-by-1 image, clipping the 24-point viewBox into the
        // solid squares seen in WidgetKit. Give the existing source artwork a
        // concrete intrinsic canvas before AppKit rasterizes it.
        source = source.replacingOccurrences(
            of: #"(width|height)=["']1em["']"#,
            with: #"$1="24""#,
            options: .regularExpression
        )
        source = source.replacingOccurrences(of: "currentColor", with: "#000000", options: .caseInsensitive)

        guard let normalizedData = source.data(using: .utf8), let image = NSImage(data: normalizedData) else { return nil }
        image.isTemplate = true
        return image
    }
}

private extension Color {
    init(widgetHex: String) {
        let value = widgetHex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let number = UInt64(value, radix: 16) ?? 0x6AB4F0
        self.init(
            red: Double((number >> 16) & 0xFF) / 255,
            green: Double((number >> 8) & 0xFF) / 255,
            blue: Double(number & 0xFF) / 255
        )
    }
}

struct PercentageBar: View {
    let value: Double
    var color: Color = WidgetDesignTokens.chartBlue

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.07))
                Capsule()
                    .fill(color.opacity(0.82))
                    .frame(width: proxy.size.width * max(0, min(1, value / 100)))
            }
        }
        .frame(height: 3)
        .accessibilityValue(Text(value / 100, format: .percent.precision(.fractionLength(0))))
    }
}

struct SmoothTrendChart: View {
    let points: [WidgetTrendPoint]

    var body: some View {
        GeometryReader { proxy in
            SmoothTrendShape(values: points.map { Double($0.totalTokens) })
                .stroke(
                    WidgetDesignTokens.chartBlue,
                    style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round)
                )
                .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .accessibilityHidden(true)
    }
}

struct SmoothTrendShape: Shape {
    let values: [Double]

    func path(in rect: CGRect) -> Path {
        guard values.count > 1 else { return Path() }
        let low = values.min() ?? 0
        let high = values.max() ?? low
        let range = max(1, high - low)
        let inset = rect.height * 0.08
        let chartHeight = max(1, rect.height - inset * 2)
        let points = values.enumerated().map { index, value in
            CGPoint(
                x: rect.minX + rect.width * CGFloat(index) / CGFloat(values.count - 1),
                y: rect.minY + inset + chartHeight * (1 - CGFloat((value - low) / range))
            )
        }
        var path = Path()
        path.move(to: points[0])
        for index in 0..<(points.count - 1) {
            let previous = points[max(0, index - 1)]
            let current = points[index]
            let next = points[index + 1]
            let following = points[min(points.count - 1, index + 2)]
            let control1 = CGPoint(
                x: current.x + (next.x - previous.x) / 6,
                y: current.y + (next.y - previous.y) / 6
            )
            let control2 = CGPoint(
                x: next.x - (following.x - current.x) / 6,
                y: next.y - (following.y - current.y) / 6
            )
            path.addCurve(to: next, control1: control1, control2: control2)
        }
        return path
    }
}
