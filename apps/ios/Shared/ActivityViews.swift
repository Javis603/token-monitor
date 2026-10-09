import SwiftUI

// Shared Live Activity rendering, compiled into the app (Settings customizer)
// and the widget extension so both surfaces draw identical pixels. Every view
// is a pure function of `ActivityContext` — the pushed data plus the device's
// own layout — and never reads user defaults or the network itself.
//
// The surfaces speak the app's and desktop's language: monochrome marks, names
// and readings; vendor colour only on rings and meters; "99% left" and
// "Reset 1h 52m" exactly as the Limits screen writes them.

typealias ActivityState = TokenMonitorActivityAttributes.ContentState
typealias ActivitySource = LiveActivityLayout.Source

// MARK: - Context

struct ActivityContext {
    let state: ActivityState
    let layout: LiveActivityLayout
    let currencyCode: String
    let locale: Locale
    let isStale: Bool
    /// Pinned at construction so one render computes every countdown against
    /// the same instant.
    let now: Date

    init(
        state: ActivityState,
        layout: LiveActivityLayout,
        currencyCode: String = "USD",
        languageCode: String = "auto",
        isStale: Bool,
        now: Date = .now
    ) {
        self.state = state
        self.layout = layout
        self.currencyCode = currencyCode
        self.locale = Self.locale(for: languageCode)
        self.isStale = isStale
        self.now = now
    }

    init(state: ActivityState, preferences: TokenMonitorSharedPayload.Preferences, isStale: Bool, now: Date = .now) {
        self.init(
            state: state,
            layout: preferences.liveLayout,
            currencyCode: preferences.currencyCode ?? "USD",
            languageCode: preferences.languageCode ?? "auto",
            isStale: isStale,
            now: now
        )
    }

    private init(state: ActivityState, layout: LiveActivityLayout, currencyCode: String,
                 locale: Locale, isStale: Bool, now: Date) {
        self.state = state
        self.layout = layout
        self.currencyCode = currencyCode
        self.locale = locale
        self.isStale = isStale
        self.now = now
    }

    static func locale(for languageCode: String) -> Locale {
        switch languageCode {
        case "en": Locale(identifier: "en")
        case "zh-TW": Locale(identifier: "zh-Hant")
        case "zh-CN": Locale(identifier: "zh-Hans")
        case "ja": Locale(identifier: "ja")
        case "ko": Locale(identifier: "ko")
        default: .autoupdatingCurrent
        }
    }

    func with(_ change: (inout LiveActivityLayout) -> Void) -> ActivityContext {
        var layout = layout
        change(&layout)
        return ActivityContext(state: state, layout: layout, currencyCode: currencyCode,
                               locale: locale, isStale: isStale, now: now)
    }

    // MARK: Resolving sources

    /// One quota window from one record, as a source resolves it.
    struct Reading {
        let quota: ActivityState.Quota
        let window: ActivityState.Window
        let value: ActivitySource.Value
    }

    /// The desktop composer's window presets: primary prefers session, then
    /// daily, weekly and billing; secondary is the next metered window.
    static func window(in quota: ActivityState.Quota, _ selector: ActivitySource.Window) -> ActivityState.Window? {
        func kind(_ kind: String) -> ActivityState.Window? { quota.windows.first { $0.kind == kind } }
        let primary = kind("session") ?? kind("daily") ?? kind("weekly") ?? kind("billing") ?? quota.windows.first
        switch selector {
        case .primary: return primary
        case .secondary: return primary.flatMap { primary in quota.windows.first { $0 != primary } }
        case .session, .daily, .weekly, .billing: return kind(selector.rawValue)
        }
    }

    /// The provider a source points at: a named one, the most recently used
    /// tool, or nil for the lowest remaining across everything.
    func providerID(for source: ActivitySource) -> String? {
        source.providerID ?? (source.automatic == .recent ? state.recent?.client : nil)
    }

    /// Records are already ranked most constrained first, so the first match
    /// with the lowest remaining wins ties in the Hub's order.
    func reading(_ source: ActivitySource) -> Reading? {
        var candidates = state.quotas
        if let id = providerID(for: source) {
            let matches = candidates.filter { $0.providerID == id }
            // A recent tool without quota falls back to everything; a named
            // provider never silently becomes another one.
            if !matches.isEmpty || source.providerID != nil { candidates = matches }
        }
        if let key = source.accountKey {
            candidates = candidates.filter { $0.accountKey == key }
        }
        var best: (reading: Reading, remaining: Double)?
        for quota in candidates {
            guard let window = Self.window(in: quota, source.window) else { continue }
            let remaining = window.remainingPercent ?? .infinity
            if best == nil || remaining < best!.remaining {
                best = (Reading(quota: quota, window: window, value: source.value), remaining)
            }
        }
        return best?.reading
    }

