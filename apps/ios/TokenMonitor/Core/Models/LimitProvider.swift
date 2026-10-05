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

    var accountTitle: String {
        if let accountEmail, !accountEmail.isEmpty {
            return accountEmail
        }
        if let accountName, !accountName.isEmpty {
            return accountName
        }
        if workspaceKind == "personal" {
            return "Personal"
        }
        return ProviderPresentation.displayName(for: provider)
    }

    var secondaryTitle: String? {
        let plan = planLabel ?? accountLabel
        guard let plan, !plan.isEmpty, plan != accountTitle else {
            return nil
        }
        return plan
    }

    var lowestRemainingPercent: Double? {
        displayWindows.compactMap(remainingPercent(for:)).min()
    }

    var displayWindows: [LimitWindow] {
        (windows ?? []).filter { window in
            window.isCredits
                || window.effectiveRemainingPercent != nil
                || window.remaining != nil
                || window.used != nil
                || !(window.detail ?? "").isEmpty
        }
    }

    func remainingPercent(for window: LimitWindow) -> Double? {
        guard window.isCredits else {
            return window.effectiveRemainingPercent
        }
        if let percent = window.effectiveRemainingPercent {
            return percent
        }
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
}
