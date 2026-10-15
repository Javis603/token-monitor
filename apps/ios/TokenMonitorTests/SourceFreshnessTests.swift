import Foundation
import Testing
@testable import TokenMonitor

struct SourceFreshnessTests {
    private func decode(_ json: String) throws -> HubStats {
        try JSONDecoder().decode(HubStats.self, from: Data(json.utf8))
    }

    @Test func sourceTimestampWinsOverTransportAndIgnoresFutureSources() throws {
        let now = try #require(Date.hubTimestamp(from: "2026-10-05T00:00:00Z"))
        let stats = try decode(#"{"updatedAt":"2026-10-05T00:00:00Z","devices":[{"updatedAt":"2026-10-01T00:00:00Z","stale":true},{"updatedAt":"2026-10-03T00:00:00Z","stale":true},{"updatedAt":"2099-01-01T00:00:00Z","stale":true}]}"#)
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty, now: now)
        #expect(snapshot.updatedAt == Date.hubTimestamp(from: "2026-10-03T00:00:00Z"))
        #expect(snapshot.sourceStale == true)
        #expect(try decode(#"{"updatedAt":"2026-10-05T00:00:00Z","devices":[{"updatedAt":"bad"}]}"#).sourceUpdatedAt(now: now) == nil)
        #expect(try decode(#"{"updatedAt":"2026-10-03T00:00:00Z"}"#).sourceUpdatedAt(now: now) == snapshot.updatedAt)
        #expect(TokenMonitorSharedPayload.Snapshot.make(stats: try decode("{}"), history: .empty).updatedAt == .distantPast)
    }

