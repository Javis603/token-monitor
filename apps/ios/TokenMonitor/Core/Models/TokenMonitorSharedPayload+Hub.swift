import Foundation

extension TokenMonitorSharedPayload.Snapshot {
    static func make(
        stats: HubStats,
        history: UsageHistory
    ) -> TokenMonitorSharedPayload.Snapshot {
        TokenMonitorSharedPayload.Snapshot(
            updatedAt: Date.hubTimestamp(from: stats.updatedAt) ?? .now,
            today: usage(from: stats.period(.today)),
            month: usage(from: stats.period(.month)),
            allTime: usage(from: stats.period(.allTime)),
            limits: limits(from: stats.sortedLimits),
            activity: (history.daily ?? []).compactMap { day in
                guard let date = day.date else {
                    return nil
                }
                return TokenMonitorSharedPayload.Day(
                    date: date,
                    tokens: day.tokens ?? 0,
                    cost: day.cost ?? 0
                )
            }
        )
    }

    private static func usage(
        from period: UsagePeriod
    ) -> TokenMonitorSharedPayload.Usage {
        TokenMonitorSharedPayload.Usage(
            tokens: period.totalTokens ?? 0,
            cost: period.costUsd ?? 0,
            cacheReadTokens: period.cacheReadTokens ?? 0,
            outputTokens: period.outputTokens ?? 0,
            tools: period.clientEntries.prefix(5).map {
                TokenMonitorSharedPayload.Breakdown(id: $0.id, value: $0.value)
            },
            models: period.modelEntries.prefix(5).map {
                TokenMonitorSharedPayload.Breakdown(id: $0.id, value: $0.value)
            }
        )
    }

    private static func limits(
        from providers: [LimitProvider]
    ) -> [TokenMonitorSharedPayload.Limit] {
        providers.enumerated().compactMap { index, provider in
            guard let providerID = provider.provider?.lowercased(),
                  !providerID.isEmpty else {
                return nil
            }
            let windows = provider.displayWindows.prefix(4).enumerated().map {
                windowIndex,
                window in
                TokenMonitorSharedPayload.LimitWindow(
                    id: "\(window.kind ?? "quota")-\(windowIndex)",
                    label: window.label ?? window.kind?.capitalized ?? "Quota",
                    remainingPercent: provider.remainingPercent(for: window),
                    amount: window.isCredits
                        ? window.remaining ?? provider.balance?.amount
                        : nil,
                    currency: window.currency ?? provider.balance?.currency,
                    resetAt: Date.hubTimestamp(from: window.resetsAt)
                )
            }
            return TokenMonitorSharedPayload.Limit(
                id: "\(providerID)-\(index)",
                providerID: providerID,
                updatedAt: Date.hubTimestamp(from: provider.updatedAt),
                windows: windows
            )
        }
    }
}