    /// The selected window first, then the record's other windows.
    func windows(for reading: Reading) -> [ActivityState.Window] {
        [reading.window] + reading.quota.windows.filter { $0 != reading.window }
    }

    func usage(_ source: ActivitySource) -> ActivityState.PeriodUsage {
        if source.scope == .recent {
            guard let recent = state.recent else { return .init() }
            return source.period == .month ? recent.month : recent.today
        }
        return source.period == .month ? state.usage.month : state.usage.today
    }

    func tokensTitle(_ source: ActivitySource) -> LocalizedStringKey {
        source.period == .month ? "Tokens this month" : "Tokens today"
    }

    // MARK: Readings

    /// Remaining or used, 0…1, as the source asks.
    func fraction(_ window: ActivityState.Window?, _ value: ActivitySource.Value = .remaining) -> Double? {
        guard let remaining = window?.remainingPercent, remaining.isFinite else { return nil }
        let left = min(100, max(0, remaining)) / 100
        return value == .used ? 1 - left : left
    }

    func fraction(_ reading: Reading?) -> Double? {
        reading.flatMap { fraction($0.window, $0.value) }
    }

    /// "99%" — or the balance for credits windows.
    func percentText(_ window: ActivityState.Window?, _ value: ActivitySource.Value = .remaining) -> String {
        guard let window else { return "—" }
        if let amount = window.creditsAmount { return moneyText(amount, window) }
        guard let fraction = fraction(window, value) else { return "—" }
        return "\(Int((fraction * 100).rounded()))%"
    }

    /// "99% left" / "1% used", the Limits screen's reading — or the balance for credits windows.
    func valueText(_ window: ActivityState.Window?, _ value: ActivitySource.Value = .remaining) -> String {
        guard let window else { return "—" }
        if window.creditsAmount != nil { return percentText(window, value) }
        guard fraction(window, value) != nil else { return "—" }
        return "\(percentText(window, value)) \(value == .used ? "used" : "left")"
    }

    private func moneyText(_ amount: Double, _ window: ActivityState.Window) -> String {
        WidgetPresentation.currency(
            amount, sourceCode: window.creditsCurrency ?? currencyCode,
            displayCode: currencyCode, locale: locale, compact: true
        )
    }

    func resetText(_ window: ActivityState.Window?) -> String? {
        window?.resetsAt.map { ResetCountdown.text(to: $0, now: now) }
    }

    func exactTokensText(_ usage: ActivityState.PeriodUsage) -> String {
        guard let tokens = usage.tokens, tokens.isFinite, tokens >= 0 else { return "—" }
        return tokens.formatted(.number.precision(.fractionLength(0)).locale(locale))
    }

    func compactTokensText(_ usage: ActivityState.PeriodUsage) -> String {
        WidgetPresentation.tokens(usage.tokens ?? .nan, locale: locale)
    }

    func costText(_ usage: ActivityState.PeriodUsage, compact: Bool = false) -> String {
        guard let cost = usage.costUSD else { return "—" }
        return WidgetPresentation.currencyFromUSD(cost, displayCode: currencyCode, locale: locale, compact: compact)
    }

    func speedText(_ source: ActivitySource) -> String? {
        let usage = source.period == .month ? state.usage.month : state.usage.today
        guard let speed = usage.outputTPS, speed.isFinite, speed > 0 else { return nil }
        return speed.formatted(.number.precision(.fractionLength(0)).locale(locale))
    }

    /// Distinct providers in ranked order, for multi-provider layouts. Records
    /// without a window (a signed-out account) have nothing to show and are skipped.
    func distinctQuotas(limit: Int, leading: ActivityState.Quota? = nil) -> [ActivityState.Quota] {
        var result: [ActivityState.Quota] = leading.map { [$0] } ?? []
        for quota in state.quotas where result.count < limit && !quota.windows.isEmpty
            && !result.contains(where: { $0.providerID == quota.providerID }) {
            result.append(quota)
        }
        return result
    }
}

// MARK: - Formatting and colour

