import SwiftUI

// Shared Live Activity rendering, compiled into the app (Settings customizer)
// and the widget extension so both surfaces draw identical pixels. Every view
// is a pure function of `ContentState` + `isStale` — nothing reads user
// defaults or the network.

typealias ActivityState = TokenMonitorActivityAttributes.ContentState

// MARK: - Localized helpers

extension ActivityState.Layout {
    var locale: Locale {
        switch languageCode {
        case "en": Locale(identifier: "en")
        case "zh-TW": Locale(identifier: "zh-Hant")
        case "zh-CN": Locale(identifier: "zh-Hans")
        case "ja": Locale(identifier: "ja")
        case "ko": Locale(identifier: "ko")
        default: .autoupdatingCurrent
        }
    }
}

extension ActivityState {
    var locale: Locale { layout.locale }

    /// "75% left" — localized via WidgetPresentation.remaining.
    func remainingText(_ percent: Double?) -> String {
        guard let percent else { return "—" }
        return WidgetPresentation.remaining(percent, locale: locale)
    }

    func percentText(_ percent: Double?) -> String {
        guard let percent else { return "—" }
        return WidgetPresentation.percent(percent, locale: locale)
    }

    var tokensText: String {
        WidgetPresentation.tokens(tokens ?? .nan, locale: locale)
    }

    var costText: String {
        guard let costUSD else { return "—" }
        return WidgetPresentation.currencyFromUSD(
            costUSD, displayCode: layout.currencyCode, locale: locale
        )
    }

    var periodTitle: LocalizedStringKey {
        switch period {
        case "month": "This month"
        case "allTime": "All time"
        default: "Today"
        }
    }

    /// First quota window's remaining fraction, clamped 0…1.
    var quotaFraction: Double? {
        guard let percent = quota?.windows.first?.remainingPercent else { return nil }
        return min(1, max(0, percent / 100))
    }
}

// MARK: - Marks and gauges

/// Provider mark — a template image, white on the Dynamic Island and primary
/// on the Lock Screen. No quota falls back to the app's usage glyph.
struct ActivityMarkView: View {
    let state: ActivityState
    var size: CGFloat = 16
    var monochrome = false

    var body: some View {
        Group {
            if let providerID = state.quota?.providerID {
                Image(WidgetPresentation.assetName(for: providerID))
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "chart.bar.fill")
                    .resizable()
                    .scaledToFit()
            }
        }
        .foregroundStyle(monochrome ? .white : .primary)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Circular gauge from the first window's remaining %, tinted per provider.
struct ActivityQuotaRing: View {
    let state: ActivityState
    var diameter: CGFloat = 24
    var showsMark = false
    var markMonochrome = false

