import Foundation

nonisolated struct LimitProvider: Decodable, Identifiable, Sendable {
    let provider: String?
    let accountKey: String?
    let accountLabel: String?
    let planLabel: String?
    let accountName: String?
    let accountEmail: String?
    let workspaceKind: String?
    let status: String?
    let source: String?
    let sourceDetail: String?
    let updatedAt: String?
    let windows: [LimitWindow]?
    let balanceUsd: Double?
    let balance: ProviderBalance?
    let sourceDeviceId: String?
    let stale: Bool?
    var resetCredits: ProviderResetCredits? = nil
    var actionRequired: String? = nil
    var region: String? = nil

    var id: String {
        [
            provider,
            accountKey,
            accountEmail,
            accountName,
            sourceDeviceId
        ]
        .compactMap { $0 }
        .joined(separator: ":")
    }

    /// The provider id normalized the way grouping and ordering normalize it.
    var normalizedProviderID: String {
        LimitProviderOrder.normalizedID(provider)
    }

    var accountTitle: String {
        accountTitle(maskingEmails: false)
    }

    func accountTitle(maskingEmails masked: Bool) -> String {
        if let accountEmail, !accountEmail.isEmpty {
            return masked ? AccountIdentity.maskEmailAddress(accountEmail) : accountEmail
        }
        if let accountName, !accountName.isEmpty {
            return accountName
        }
        if workspaceKind == "personal" {
            return "Personal"
        }
        return ProviderPresentation.displayName(for: provider)
    }

    /// Plan or trailing label: an empty wire string counts as absent, matching
    /// the desktop `planLabel || accountLabel` fallback.
    var secondaryTitle: String? {
        let plan = Self.nonEmpty(planLabel) ?? Self.nonEmpty(accountLabel)
        guard let plan, plan != accountTitle else {
            return nil
        }
        return plan
    }

    /// What the trailing "plan" cell shows — a status beats a plan for an
    /// unhealthy provider, mirroring desktop `limitProviderPlan`.
    enum PlanCell: Equatable, Sendable {
        case plan(String)
        /// Value is a Localizable.xcstrings key.
        case status(String)
    }

    var planCell: PlanCell? {
        let unhealthy = status != nil && status != "ok"
        if unhealthy && stale != true {
            return .status(statusLabelKey)
        }
        if let plan = secondaryTitle {
            return .plan(planDisplayLabel(plan))
        }
        if unhealthy {
            return .status(statusLabelKey)
        }
        return nil
    }

    /// Healthy when the wire status is absent or `ok`.
    var isHealthy: Bool {
        status == nil || status == "ok"
    }

    /// Desktop only shows the updated/stale meta line when the provider is ok
    /// or flagged stale — a plain error state shows the status label alone.
    var showsFreshnessLine: Bool {
        isHealthy || stale == true
    }

    /// Desktop `limitStatusLabel`; the wire statuses are camelCase.
    var statusLabelKey: String {
        if normalizedProviderID == "workbuddy", actionRequired == "appSessionEncrypted" {
            return "Encrypted by app"
        }
        return switch status {
        case "ok": "Live"
        case "disabled": "Disabled"
        case "notConfigured": "Not signed in"
        case "noSyncedData": "No synced data"
        case "unauthorized": "Sign in again"
        case "rateLimited": "Limited"
        case "sourceRateLimited": "Usage API limited"
        case "unavailable": "Unavailable"
        default: "Error"
        }
    }

    var lowestRemainingPercent: Double? {
        displayWindows.compactMap(remainingPercent(for:)).min()
    }

    var displayWindows: [LimitWindow] {
        // A supplied window with unknown usage still has a label/reset to show.
        windows ?? []
    }

    func remainingPercent(for window: LimitWindow) -> Double? {
        guard window.isCredits else {
            return window.effectiveRemainingPercent
        }
        if let percent = window.effectiveRemainingPercent {
            return percent
        }
        // Wallet credits have no quota denominator. Keep existing
        // inferred top-up meters for other balance providers (e.g. Sub2API).
        if ["ollama", "mistral"].contains(normalizedProviderID), window.showMeter == false { return nil }
        let amount = window.remaining ?? balance?.amount
        guard let amount else {
            return nil
        }
        let funds = max(0, amount)
        if funds == 0 {
            return 0
        }
        let spend = max(0, balance?.monthSpend ?? 0)
        return min(100, max(0, funds / (funds + spend) * 100))
    }

    func windowDetail(for window: LimitWindow) -> String? {
        let currency = window.currency ?? balance?.currency ?? "USD"
        if normalizedProviderID == "minimax", window.kind == "weekly", window.label == "Video",
           let used = window.used, let limit = window.limit {
            return "\(max(0, limit - used).formatted(.number.precision(.fractionLength(0...2)))) / \(limit.formatted(.number.precision(.fractionLength(0...2))))"
        }
        guard window.kind == "billing", let limit = window.limit, limit > 0 else { return nil }
        let amount: Double?
        switch normalizedProviderID {
        case "commandcode": amount = window.remaining
        case "zed": amount = window.limitId == "zed.edit-predictions" ? nil : window.used
        case "mistral": amount = window.isCredits ? nil : window.used.map { max(0, limit - $0) }
        default: amount = nil
        }
        guard let amount else { return nil }
        return "\(MetricFormatter.currency(amount, code: currency)) / \(MetricFormatter.currency(limit, code: currency))"
    }

    /// Desktop `limitProviderPlanDisplayLabel`: capitalize, and drop the
    /// provider name when a plan repeats it (GLM Coding Pro → Pro, Zed Pro → Pro).
    private func planDisplayLabel(_ value: String) -> String {
        var label = value
        if let first = label.first, first.isLetter, first.isLowercase {
            label = first.uppercased() + label.dropFirst()
        }
        let providerID = normalizedProviderID
        if providerID == "zai",
           let range = label.range(
               of: #"^GLM\s+Coding\s+"#,
               options: [.regularExpression, .caseInsensitive]
           ) {
            let trimmed = label.replacingCharacters(in: range, with: "")
                .trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? label : trimmed
        }
        if providerID == "zed",
           let range = label.range(
               of: #"^Zed\s+"#,
               options: [.regularExpression, .caseInsensitive]
           ) {
            let trimmed = label.replacingCharacters(in: range, with: "")
                .trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? label : trimmed
        }
        return label
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
