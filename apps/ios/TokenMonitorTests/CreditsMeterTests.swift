import Foundation
import Testing
@testable import TokenMonitor

struct CreditsMeterTests {
    @Test func ollamaIncludedCreditsRetainMeterButWalletsHaveNoInferredQuota() throws {
        let provider = try JSONDecoder().decode(LimitProvider.self, from: Data(#"{"provider":"ollama","balance":{"amount":20,"currency":"USD","monthSpend":80},"windows":[{"kind":"billing","metric":"credits","label":"Included credits","remaining":5,"remainingPercent":25,"showMeter":true},{"kind":"billing","metric":"credits","label":"Credit balance","remaining":20,"showMeter":false}]}"#.utf8))
        let windows = try #require(provider.windows)
        #expect(provider.remainingPercent(for: windows[0]) == 25)
        #expect(provider.remainingPercent(for: windows[1]) == nil)
        let stats = try JSONDecoder().decode(HubStats.self, from: Data(#"{"limits":{"providers":[{"provider":"ollama","balance":{"amount":20,"monthSpend":80},"windows":[{"metric":"credits","remaining":20,"showMeter":false}]}]}}"#.utf8))
        let projected = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty)
        #expect(projected.limits.first?.windows.first?.remainingPercent == nil)
        #expect(projected.limits.first?.windows.first?.amount == 20)
        let sub2api = try JSONDecoder().decode(LimitProvider.self, from: Data(#"{"provider":"thirdparty","balance":{"amount":20,"monthSpend":80},"windows":[{"metric":"credits","remaining":20,"showMeter":false}]}"#.utf8))
        #expect(sub2api.remainingPercent(for: try #require(sub2api.windows?.first)) == 20)
    }

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

    private func account(_ key: String, patch: [String: Any] = [:], windowPatch: [String: Any] = [:]) throws -> LimitProvider {
        var window: [String: Any] = ["kind": "billing", "metric": "credits", "currency": "CREDITS", "label": "Credits", "used": 20, "remaining": 80, "limit": 100, "resetsAt": "2026-11-01T00:00:00Z"]
        window.merge(windowPatch) { _, new in new }
        var value: [String: Any] = ["provider": "workbuddy", "accountKey": key, "status": "ok", "region": "cn", "windows": [window]]
        value.merge(patch) { _, new in new }
        return try JSONDecoder().decode(LimitProvider.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func combinesCompleteMatchingAccountsWithoutChangingReadings() throws {
        let first = try account("first")
        let second = try account("second", windowPatch: ["used": 0, "remaining": 50, "limit": 50])
        let total = try #require(WorkBuddyQuotaTotal.window(for: [first, second]))
        #expect(total.used == 20)
        #expect(total.remaining == 130)
        #expect(total.limit == 150)
        #expect(abs(try #require(total.remainingPercent) - 130.0 / 150 * 100) < 0.0001)
        #expect(first.windows?.first?.remaining == 80)
        #expect(WorkBuddyQuotaTotal.window(for: [first]) == nil)
        #expect(WorkBuddyQuotaTotal.window(for: [first, first]) == nil)
    }

    @Test func incompleteOrIncompatibleAccountsNeverProducePartialTotals() throws {
        let first = try account("first")
        for patch: [String: Any] in [["status": "unauthorized"], ["stale": true], ["actionRequired": "appSessionEncrypted"], ["region": "ai"], ["accountKey": ""], ["windows": []]] {
            #expect(WorkBuddyQuotaTotal.window(for: [first, try account("second", patch: patch)]) == nil)
        }
        for patch: [String: Any] in [["limit": NSNull()], ["limit": 0], ["used": NSNull()], ["remaining": NSNull()], ["remaining": 101], ["detail": "unlimited"], ["currency": "USD"], ["resetsAt": "2026-12-01T00:00:00Z"], ["limitId": "other"], ["boundaryKind": "expiry"], ["source": "other"]] {
            #expect(WorkBuddyQuotaTotal.window(for: [first, try account("second", windowPatch: patch)]) == nil)
        }
    }
}