    var body: some View {
        let tint = ActivityPalette.quotaTint(state.quota?.providerID)
        ZStack {
            Circle()
                .stroke(tint.opacity(0.25), lineWidth: diameter * 0.12)
            if let fraction = state.quotaFraction {
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(tint, style: StrokeStyle(lineWidth: diameter * 0.12, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            if showsMark {
                ActivityMarkView(state: state, size: diameter * 0.45, monochrome: markMonochrome)
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityLabel(Text("AI limit"))
        .accessibilityValue(state.percentText(state.quota?.windows.first?.remainingPercent))
    }
}

enum ActivityPalette {
    // Widget extensions cannot import the app's ProviderPresentation; the tint
    // table lives here so the extension, in-app previews and widget share it.
    static func quotaTint(_ provider: String?) -> Color {
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

    static func rgb(_ hex: UInt32) -> Color {
        Color(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}

/// Small staleness pill; on black island tiles it reads as white-on-dark.
struct ActivityStaleChip: View {
    var body: some View {
        Text("Stale")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Color.secondary.opacity(0.18), in: Capsule())
            .fixedSize()
    }
}

/// "1:59:56" under a day, "2天 20小時" at or beyond — the compact days+hours
/// reading is produced at render time so every surface shares the same rule.
enum ActivityResetCountdown {
    static var compactFormatter: DateComponentsFormatter {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        formatter.zeroFormattingBehavior = .dropLeading
        return formatter
    }

    static func compact(_ date: Date, now: Date = .now) -> String? {
        let interval = date.timeIntervalSince(now)
        guard interval >= 86_400 else { return nil }
        return compactFormatter.string(from: interval)
    }
}

// MARK: - Compact Dynamic Island

struct ActivityCompactLeadingView: View {
    let state: ActivityState
    let isStale: Bool

    var body: some View {
        switch state.layout.compactLeadingOption {
        case .mark:
            if isStale {
                Image(systemName: "clock.badge.exclamationmark")
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
            } else {
                ActivityMarkView(state: state, size: 17, monochrome: true)
            }
        case .ring:
            ActivityQuotaRing(state: state, diameter: 20, showsMark: true, markMonochrome: true)
        case .tokens:
            Text(state.tokensText)
                .font(.caption.monospacedDigit().weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        case .cost:
            Text(state.costText)
                .font(.caption.monospacedDigit().weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}

struct ActivityCompactTrailingView: View {
    let state: ActivityState
    let isStale: Bool

    var body: some View {
        Group {
            switch state.layout.compactTrailingOption {
            case .percent:
                Text(state.percentText(state.quota?.windows.first?.remainingPercent))
            case .reset:
                if let resetsAt = state.quota?.windows.first?.resetsAt {
                    if let days = ActivityResetCountdown.compact(resetsAt) {
                        Text(days)
                    } else {
                        Text(resetsAt, style: .timer)
                    }
                } else {
                    Text("—")
                }
            case .tokens:
                Text(state.tokensText)
            case .cost:
                Text(state.costText)
            case .ring:
                ActivityQuotaRing(state: state, diameter: 20)
            }
        }
        .font(.caption.monospacedDigit().weight(.semibold))
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
}

struct ActivityMinimalView: View {
    let state: ActivityState
    let isStale: Bool

    var body: some View {
        if isStale {
            Image(systemName: "clock.badge.exclamationmark")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
        } else {
            ActivityMarkView(state: state, size: 15, monochrome: true)
        }
    }
}

// MARK: - Style bodies

/// Up to two quota windows: label, provider-tinted bar, remaining % and reset.
struct ActivityQuotaRows: View {
    let state: ActivityState
    var monochrome = false
    var compact = false

    var body: some View {
        if let quota = state.quota, !quota.windows.isEmpty {
            VStack(alignment: .leading, spacing: compact ? 4 : 6) {
                ForEach(Array(quota.windows.enumerated()), id: \.offset) { _, window in
                    ActivityWindowRow(
                        state: state,
                        window: window,
                        monochrome: monochrome,
                        compact: compact
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text("No quota windows available")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct ActivityWindowRow: View {
    let state: ActivityState
    let window: ActivityState.Window
    let monochrome: Bool
    let compact: Bool

    private var tint: Color {
        ActivityPalette.quotaTint(state.quota?.providerID)
    }

    var body: some View {
        let fraction = window.remainingPercent.map { min(1, max(0, $0 / 100)) }
        VStack(alignment: .leading, spacing: compact ? 2 : 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // Canonical labels ("5-hour", "Weekly", …) resolve through the
                // shared catalog; unknown collector labels render as-is.
                Text(LocalizedStringKey(window.label))
                    .font(compact ? .caption2 : .caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let amount = window.creditsAmount {
                    Text(
                        WidgetPresentation.currency(
                            amount,
                            sourceCode: window.creditsCurrency ?? state.layout.currencyCode,
                            displayCode: state.layout.currencyCode,
                            locale: state.locale
                        )
                    )
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .lineLimit(1)
                } else {
                    Text(state.percentText(window.remainingPercent))
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .lineLimit(1)
                }
                if let resetsAt = window.resetsAt {
                    // Under a day: ticking countdown. 24h+: compact days+hours
                    // so lock-screen rows never render "68:59:56".
                    Group {
                        if let days = ActivityResetCountdown.compact(resetsAt) {
                            Text(days)
                        } else {
                            Text(resetsAt, style: .timer)
                        }
                    }
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
            }
            GeometryReader { proxy in
                Capsule()
                    .fill(tint.opacity(0.22))
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(tint)
                            .frame(width: fraction.map { max(3, $0 * proxy.size.width) } ?? 0)
                    }
            }
            .frame(height: compact ? 4 : 5)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Period usage readout: big tokens + cost over the "Today"/"This month" tag.
struct ActivityUsageSummary: View {
    let state: ActivityState
    var alignment: HorizontalAlignment = .leading

    var body: some View {
        VStack(alignment: alignment, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(state.tokensText)
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(state.costText)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(state.periodTitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Freshness line: "Updated …ago" or the stale chip.
struct ActivityFreshnessLine: View {
    let state: ActivityState
    let isStale: Bool

    var body: some View {
        if isStale {
            ActivityStaleChip()
        } else if state.updatedAt > .distantPast {
            HStack(spacing: 3) {
                Text("Updated")
                Text(state.updatedAt, style: .relative).monospacedDigit()
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .accessibilityElement(children: .combine)
        } else {
            EmptyView()
        }
    }
}

// MARK: - Expanded Dynamic Island

/// Full expanded-island composition (header row + style body). The widget
/// places it in the bottom region, which spans the whole island width, so the
/// Settings customizer can render the identical tile.
struct ActivityExpandedView: View {
    let state: ActivityState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ActivityMarkView(state: state, size: 18, monochrome: true)
                if let quota = state.quota {
                    Text(WidgetPresentation.displayName(for: quota.providerID))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    if let plan = quota.planLabel, !plan.isEmpty {
                        Text(plan)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                ActivityFreshnessLine(state: state, isStale: isStale)
            }
            switch state.layout.expandedStyle {
            case .quota:
                ActivityQuotaRows(state: state, compact: true)
            case .usage:
                ActivityUsageSummary(state: state)
            case .combined:
                VStack(alignment: .leading, spacing: 6) {
                    ActivityUsageSummary(state: state)
                    ActivityQuotaRows(state: state, compact: true)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }
}

// MARK: - Lock Screen

struct ActivityLockScreenView: View {
    let state: ActivityState
    let isStale: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                HStack(spacing: 6) {
                    ActivityMarkView(state: state, size: 16)
                    if let quota = state.quota {
                        Text(WidgetPresentation.displayName(for: quota.providerID))
                            .font(.caption.weight(.semibold))
                            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                        if let plan = quota.planLabel, !plan.isEmpty {
                            Text(plan)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                if !typeSize.isAccessibilitySize { Spacer(minLength: 4) }
                ActivityFreshnessLine(state: state, isStale: isStale)
            }
            switch state.layout.lockScreenStyle {
            case .quota:
                ActivityQuotaRows(state: state)
            case .usage:
                ActivityUsageSummary(state: state)
            case .combined:
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) {
                        ActivityUsageSummary(state: state)
                        ActivityQuotaRows(state: state)
                    }
                } else {
                    HStack(alignment: .top, spacing: 20) {
                        ActivityUsageSummary(state: state)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        ActivityQuotaRows(state: state, compact: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
