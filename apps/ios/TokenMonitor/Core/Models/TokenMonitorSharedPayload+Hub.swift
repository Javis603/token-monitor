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
            sourceStale: stats.allSourcesStale,
            agents: agents(from: stats, now: now),
            recent: recent(from: stats)
        )
    }

    /// The most recently used client — the desktop's "most recently active
    /// tool" — with its own share of each period, as the Hub pushes it.
    private static func recent(from stats: HubStats) -> TokenMonitorActivityAttributes.ContentState.Recent? {
        var seen = Set<String>()
        var latest: (client: String, at: Date)?
        for key in [UsagePeriodKey.today, .month] {
            for (id, session) in stats.period(key).sessions ?? [:] where seen.insert(id).inserted {
                guard let client = session.client?.lowercased(), !client.isEmpty,
                      let at = Date.hubTimestamp(from: session.lastUsedAt) else { continue }
                if latest.map({ at > $0.at }) ?? true { latest = (client, at) }
            }
        }
        guard let client = latest?.client else { return nil }
        func share(_ key: UsagePeriodKey) -> TokenMonitorActivityAttributes.ContentState.PeriodUsage {
            let period = stats.period(key)
            return .init(tokens: period.clients?[client], costUSD: period.clientCosts?[client])
        }
        return .init(client: client, today: share(.today), month: share(.month))
    }

    /// Running sessions under the same rule the Hub pushes: today and month
    /// detail merged by session key, newest first.
    private static func agents(
        from stats: HubStats,
        now: Date
    ) -> TokenMonitorActivityAttributes.ContentState.Agents {
        var seen = Set<String>()
        var running: [(client: String?, last: Date)] = []
        for key in [UsagePeriodKey.today, .month] {
            for (id, session) in stats.period(key).sessions ?? [:] where seen.insert(id).inserted {
                guard session.isRunning(at: now) else { continue }
                running.append((session.client?.lowercased(), session.lastActivity ?? .distantPast))
            }
        }
        running.sort { $0.last > $1.last }
        var clients: [String] = []
        for client in running.compactMap(\.client) where !clients.contains(client) {
            clients.append(client)
        }
        return .init(running: running.count, clients: Array(clients.prefix(3)))
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
            unclassifiedTokens: period.unclassifiedTokens,
            outputTokensPerSecond: period.averageOutputTokensPerSecond
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
                        resetAt: Date.hubTimestamp(from: window.resetsAt),
                        windowMinutes: window.windowMinutes.flatMap { $0 > 0 ? $0 : nil },
                        kind: window.kind?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    )
                }
            return TokenMonitorSharedPayload.Limit(
                id: "\(providerID)-\(index)",
                providerID: providerID,
                planLabel: provider.secondaryTitle,
                status: provider.status,
                updatedAt: Date.hubTimestamp(from: provider.updatedAt).flatMap { $0 <= now ? $0 : nil },
                windows: windows,
                sourceStale: provider.stale,
                accountKey: provider.accountKey?.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
    }
}
