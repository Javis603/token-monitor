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
    @MainActor @Test func localActivityAndRemoteContentPreserveExplicitSourceStale() throws {
        let now = Date.now
        let stats = try decode("{\"updatedAt\":\"\(now.formatted(.iso8601))\",\"devices\":[{\"updatedAt\":\"\(now.formatted(.iso8601))\",\"stale\":true}],\"limits\":{\"providers\":[{\"provider\":\"codex\",\"updatedAt\":\"\(now.formatted(.iso8601))\",\"stale\":true,\"windows\":[{\"kind\":\"weekly\",\"remainingPercent\":80}]}]}}")
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty, now: now)
        let controller = LiveActivityController(bindingStore: SourceBindingStore())
        var preferences = TokenMonitorSharedPayload.Preferences.default
        #expect(controller.contentState(snapshot: snapshot, preferences: preferences, now: now).sourceStale == true)
        preferences.liveShowsProgress = true
        for primary in ["tokens", "cost"] {
            preferences.livePrimaryMetric = primary
            #expect(controller.contentState(snapshot: snapshot, preferences: preferences, now: now).progress == 0.8)
        }
        preferences.livePrimaryMetric = "limit"
        let state = controller.contentState(snapshot: snapshot, preferences: preferences, now: now)
        #expect(state.sourceStale == true)
        #expect(state.updatedAt == snapshot.limits.first?.updatedAt)
        let decoded = try JSONDecoder().decode(TokenMonitorActivityAttributes.ContentState.self, from: JSONEncoder().encode(state))
        #expect(decoded.sourceStale == true)
    }
    @MainActor @Test func localActivityShowsMoneyBalancesAndMissingConfiguredProvider() throws {
        let now = Date.now
        let stats = try decode(#"{"limits":{"providers":[{"provider":"deepseek","balance":{"amount":20,"currency":"USD","monthSpend":80},"windows":[{"kind":"billing","metric":"credits"}]}]}}"#)
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty, now: now)
        let controller = LiveActivityController(bindingStore: SourceBindingStore())
        var preferences = TokenMonitorSharedPayload.Preferences.default
        preferences.liveProviderID = "deepseek"
        preferences.livePrimaryMetric = "limit"
        let state = controller.contentState(snapshot: snapshot, preferences: preferences, now: now)
        #expect(state.primaryValue == "$20.00")
        #expect(state.limitValue == "$20.00")
        #expect(state.progress == 0.2)
        preferences.liveProviderID = "absent"
        #expect(controller.contentState(snapshot: snapshot, preferences: preferences, now: now).primaryValue == "—")
    }
    #endif
}

#if os(iOS)
@MainActor private struct SourceBindingStore: LiveActivityBindingStore {
    func load() throws -> [LiveActivityBinding] { [] }
    func save(_ bindings: [LiveActivityBinding]) throws {}
}
#endif