/// "1h 52m", "2d 21h", "42m" — the Limits screen's countdown, in its English
/// units so every surface reads the same.
enum ResetCountdown {
    static func text(to date: Date, now: Date = .now, locale: Locale = Locale(identifier: "en")) -> String {
        let seconds = date.timeIntervalSince(now)
        let language = Self.language(for: locale)
        guard seconds > 0 else {
            return switch language {
            case "zh-Hant": "現在"
            case "zh-Hans": "现在"
            case "ja": "今"
            case "ko": "지금"
            default: "Now"
            }
        }
        let totalMinutes = Int((seconds / 60).rounded())
        let days = totalMinutes / 1440
        let hours = (totalMinutes % 1440) / 60
        let minutes = totalMinutes % 60
        let units: (String, String, String) = switch language {
        case "zh-Hant": ("日", "小時", "分鐘")
        case "zh-Hans": ("天", "小时", "分钟")
        case "ja": ("日", "時間", "分")
        case "ko": ("일", "시간", "분")
        default: ("d", "h", "m")
        }
        if days > 0 { return "\(days)\(units.0) \(hours)\(units.1)" }
        if hours > 0 { return "\(hours)\(units.1) \(minutes)\(units.2)" }
        return minutes > 0 ? "\(minutes)\(units.2)" : "<1\(units.2)"
    }

    static func language(for locale: Locale) -> String {
        let identifier = locale.identifier.lowercased()
        if identifier.hasPrefix("zh") {
            return identifier.contains("hans") || identifier.contains("cn") || identifier.contains("sg")
                ? "zh-Hans" : "zh-Hant"
        }
        if identifier.hasPrefix("ja") { return "ja" }
        if identifier.hasPrefix("ko") { return "ko" }
        return "en"
    }
}

/// Vendor colour for rings and meters only — never marks, names or readings.
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

// MARK: - Marks and meters

/// A monochrome template glyph: the Token Monitor Σ, or a provider/client mark.
struct ActivityMark: View {
    /// nil draws the Token Monitor Σ.
    let providerID: String?
    var size: CGFloat = 16

    var body: some View {
        Image(providerID.map(WidgetPresentation.assetName(for:)) ?? "VendorTokenMonitor")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The desktop dock's ring: a vendor-tinted arc around a monochrome mark.
struct ActivityRing: View {
    let fraction: Double?
    let tint: Color
    /// nil draws the Token Monitor Σ.
    let providerID: String?
    var diameter: CGFloat = 22
    var markScale: CGFloat = 0.42

    var body: some View {
        let width = max(2.4, diameter * 0.12)
        ZStack {
            Circle().stroke(tint.opacity(0.28), lineWidth: width)
            if let fraction {
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(tint, style: StrokeStyle(lineWidth: width, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.65), value: fraction)
            }
            ActivityMark(providerID: providerID, size: diameter * markScale)
        }
        .padding(width / 2)
        .frame(width: diameter, height: diameter)
    }
}

/// A capsule meter on a tinted track, as on the Limits screen.
struct ActivityMeter: View {
    let fraction: Double?
    let tint: Color
    var height: CGFloat = 6

    var body: some View {
        Capsule()
            .fill(tint.opacity(0.25))
            .overlay(alignment: .leading) {
                if let fraction {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(tint)
                            .frame(width: max(height, fraction * proxy.size.width))
                    }
                }
            }
            .frame(height: height)
            .accessibilityHidden(true)
    }
}

// MARK: - Building blocks

/// Monochrome mark and provider name.
struct ActivityProviderName: View {
    let providerID: String?
    var font: Font = .subheadline.weight(.semibold)
    var markSize: CGFloat = 15

    var body: some View {
        HStack(spacing: 6) {
            ActivityMark(providerID: providerID, size: markSize)
            Text(verbatim: providerID.map { WidgetPresentation.displayName(for: $0) } ?? "Token Monitor")
                .font(font)
                .lineLimit(1)
        }
    }
}

/// One quota window as the desktop draws it: label and "99% left", the
/// meter, then "Reset 1h 52m".
struct ActivityWindowColumn: View {
    let context: ActivityContext
    let quota: ActivityState.Quota
    let window: ActivityState.Window
    let value: ActivitySource.Value

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: window.label)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text(verbatim: context.valueText(window, value))
                    .fontWeight(.semibold)
            }
            .font(.caption.monospacedDigit())
            .lineLimit(1)
            ActivityMeter(fraction: context.fraction(window, value), tint: ActivityPalette.quotaTint(quota.providerID))
            Text(verbatim: context.resetText(window).map { "Reset \($0)" } ?? " ")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The resolved window and the record's next one, side by side.
