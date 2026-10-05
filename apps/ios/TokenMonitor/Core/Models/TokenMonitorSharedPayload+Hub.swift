import Foundation

extension TokenMonitorSharedPayload.Snapshot {
    static func make(
        stats: HubStats,
        history: UsageHistory,
        now: Date = .now,
        limitProviderOrder: [String] = [],
        hiddenLimitProviders: Set<String> = []
    ) -> TokenMonitorSharedPayload.Snapshot {
        let orderedLimits = LimitProviderOrder.ordered(
            stats.limits?.providers ?? [],
            order: limitProviderOrder,
            hidden: hiddenLimitProviders
        )
        return TokenMonitorSharedPayload.Snapshot(
            updatedAt: stats.sourceUpdatedAt(now: now) ?? .distantPast,
            today: usage(from: stats.period(.today)),
            month: usage(from: stats.period(.month)),
            allTime: usage(from: stats.period(.allTime)),
            limits: limits(from: orderedLimits, now: now),
            activity: (history.daily ?? []).compactMap { day in
                guard let date = day.date else {
                    return nil
                }
                return TokenMonitorSharedPayload.Day(
                    date: date,
                    tokens: day.tokens ?? .nan,
                    cost: day.cost ?? .nan
                )
            },
            sourceStale: stats.allSourcesStale
        )
    }

    private static func usage(
        from period: UsagePeriod
    ) -> TokenMonitorSharedPayload.Usage {
        TokenMonitorSharedPayload.Usage(
            tokens: period.totalTokens ?? .nan,
            cost: period.costUsd ?? .nan,
            cacheReadTokens: period.cacheReadTokens ?? .nan,
            outputTokens: period.outputTokens ?? .nan,
            tools: period.clientEntries.prefix(5).map {
                TokenMonitorSharedPayload.Breakdown(id: $0.id, value: $0.value)
            },
            models: period.modelEntries.prefix(5).map {
                TokenMonitorSharedPayload.Breakdown(id: $0.id, value: $0.value)
            },
            tokensKnown: period.totalTokens != nil,
            costKnown: period.costUsd != nil,
            tokenComponentsKnown: period.capabilities?.tokenComponents,
            throughputKnown: period.capabilities?.throughput,
            unclassifiedTokens: period.unclassifiedTokens
        )
    }

    private static func limits(
        from providers: [LimitProvider],
        now: Date
    ) -> [TokenMonitorSharedPayload.Limit] {
        providers.enumerated().compactMap { index, provider in
            guard let providerID = provider.provider?.lowercased(),
                  !providerID.isEmpty else {
                return nil
            }
            // Live Activity quota + widgets share canonical lanes only; promo
            // windows marked `additional` never leave the Hub payload.
            let windows = provider.displayWindows
                .filter { $0.additional != true }
                .prefix(4)
                .enumerated()
                .map { windowIndex, window in
                    TokenMonitorSharedPayload.LimitWindow(
                        id: "\(window.kind ?? "quota")-\(windowIndex)",
                        label: window.displayLabel(providerID: provider.provider),
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
                planLabel: provider.secondaryTitle,
                status: provider.status,
                updatedAt: Date.hubTimestamp(from: provider.updatedAt).flatMap { $0 <= now ? $0 : nil },
                windows: windows,
                sourceStale: provider.stale
            )
        }
    }
}
