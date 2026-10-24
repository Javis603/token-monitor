import Foundation

/// Matches the desktop's opt-in, complete-account total. This is a display
/// window; it never replaces the Hub accounts or their accounting identities.
nonisolated enum WorkBuddyQuotaTotal {
    static func window(for providers: [LimitProvider]) -> LimitWindow? {
        guard providers.count > 1 else { return nil }
        let keys = providers.map { $0.accountKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        guard keys.allSatisfy({ !$0.isEmpty }), Set(keys).count == providers.count,
              let first = providers.first, let reference = first.windows?.first else { return nil }

        var used = 0.0
        var remaining = 0.0
        var limit = 0.0
        for provider in providers {
            guard provider.normalizedProviderID == "workbuddy", provider.status == "ok",
                  provider.stale != true, provider.actionRequired?.isEmpty != false,
                  provider.region == first.region, provider.windows?.count == 1,
                  let window = provider.windows?.first,
                  window.isCredits, window.currency == "CREDITS", window.detail != "unlimited",
                  sameEntitlement(window, reference),
                  let windowUsed = window.used, windowUsed.isFinite, windowUsed >= 0,
                  let windowRemaining = window.remaining, windowRemaining.isFinite, windowRemaining >= 0,
                  let windowLimit = window.limit, windowLimit.isFinite, windowLimit > 0,
                  windowUsed <= windowLimit, windowRemaining <= windowLimit else { return nil }
            used += windowUsed
            remaining += windowRemaining
            limit += windowLimit
        }
        let usedPercent = used / limit * 100
        let remainingPercent = remaining / limit * 100
        guard [used, remaining, limit, usedPercent, remainingPercent].allSatisfy(\.isFinite) else { return nil }
        var total = reference
        total.used = used
        total.remaining = remaining
        total.limit = limit
        total.usedPercent = usedPercent
        total.remainingPercent = remainingPercent
        return total
    }

    private static func sameEntitlement(_ left: LimitWindow, _ right: LimitWindow) -> Bool {
        left.kind == right.kind && left.metric == right.metric && left.label == right.label
            && left.source == right.source && left.limitId == right.limitId
            && left.boundaryKind == right.boundaryKind && left.additional == right.additional
            && left.resetsAt == right.resetsAt && left.windowMinutes == right.windowMinutes
            && left.resetDescription == right.resetDescription && left.detail == right.detail
            && left.currency == right.currency && left.showMeter == right.showMeter
    }
}