struct ActivityWindowColumns: View {
    let context: ActivityContext
    let reading: ActivityContext.Reading?

    var body: some View {
        if let reading {
            HStack(alignment: .top, spacing: 16) {
                ForEach(Array(context.windows(for: reading).prefix(2).enumerated()), id: \.offset) { _, window in
                    ActivityWindowColumn(context: context, quota: reading.quota, window: window, value: reading.value)
                }
            }
        } else {
            ActivityNoQuota()
        }
    }
}

struct ActivityNoQuota: View {
    var body: some View {
        Text("No quota windows available")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}

/// A small uppercase label, the desktop's "TOTAL TOKENS".
struct ActivityCaption: View {
    let title: LocalizedStringKey

    var body: some View {
        Text(title)
            .font(.caption2.weight(.medium))
            .textCase(.uppercase)
            .kerning(0.5)
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}

/// The stale chip, or a self-updating "1 minute ago".
struct ActivityFreshness: View {
    let context: ActivityContext

    var body: some View {
        if context.isStale {
            Text("Stale")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1.5)
                .background(Color.secondary.opacity(0.18), in: Capsule())
                .fixedSize()
        } else if context.state.updatedAt > .distantPast {
            Text(.currentDate, format: .reference(
                to: context.state.updatedAt, allowedFields: [.minute, .hour, .day], maxFieldCount: 1
            ).locale(context.locale))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .accessibilityLabel(Text("Updated"))
        }
    }
}

/// "● 2 running", shown only while sessions run.
struct ActivityRunningLabel: View {
    let agents: ActivityState.Agents

    var body: some View {
        if agents.running > 0 {
            HStack(spacing: 4) {
                Circle().fill(.green).frame(width: 6, height: 6)
                Text("\(agents.running) running")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
        }
    }
}

// MARK: - Compact and minimal

/// One compact slot. Content hugs its intrinsic size — no fixed frames — so
/// the island is only as wide as what the user chose to show.
struct ActivityCompactItemView: View {
    let context: ActivityContext
    let slot: LiveActivityLayout.Slot

    var body: some View {
        content
            .font(.system(size: 14, weight: .semibold).monospacedDigit())
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .opacity(context.isStale ? 0.5 : 1)
    }

