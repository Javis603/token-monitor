import Foundation
import Testing
@testable import TokenMonitor

@MainActor
struct MainAlignmentTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func overviewCountsPreserveNativeDefaultsAndIndependentEdits() {
        let name = "MainAlignment-\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = AppPreferences(defaults: defaults, snapshotStore: .init(fileURL: nil))
        #expect(preferences.homeCount("tool") == 3)
        #expect(preferences.homeCount("device") == 4)
        preferences.setHomeCount(50, for: "model")
        preferences.setHomeCount(0, for: "session")
        let reloaded = AppPreferences(defaults: defaults, snapshotStore: .init(fileURL: nil))
        #expect(reloaded.homeCount("model") == 50)
        #expect(reloaded.homeCount("session") == 1)
        #expect(reloaded.homeCount("tool") == 3)
        reloaded.setHomeCount(99, for: "device")
        #expect(reloaded.homeCount("device") == 50)
    }

    @Test func activeAndWaitingSessionsSurvivePreviewCount() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let sessions = try decode([String: SessionUsage].self, #"{"quiet":{"client":"codex","totalTokens":5,"lastUsedAt":"1970-01-01T00:16:39Z","turnEnded":true},"waiting":{"client":"codex","totalTokens":5,"lastUsedAt":"1970-01-01T00:16:38Z","waitingForInput":true},"running":{"client":"claude","totalTokens":5,"lastUsedAt":"1970-01-01T00:16:37Z"},"old":{"client":"codex","totalTokens":5,"lastUsedAt":"1970-01-01T00:00:00Z"}}"#)
        let rows = SessionPreviewPresentation.rows(sessions, now: now, limit: 1)
        #expect(Set(rows.map(\.id)) == ["running", "waiting"])
    }

    @Test func spendPeriodsKeepZeroAndSkipUnknownValues() throws {
        let balance = try decode(ProviderBalance.self, #"{"todaySpend":0,"weekSpend":null,"monthSpend":12.5,"allTimeSpend":90,"currency":"CNY"}"#)
        #expect(balance.spendEntries.map(\.label) == ["Today", "Month", "All time"])
        #expect(balance.spendEntries.first?.amount == 0)
        #expect(balance.currency == "CNY")
    }

    private func snapshot(_ a: (Int, Int), _ b: (Int, Int), models: Bool = true, unknownDevice: Bool = false) throws -> HubStats {
        let attribution = models ? #", "modelThroughput":{"a":{"timedTokens":\#(a.0),"timedOutputTokens":\#(a.0),"timedDurationMs":\#(a.1)},"b":{"timedTokens":\#(b.0),"timedOutputTokens":\#(b.0),"timedDurationMs":\#(b.1)}}"# : ""
        let unknown = unknownDevice ? #",{"deviceId":"legacy","stale":false,"periods":{"today":{}}}"# : ""
        return try decode(HubStats.self, #"{"devices":[{"deviceId":"mac","displayName":"Mac","stale":false,"periods":{"today":{"timedTokens":\#(a.0+b.0),"timedOutputTokens":\#(a.0+b.0),"timedDurationMs":\#(a.1+b.1)\#(attribution)}}}\#(unknown)]}"#)
    }

    @Test func concurrentModelRatesRetainSamplesAndWeightDeviceHeadline() throws {
        var tracker = LiveTokenRateTracker()
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.observe(try snapshot((100, 1_000), (100, 1_000)), at: start)
        #expect(tracker.reading(at: start) == nil)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000)), at: start.addingTimeInterval(1))
        tracker.observe(try snapshot((200, 2_000), (400, 3_000)), at: start.addingTimeInterval(2))
        let current = tracker.reading(at: start.addingTimeInterval(2))
        let reading = try #require(current)
        #expect(abs(reading.tokensPerSecond - 400.0 / 3) < 0.0001)
        #expect(reading.devices.first?.models.map(\.tokensPerSecond) == [100, 150])
        #expect(tracker.reading(at: start.addingTimeInterval(9.5))?.devices.first?.models.map(\.id) == ["b"])
        #expect(tracker.reading(at: start.addingTimeInterval(11))?.isIdle == true)
        #expect(tracker.reading(at: start.addingTimeInterval(11))?.tokensPerSecond == 150)
        #expect(tracker.reading(at: start.addingTimeInterval(183)) == nil)
        tracker.observe(try snapshot((0, 0), (0, 0)), at: start.addingTimeInterval(184))
        #expect(tracker.reading(at: start.addingTimeInterval(184)) == nil)
    }

    @Test func canonicalModelIdentityPrecedesLatestSampleSelection() throws {
        var tracker = LiveTokenRateTracker()
        let aliases = ModelAliasSettings(modelAliases: ["a": "Shared", "b": "Shared"])
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.observe(try snapshot((100, 1_000), (100, 1_000)), aliases: aliases, at: start)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000)), aliases: aliases, at: start.addingTimeInterval(1))
        tracker.observe(try snapshot((200, 2_000), (400, 3_000)), aliases: aliases, at: start.addingTimeInterval(2))
        let current = tracker.reading(at: start.addingTimeInterval(2))
        let reading = try #require(current)
        #expect(reading.tokensPerSecond == 150)
        #expect(reading.devices.first?.models.map(\.id) == ["Shared"])
        #expect(reading.devices.first?.models.first?.tokensPerSecond == 150)
    }

    @Test func unknownDeviceDoesNotEraseAnotherDevicesIdleReading() throws {
        var tracker = LiveTokenRateTracker()
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.observe(try snapshot((100, 1_000), (100, 1_000), unknownDevice: true), at: start)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000), unknownDevice: true), at: start.addingTimeInterval(1))
        #expect(tracker.reading(at: start.addingTimeInterval(10))?.tokensPerSecond == 100)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000), unknownDevice: true), at: start.addingTimeInterval(11))
        #expect(tracker.reading(at: start.addingTimeInterval(11))?.tokensPerSecond == 100)
        #expect(tracker.reading(at: start.addingTimeInterval(11))?.isIdle == true)
    }

    @Test func billingKeysUseGregorianFieldsInLocalZoneForEverySystemCalendar() throws {
        let date = try #require(Date.hubTimestamp(from: "2026-10-22T00:30:00Z"))
        for identifier in [Calendar.Identifier.gregorian, .buddhist, .japanese, .islamic] {
            var calendar = Calendar(identifier: identifier)
            calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
            let today = SharedSubscription.dayString(date, calendar: calendar)
            #expect(today == "2026-10-21")
            let record = try decode(SharedSubscription.self, #"{"id":"topup","provider":"codex","kind":"topup","currency":"USD","topUps":[{"id":"1","date":"2026-10-01","amountMinor":5000}]}"#)
            #expect(record.monthlyAmountUSD(today: today) == 50)
        }
    }

    @Test func unavailableOrConflictingModelAttributionFallsBackWithoutDoubleCounting() throws {
        var tracker = LiveTokenRateTracker()
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.observe(try snapshot((100, 1_000), (100, 1_000)), at: start)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000)), at: start.addingTimeInterval(1))
        tracker.observe(try snapshot((200, 2_000), (400, 3_000), models: false), at: start.addingTimeInterval(2))
        #expect(tracker.reading(at: start.addingTimeInterval(2))?.tokensPerSecond == 150)
        #expect(tracker.reading(at: start.addingTimeInterval(2))?.devices.isEmpty == true)
        tracker.observe(try snapshot((400, 4_000), (400, 3_000)), at: start.addingTimeInterval(3))
        #expect(tracker.reading(at: start.addingTimeInterval(3))?.tokensPerSecond == 100)
        #expect(tracker.reading(at: start.addingTimeInterval(3))?.devices.isEmpty == true)
    }

    @Test func subscriptionsUseOriginalBillingAnchorAndCalendarMonthTopups() throws {
        let plan = try decode(SharedSubscription.self, #"{"id":"a","provider":"codex","kind":"subscription","currency":"USD","amountMinor":2000,"interval":"month","startDate":"2026-01-31","autoRenew":true}"#)
        #expect(plan.nextRenewal(today: "2026-02-01") == "2026-02-28")
        #expect(plan.nextRenewal(today: "2026-03-01") == "2026-03-31")
        #expect(plan.monthlyAmountUSD(today: "2026-10-22") == 20)
        let cancelled = try decode(SharedSubscription.self, #"{"id":"a","provider":"codex","currency":"USD","amountMinor":2000,"startDate":"2026-01-31","autoRenew":false}"#)
        #expect(cancelled.coverageStop == "2026-02-28")
        #expect(cancelled.monthlyAmountUSD(today: "2026-02-28") == 0)
        #expect(cancelled.nextRenewal(today: "2026-02-01") == nil)
        let ledger = try decode(SharedSubscription.self, #"{"id":"b","provider":"newapi","kind":"topup","currency":"HKD","topUps":[{"id":"1","date":"2026-10-01","amountMinor":7800},{"id":"2","date":"2026-09-30","amountMinor":7800}]}"#)
        #expect(ledger.monthlyAmountUSD(today: "2026-10-22") == 10)
        #expect(SharedSubscription.validDay("2026-02-30") == nil)
        #expect(SharedSubscription.validDay("2026-2-3") == nil)
    }

    @Test func sharedSubscriptionsRejectLateDestinationAndRefreshOnVersion() async throws {
        let client = AlignmentSubscriptionClient()
        let state = SubscriptionStore(client: client)
        let a = HubConfiguration(baseURL: URL(string: "https://a.example")!, secret: "a")
        let b = HubConfiguration(baseURL: URL(string: "https://b.example")!, secret: "b")
        state.configure(a); state.observe(revision: "1")
        try #require(await coreEventually { await client.count == 1 })
        state.configure(b); state.observe(revision: "2")
        try #require(await coreEventually { await client.count == 2 })
        await client.complete(0, revision: "1")
        await client.complete(1, revision: "2")
        try #require(await coreEventually { state.document?.updatedAt == "2" })
        state.observe(revision: nil); state.observe(revision: "1")
        #expect(await client.count == 2)
        state.observe(revision: "3")
        try #require(await coreEventually { await client.count == 3 })
        #expect(state.isStale)
        await client.complete(2, revision: "3")
        try #require(await coreEventually { state.document?.updatedAt == "3" })
        #expect(!state.isStale)
        state.configure(nil)
        #expect(state.document == nil)
    }
    @Test func subscriptionReadFailuresKeepLastDocumentAndBoundRetry() async throws {
        let client = AlignmentSubscriptionClient()
        let state = SubscriptionStore(client: client)
        let config = HubConfiguration(baseURL: URL(string: "https://fixture.example")!, secret: "fixture")
        state.configure(config); state.observe(revision: "2")
        try #require(await coreEventually { await client.count == 1 })
        await client.complete(0, revision: "2")
        try #require(await coreEventually { state.document?.updatedAt == "2" })
        state.observe(revision: "3")
        for index in 1...3 {
            try #require(await coreEventually { await client.count == index + 1 })
            await client.complete(index, revision: "1")
        }
        try #require(await coreEventually { state.errorMessage != nil })
        #expect(state.document?.updatedAt == "2")
        #expect(state.isStale)
        state.observe(revision: "3")
        #expect(await client.count == 4)
        state.configure(nil)
    }

}

private actor AlignmentSubscriptionClient: HubDataClient {
    private var pending: [CheckedContinuation<SubscriptionDocument?, any Error>] = []
    var count: Int { pending.count }
    func fetchSubscriptions(configuration: HubConfiguration) async throws -> SubscriptionDocument? {
        try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func complete(_ index: Int, revision: String) {
        pending[index].resume(returning: .init(version: 1, updatedAt: revision, subscriptions: []))
    }
    func fetchStats(configuration: HubConfiguration) async throws -> HubStats { throw HubClientError.streamEnded }
    func fetchHistory(configuration: HubConfiguration) async throws -> UsageHistory { .empty }
    func statsStream(configuration: HubConfiguration) async -> AsyncThrowingStream<HubStats, any Error> {
        AsyncThrowingStream { $0.finish() }
    }
}
