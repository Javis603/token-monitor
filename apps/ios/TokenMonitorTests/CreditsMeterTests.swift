import Foundation
import Testing
@testable import TokenMonitor

struct CreditsMeterTests {
    @Test
    func derivesTopUpBalanceMeterFromCurrentFundsAndMonthSpend() {
        let window = LimitWindow(
            kind: "billing",
            metric: "credits",
            label: "Balance",
            used: nil,
            limit: nil,
            remaining: 80,
            usedPercent: nil,
            remainingPercent: nil,
            resetsAt: nil,
            resetDescription: nil,
            detail: nil,
            currency: "USD",
            showMeter: true
        )
        let provider = LimitProvider(
            provider: "openrouter",
            accountKey: "sample",
            accountLabel: nil,
            planLabel: nil,
            accountName: nil,
            accountEmail: nil,
            workspaceKind: nil,
            status: "ok",
            source: "api",
            sourceDetail: nil,
            updatedAt: nil,
            windows: [window],
            balanceUsd: nil,
            balance: ProviderBalance(
                amount: 80,
                currency: "USD",
                todaySpend: 2,
                weekSpend: 8,
                monthSpend: 20,
                allTimeSpend: 120,
                expiresAt: nil,
                giftBalance: nil,
                cashBalance: nil,
                planUsed: nil,
                planLimit: nil,
                planPercent: nil,
                planStatus: nil
            ),
            sourceDeviceId: "macbook",
            stale: false
        )

        #expect(provider.remainingPercent(for: window) == 80)
    }
}