    @ViewBuilder
    private var content: some View {
        let source = slot.source
        let reading = context.reading(source)
        switch slot.style {
        case .ring:
            ActivityRing(
                fraction: context.fraction(reading),
                tint: ActivityPalette.quotaTint(reading?.quota.providerID),
                providerID: reading?.quota.providerID,
                diameter: 22,
                markScale: 0.5
            )
            .accessibilityLabel(Text("AI limit"))
            .accessibilityValue(context.valueText(reading?.window, source.value))
        case .providerIcon:
            ActivityMark(providerID: context.providerID(for: source) ?? reading?.quota.providerID, size: 16)
        case .appIcon:
            ActivityMark(providerID: nil, size: 15)
        case .percent:
            if reading?.window.creditsAmount != nil {
                Text(verbatim: context.percentText(reading?.window, source.value))
            } else if let fraction = context.fraction(reading) {
                (Text(verbatim: "\(Int((fraction * 100).rounded()))")
                    + Text(verbatim: "%").font(.system(size: 10, weight: .semibold)).foregroundStyle(.white.opacity(0.7)))
                    .contentTransition(.numericText())
                    .accessibilityLabel(Text(verbatim: context.valueText(reading?.window, source.value)))
            } else {
                Text(verbatim: "—")
            }
        case .percentReset:
            VStack(alignment: .leading, spacing: -1) {
                Text(verbatim: context.percentText(reading?.window, source.value))
                    .font(.system(size: 12, weight: .semibold).monospacedDigit())
                Text(verbatim: context.resetText(reading?.window) ?? "—")
                    .font(.system(size: 9.5, weight: .medium).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        case .reset:
            Text(verbatim: context.resetText(reading?.window) ?? "—")
        case .tokens:
            Text(verbatim: context.compactTokensText(context.usage(source)))
                .contentTransition(.numericText())
        case .cost:
            Text(verbatim: context.costText(context.usage(source), compact: true))
        case .speed:
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(verbatim: context.speedText(source) ?? "—")
                Text(verbatim: "tps")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        case .agents:
            ActivityAgentsMark(agents: context.state.agents)
        case .none:
            EmptyView()
        }
    }
}

/// The most recent running client with a live dot, plus the count when more
/// than one session runs; a dimmed Σ while nothing runs.
struct ActivityAgentsMark: View {
    let agents: ActivityState.Agents

    var body: some View {
        if agents.running > 0 {
            HStack(spacing: 4) {
                ActivityMark(providerID: agents.clients.first, size: 16)
                Circle().fill(.green).frame(width: 5, height: 5)
                if agents.running > 1 {
                    Text(verbatim: agents.running.formatted())
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("\(agents.running) running"))
        } else {
            ActivityMark(providerID: nil, size: 15)
                .opacity(0.4)
                .accessibilityLabel(Text("No running sessions"))
        }
    }
}

struct ActivityMinimalView: View {
    let context: ActivityContext

    var body: some View {
        let source = context.layout.minimalSource
        let reading = context.reading(source)
        Group {
            switch context.layout.minimal {
            case .appRing, .ring:
                ActivityRing(
                    fraction: context.fraction(reading),
                    tint: context.layout.minimal == .appRing
                        ? .primary : ActivityPalette.quotaTint(reading?.quota.providerID),
                    providerID: context.layout.minimal == .appRing ? nil : reading?.quota.providerID,
                    diameter: 21
                )
            case .percent:
                Text(verbatim: context.fraction(reading).map { "\(Int(($0 * 100).rounded()))" } ?? "—")
                    .font(.system(size: 13, weight: .bold).monospacedDigit())
                    .minimumScaleFactor(0.7)
            case .providerIcon:
                ActivityMark(providerID: context.providerID(for: source) ?? reading?.quota.providerID, size: 16)
            }
        }
        .opacity(context.isStale ? 0.5 : 1)
        .accessibilityLabel(Text("AI limit"))
        .accessibilityValue(context.valueText(reading?.window, source.value))
    }
}

// MARK: - Expanded Dynamic Island

/// Leading region: beside the camera, so it holds only a short title.
struct ActivityExpandedLeading: View {
    let context: ActivityContext

    var body: some View {
        let source = context.layout.expandedSource
        Group {
            switch context.layout.expanded {
            case .quota:
                ActivityProviderName(providerID: context.reading(source)?.quota.providerID
                    ?? context.providerID(for: source))
            case .usage:
                if source.scope == .recent, let client = context.state.recent?.client {
                    ActivityProviderName(providerID: client, font: .caption.weight(.semibold), markSize: 13)
                } else {
                    ActivityCaption(title: context.tokensTitle(source))
                }
            case .providers:
                ActivityCaption(title: "AI limits")
            }
        }
        .padding(.leading, 6)
        .frame(maxHeight: .infinity)
    }
}

struct ActivityExpandedTrailing: View {
    let context: ActivityContext

    var body: some View {
        Group {
            switch context.layout.expanded {
            case .quota:
                if context.isStale {
                    ActivityFreshness(context: context)
                } else if let plan = context.reading(context.layout.expandedSource)?.quota.planLabel, !plan.isEmpty {
                    Text(verbatim: plan)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            case .usage:
                if context.state.agents.running > 0 {
                    ActivityRunningLabel(agents: context.state.agents)
                } else {
                    ActivityFreshness(context: context)
                }
            case .providers:
                ActivityFreshness(context: context)
            }
        }
        .padding(.trailing, 6)
        .frame(maxHeight: .infinity)
    }
}

struct ActivityExpandedBottom: View {
    let context: ActivityContext

    var body: some View {
        let source = context.layout.expandedSource
        Group {
            switch context.layout.expanded {
            case .quota:
                ActivityWindowColumns(context: context, reading: context.reading(source))
            case .usage:
                usage(source)
            case .providers:
                ActivityProviderList(context: context, value: source.value)
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 4)
    }

    private func usage(_ source: ActivitySource) -> some View {
        let usage = context.usage(source)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: context.exactTokensText(usage))
                    .font(.system(size: 30, weight: .semibold).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Spacer(minLength: 8)
                Text(verbatim: context.costText(usage))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let reading = context.reading(source) {
                HStack(spacing: 6) {
                    ActivityMark(providerID: reading.quota.providerID, size: 12)
                    Text(verbatim: reading.window.label)
                    Text(verbatim: context.percentText(reading.window, reading.value)).fontWeight(.semibold)
                    Spacer(minLength: 6)
                    if let reset = context.resetText(reading.window) {
                        Text(verbatim: "Reset \(reset)").foregroundStyle(.secondary)
                    }
                }
                .font(.caption.monospacedDigit())
                .lineLimit(1)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// Up to three providers, each with their first two windows as thin meters.
struct ActivityProviderList: View {
    let context: ActivityContext
    let value: ActivitySource.Value

    var body: some View {
        let quotas = context.distinctQuotas(limit: 3)
        if quotas.isEmpty {
            ActivityNoQuota()
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(quotas.enumerated()), id: \.offset) { _, quota in
                    HStack(alignment: .center, spacing: 12) {
                        ActivityProviderName(providerID: quota.providerID, font: .caption.weight(.semibold), markSize: 13)
                            .frame(width: 84, alignment: .leading)
                        ForEach(Array(quota.windows.prefix(2).enumerated()), id: \.offset) { _, window in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 4) {
                                    Text(verbatim: window.label).foregroundStyle(.secondary)
                                    Text(verbatim: context.percentText(window, value)).fontWeight(.semibold)
                                }
                                .font(.caption2.monospacedDigit())
                                .lineLimit(1)
                                ActivityMeter(fraction: context.fraction(window, value),
                                              tint: ActivityPalette.quotaTint(quota.providerID), height: 4)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if quota.windows.count < 2 {
                            Spacer(minLength: 0).frame(maxWidth: .infinity)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// The in-app stand-in for the system's expanded layout: the leading and
/// trailing regions flank the camera, the bottom region spans the width.
struct ActivityExpandedPreview: View {
    let context: ActivityContext

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                ActivityExpandedLeading(context: context)
                Spacer(minLength: 120)
                ActivityExpandedTrailing(context: context)
            }
            .frame(height: 30)
            ActivityExpandedBottom(context: context)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 16)
    }
}

// MARK: - Lock Screen

struct ActivityLockScreenView: View {
    let context: ActivityContext
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            switch context.layout.lockScreen {
            case .overview: overview
            case .quota: quota
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    /// The iOS medium widget: the period's tokens beside the leading providers.
    private var overview: some View {
        let source = context.layout.lockScreenSource
        let usage = context.usage(source)
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 16))
        return layout {
            VStack(alignment: .leading, spacing: 2) {
                if source.scope == .recent, let client = context.state.recent?.client {
                    ActivityProviderName(providerID: client, font: .caption2.weight(.semibold), markSize: 11)
                } else {
                    ActivityCaption(title: context.tokensTitle(source))
                }
                Text(verbatim: context.exactTokensText(usage))
                    .font(.system(size: 24, weight: .semibold).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                HStack(spacing: 8) {
                    Text(verbatim: context.costText(usage))
                        .foregroundStyle(.secondary)
                    ActivityRunningLabel(agents: context.state.agents)
                }
                .font(.footnote.monospacedDigit())
                .lineLimit(1)
                if context.isStale { ActivityFreshness(context: context) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                let quotas = context.distinctQuotas(limit: 2, leading: context.reading(source)?.quota)
                if quotas.isEmpty { ActivityNoQuota() }
                ForEach(Array(quotas.enumerated()), id: \.offset) { _, quota in
                    VStack(alignment: .leading, spacing: 1) {
                        ActivityProviderName(providerID: quota.providerID, font: .footnote.weight(.semibold), markSize: 12)
                        ForEach(Array(quota.windows.prefix(2).enumerated()), id: \.offset) { _, window in
                            HStack(spacing: 4) {
                                Text(verbatim: "\(window.label) \(context.percentText(window, source.value))")
                                Spacer(minLength: 6)
                                if let reset = context.resetText(window) {
                                    Text(verbatim: reset).foregroundStyle(.secondary)
                                }
                            }
                            .font(.caption.monospacedDigit())
                            .lineLimit(1)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The desktop Limits card: provider, freshness and the chosen windows.
    private var quota: some View {
        let reading = context.reading(context.layout.lockScreenSource)
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                ActivityProviderName(providerID: reading?.quota.providerID)
                if let plan = reading?.quota.planLabel, !plan.isEmpty {
                    Text(verbatim: plan)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                ActivityFreshness(context: context)
            }
            ActivityWindowColumns(context: context, reading: reading)
        }
    }
}