    @Test func unknownUsageSurvivesJSONRoundTripAndReportedZeroStaysZero() throws {
        let stats = try decode(#"{"periods":{"today":{"totalTokens":0,"costUsd":0,"capabilities":{"tokenComponents":false,"throughput":false},"unclassifiedTokens":12}}}"#)
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty)
        let loaded = try JSONDecoder().decode(TokenMonitorSharedPayload.Snapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(loaded == snapshot)
        #expect(loaded.today.tokens == 0)
        #expect(loaded.today.cost == 0)
        #expect(!loaded.month.tokens.isFinite)
        #expect(!loaded.allTime.cost.isFinite)
        #expect(loaded.month.tokensKnown == false)
        #expect(loaded.today.tokenComponentsKnown == false)
        #expect(loaded.today.throughputKnown == false)
        #expect(loaded.today.unclassifiedTokens == 12)
        #expect(stats.period(.month).totalTokens == nil)
        let legacy = try JSONDecoder().decode(TokenMonitorSharedPayload.Usage.self,
            from: Data(#"{"tokens":0,"cost":0,"cacheReadTokens":0,"outputTokens":0,"tools":[],"models":[]}"#.utf8))
        #expect(legacy.tokens == 0)
        #expect(legacy.tokensKnown == nil)
    }

    @Test func windowLabelsMatchCurrentProviderConventionsAndIdentityIgnoresReset() throws {
        func window(_ json: String) throws -> LimitWindow {
            try JSONDecoder().decode(LimitWindow.self, from: Data(json.utf8))
        }
        let session = try window(#"{"kind":"session","label":" "}"#)
        #expect(session.displayLabel(providerID: "commandcode") == "5-hour")
        #expect(session.displayLabel(providerID: "codex") == "Session")
        #expect(try window(#"{"kind":"billing"}"#).displayLabel(providerID: nil) == "Monthly")
        #expect(try window(#"{"kind":"weekly","label":" Fable "}"#).displayLabel(providerID: nil) == "Fable")
        #expect(try window(#"{"kind":"weekly","resetsAt":"a"}"#).id == window(#"{"kind":"weekly","resetsAt":"b"}"#).id)
    }

    @Test func providerStaleAndUnknownHistorySurviveSnapshotRoundTrip() throws {
        let now = try #require(Date.hubTimestamp(from: "2026-10-05T00:00:00Z"))
        let stats = try decode(#"{"limits":{"providers":[{"provider":"codex","updatedAt":"2026-10-05T00:00:00Z","stale":true,"windows":[{"kind":"weekly","remainingPercent":80}]},{"provider":"claude","updatedAt":"2099-01-01T00:00:00Z"}]}}"#)
        let history = try JSONDecoder().decode(UsageHistory.self, from: Data(#"{"daily":[{"date":"2026-10-01"},{"date":"2026-10-02","tokens":0,"cost":0}]}"#.utf8))
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: history, now: now)
        let loaded = try JSONDecoder().decode(TokenMonitorSharedPayload.Snapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(loaded == snapshot)
        #expect(loaded.limits.first(where: { $0.providerID == "codex" })?.sourceStale == true)
        #expect(loaded.limits.first(where: { $0.providerID == "claude" })?.updatedAt == nil)
        #expect(loaded.activity.first?.tokens.isNaN == true)
        #expect(loaded.activity.first?.cost.isNaN == true)
        #expect(loaded.activity.last?.tokens == 0)
        #expect(loaded.activity.last?.cost == 0)
    }

    #if os(iOS)
    @Test func activityContentPreservesSourceStaleAndCarriesQuotaFreshness() throws {
        let now = Date.now
        let stats = try decode("{\"updatedAt\":\"\(now.formatted(.iso8601))\",\"devices\":[{\"updatedAt\":\"\(now.formatted(.iso8601))\",\"stale\":true}],\"limits\":{\"providers\":[{\"provider\":\"codex\",\"status\":\"ok\",\"stale\":true,\"updatedAt\":\"\(now.formatted(.iso8601))\",\"windows\":[{\"kind\":\"weekly\",\"remainingPercent\":80}]}]}}")
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty, now: now)
        let state = LiveActivityController.contentState(
            snapshot: snapshot,
            preferences: .default,
            now: now
        )
        #expect(state.sourceStale == true)
        #expect(state.updatedAt == snapshot.updatedAt)
        #expect(state.quotas.first?.providerID == "codex")
        #expect(state.quotas.first?.stale == true)
        #expect(state.quotas.first?.windows.first?.remainingPercent == 80)
        let decoded = try JSONDecoder().decode(
            TokenMonitorActivityAttributes.ContentState.self,
            from: JSONEncoder().encode(state)
        )
        #expect(decoded == state)
    }

    @Test func activityQuotaAutoSkipsUnhealthyAndStaleProviders() throws {
        let now = Date.now
        let stats = try decode(#"{"limits":{"providers":[{"provider":"cursor","status":"notConfigured","windows":[{"remainingPercent":5}]},{"provider":"claude","status":"ok","windows":[{"remainingPercent":40}]},{"provider":"codex","status":"ok","windows":[{"remainingPercent":10}]}]}}"#)
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty, now: now)
        let state = LiveActivityController.contentState(
            snapshot: snapshot,
            preferences: .default,
            now: now
        )
        #expect(state.quotas.first?.providerID == "codex")

        #expect(state.quotas.map(\.providerID) == ["codex", "claude", "cursor"])

    }

    @Test func activitySourcesResolveLikeTheDesktopComposer() throws {
        let now = Date.now
        func ago(_ minutes: Double) -> String { now.addingTimeInterval(-minutes * 60).formatted(.iso8601) }
        let stats = try decode("""
        {"periods":{"today":{"clients":{"cursor":400},"clientCosts":{"cursor":1.5},"sessions":{
          "cursor:a":{"client":"cursor","lastUsedAt":"\(ago(1))","turnEnded":true}}}},
        "limits":{"providers":[
          {"provider":"claude","status":"ok","windows":[{"kind":"session","remainingPercent":90},{"kind":"weekly","remainingPercent":30}]},
          {"provider":"codex","accountKey":"a","status":"ok","windows":[{"kind":"weekly","remainingPercent":60}]},
          {"provider":"codex","accountKey":"b","status":"ok","windows":[{"kind":"weekly","remainingPercent":20}]},
          {"provider":"kiro","status":"ok","windows":[{"remainingPercent":70}]},
          {"provider":"cursor","status":"ok","windows":[{"kind":"billing","remainingPercent":95}]}]}}
        """)
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty, now: now)
        var preferences = TokenMonitorSharedPayload.Preferences.default
        preferences.liveLayout.compactLeading.source = .init(providerID: "kiro")
        preferences.liveLayout.compactTrailing.source = .init(accountKey: "a")
        let state = LiveActivityController.contentState(snapshot: snapshot, preferences: preferences, now: now)
        // Three ranked records, then the named provider, the named account and the recent tool.
        #expect(state.quotas.map { "\($0.providerID):\($0.accountKey ?? "")" }
            == ["codex:b", "claude:", "codex:a", "kiro:", "cursor:"])
        #expect(state.recent?.client == "cursor")
        #expect(state.recent?.today.tokens == 400)

        let context = ActivityContext(state: state, layout: LiveActivityLayout(), isStale: false, now: now)
        // Automatic lowest: the tightest primary window anywhere.
        #expect(context.reading(.init())?.quota.accountKey == "b")
        // Primary prefers the session window; secondary is the next one.
        #expect(context.reading(.init(providerID: "claude"))?.window.kind == "session")
        #expect(context.reading(.init(providerID: "claude", window: .secondary))?.window.kind == "weekly")
        #expect(context.reading(.init(window: .session))?.quota.providerID == "claude")
        // A named account wins over the provider's lowest one.
        #expect(context.reading(.init(providerID: "codex", accountKey: "a"))?.window.remainingPercent == 60)
        // Most recently used tool, and its own usage share.
        #expect(context.reading(.init(automatic: .recent))?.quota.providerID == "cursor")
        #expect(context.usage(.init(scope: .recent)).costUSD == 1.5)
        // A named provider without the window never becomes another provider.
        #expect(context.reading(.init(providerID: "kiro", window: .weekly)) == nil)
        // Used flips the reading.
        let used = try #require(context.reading(.init(providerID: "claude", value: .used)))
        #expect(context.valueText(used.window, used.value) == "10% used")
    }

    @Test func activityAgentsCountRunningSessionsAndSpeedFollowsTimedOutput() throws {
        let now = Date.now
        func ago(_ minutes: Double) -> String { now.addingTimeInterval(-minutes * 60).formatted(.iso8601) }
        let stats = try decode("""
        {"periods":{"today":{"outputTokens":500,"timedOutputTokens":1000,"timedDurationMs":20000,"sessions":{
          "claude:a":{"client":"claude","lastUsedAt":"\(ago(1))"},
          "codex:b":{"client":"codex","lastUsedAt":"\(ago(3))"},
          "claude:c":{"client":"claude","lastUsedAt":"\(ago(2))"},
          "claude:done":{"client":"claude","lastUsedAt":"\(ago(1))","turnEnded":true},
          "cursor:old":{"client":"cursor","lastUsedAt":"\(ago(30))"}}},
        "month":{"sessions":{"claude:a":{"client":"claude","lastUsedAt":"\(ago(1))"}}}}}
        """)
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty, now: now)
        let state = LiveActivityController.contentState(snapshot: snapshot, preferences: .default, now: now)
        #expect(state.agents == .init(running: 3, clients: ["claude", "codex"]))
        #expect(state.usage.today.outputTPS == 25)
    }

    @Test func activityQuotaExposesCreditsWindowsAsAmounts() throws {
        let now = Date.now
        let stats = try decode(#"{"limits":{"providers":[{"provider":"deepseek","status":"ok","balance":{"amount":20,"currency":"USD","monthSpend":80},"windows":[{"kind":"billing","metric":"credits"}]}]}}"#)
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty, now: now)
        let state = LiveActivityController.contentState(
            snapshot: snapshot,
            preferences: .default,
            now: now
        )
        #expect(state.quotas.first?.windows.first?.creditsAmount == 20)
        #expect(state.quotas.first?.windows.first?.creditsCurrency == "USD")
        #expect(state.quotas.first?.windows.first?.remainingPercent == 20)
    }
    #endif
}
