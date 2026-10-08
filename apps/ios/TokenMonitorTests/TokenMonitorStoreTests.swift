import Foundation
import Testing
@testable import TokenMonitor

@MainActor
private final class RecordingSurfaces: SystemSurfacePublishing {
    var destination: HubConfiguration?
    var published: [(HubConfiguration, HubStats)] = []
    func configure(_ configuration: HubConfiguration?) { destination = configuration }
    func publish(stats: HubStats, history: UsageHistory, configuration: HubConfiguration) async {
        published.append((configuration, stats))
    }
}

private actor ControlledHubClient: HubDataClient {
    private var requests: [CheckedContinuation<HubStats, any Error>] = []
    private var streams: [String: AsyncThrowingStream<HubStats, any Error>.Continuation] = [:]
    private var historyRequests: [CheckedContinuation<UsageHistory, any Error>] = []
    let holdHistory: Bool
    let holdAliases: Bool
    private var aliasRequests: [CheckedContinuation<ModelAliasDocument?, any Error>] = []
    var aliasCount: Int { aliasRequests.count }
    init(holdHistory: Bool = false, holdAliases: Bool = false) {
        self.holdHistory = holdHistory
        self.holdAliases = holdAliases
    }
    func fetchModelAliases(configuration: HubConfiguration) async throws -> ModelAliasDocument? {
        guard holdAliases else { return nil }
        return try await withCheckedThrowingContinuation { aliasRequests.append($0) }
    }
    func completeAliases(_ index: Int, _ value: ModelAliasDocument?) { aliasRequests[index].resume(returning: value) }
    var requestCount: Int { requests.count }
    var historyCount: Int { historyRequests.count }
    var streamCount: Int { streams.count }
    func fetchStats(configuration: HubConfiguration) async throws -> HubStats {
        // Deliberately ignore cancellation to reproduce a completed old request.
        try await withCheckedThrowingContinuation { requests.append($0) }
    }
    func fetchHistory(configuration: HubConfiguration) async throws -> UsageHistory {
        if !holdHistory { return .empty }
        return try await withCheckedThrowingContinuation { historyRequests.append($0) }
    }
    func statsStream(configuration: HubConfiguration) async -> AsyncThrowingStream<HubStats, any Error> {
        let stream = AsyncThrowingStream<HubStats, any Error>.makeStream()
        streams[configuration.baseURL.absoluteString] = stream.continuation
        return stream.stream
    }
    func complete(_ index: Int, _ stats: HubStats) { requests[index].resume(returning: stats) }
    func completeHistory(_ index: Int, _ history: UsageHistory) { historyRequests[index].resume(returning: history) }
    func send(_ stats: HubStats, to configuration: HubConfiguration) {
        streams[configuration.baseURL.absoluteString]?.yield(stats)
    }
}

@MainActor
struct TokenMonitorStoreTests {
    private func configuration(_ host: String) -> HubConfiguration {
        HubConfiguration(baseURL: URL(string: "https://\(host).example")!, secret: host)
    }
    private func stats(_ tokens: Int, revision: String = "r1") throws -> HubStats {
        try JSONDecoder().decode(HubStats.self,
            from: Data("{\"historyRevision\":\"\(revision)\",\"periods\":{\"today\":{\"totalTokens\":\(tokens)}}}".utf8))
    }

    @Test func aliasRevisionChangesReprojectLatestStatsAndRejectOldDestinations() async throws {
        let client = ControlledHubClient(holdAliases: true)
        let store = TokenMonitorStore(client: client, systemSurfaces: RecordingSurfaces())
        let a = configuration("a"), b = configuration("b")
        func snapshot(_ tokens: Int, _ revision: Int) throws -> HubStats {
            try JSONDecoder().decode(HubStats.self, from: Data("""
            {"syncSettingsRevisions":{"modelAliases":\(revision)},"periods":{"today":{"totalTokens":\(tokens),"models":{"vendor/model":\(tokens)},"modelCosts":{"vendor/model":0.00123},"sessions":{"one":{"models":{"vendor/model":\(tokens)},"totalTokens":\(tokens)}}}}}
            """.utf8))
        }
        store.configure(a)
        try #require(await coreEventually { await client.requestCount == 1 })
        await client.complete(0, try snapshot(10, 1))
        try #require(await coreEventually { await client.aliasCount == 1 })
        try #require(await coreEventually { await client.streamCount == 1 })
        await client.send(try snapshot(20, 1), to: a)
        try #require(await coreEventually { store.currentPeriod.totalTokens == 20 })
        await client.completeAliases(0, ModelAliasDocument(revision: 1, value: ModelAliasSettings(modelAliases: ["vendor/model": "Alias"])))
        try #require(await coreEventually { store.currentPeriod.models?["Alias"] == 20 })
        #expect(store.currentPeriod.modelCosts?["Alias"] == 0.00123)
        #expect(store.currentPeriod.sessions?["one"]?.models?["Alias"] == 20)
        #expect(store.stats?.period(.today).models?["vendor/model"] == 20)
        await client.send(try snapshot(30, 2), to: a)
        try #require(await coreEventually { await client.aliasCount == 2 })
        store.configure(b)
        try #require(await coreEventually { await client.requestCount == 2 })
        await client.complete(1, try snapshot(40, 1))
        try #require(await coreEventually { await client.aliasCount == 3 })
        await client.completeAliases(1, ModelAliasDocument(revision: 2, value: ModelAliasSettings(modelAliases: ["vendor/model": "Wrong destination"])))
        await client.completeAliases(2, ModelAliasDocument(revision: 1, value: ModelAliasSettings(modelAliases: ["vendor/model": "B alias"])))
        try #require(await coreEventually { store.currentPeriod.models?["B alias"] == 40 })
        #expect(store.currentPeriod.models?["Wrong destination"] == nil)
        await client.send(try snapshot(50, 2), to: b)
        try #require(await coreEventually { await client.aliasCount == 4 })
        await client.completeAliases(3, ModelAliasDocument(revision: 2, value: ModelAliasSettings()))
        try #require(await coreEventually { store.currentPeriod.models?["vendor/model"] == 50 })
        #expect(store.currentPeriod.models?["B alias"] == nil)
        store.configure(nil)
    }

    @Test func destinationSwitchAndDisconnectRejectLateRequests() async throws {
        let client = ControlledHubClient()
        let surfaces = RecordingSurfaces()
        let store = TokenMonitorStore(client: client, systemSurfaces: surfaces)
        let a = configuration("a"), b = configuration("b")
        store.configure(a)
        try #require(await coreEventually { await client.requestCount == 1 })
        store.configure(b)
        try #require(await coreEventually { await client.requestCount == 2 })
        await client.complete(1, try stats(20))
        try #require(await coreEventually { store.stats?.period(.today).totalTokens == 20 })
        await client.complete(0, try stats(10))
        await Task.yield()
        #expect(store.stats?.period(.today).totalTokens == 20)
        #expect(surfaces.published.allSatisfy { $0.0 == b })
        let refresh = Task { await store.refresh() }
        try #require(await coreEventually { await client.requestCount == 3 })
        store.configure(nil)
        await client.complete(2, try stats(99))
        await refresh.value
        #expect(store.stats == nil)
        #expect(store.history == nil)
        #expect(!store.isRefreshing)
        #expect(store.phase == .idle)
    }

    @Test func streamWinsOverOlderManualRefresh() async throws {
        let client = ControlledHubClient()
        let store = TokenMonitorStore(client: client, systemSurfaces: RecordingSurfaces())
        let destination = configuration("a")
        defer { store.configure(nil) }
        store.configure(destination)
        try #require(await coreEventually { await client.requestCount == 1 })
        await client.complete(0, try stats(1))
        try #require(await coreEventually { await client.streamCount == 1 })
        let refresh = Task { await store.refresh() }
        try #require(await coreEventually { await client.requestCount == 2 })
        await client.send(try stats(2), to: destination)
        try #require(await coreEventually { store.stats?.period(.today).totalTokens == 2 })
        await client.complete(1, try stats(0))
        await refresh.value
        #expect(store.stats?.period(.today).totalTokens == 2)
        #expect(!store.isRefreshing)
    }

    @Test func historyDoesNotBlockFreshFramesAndPublishesLatestUsage() async throws {
        let client = ControlledHubClient(holdHistory: true)
        let surfaces = RecordingSurfaces()
        let store = TokenMonitorStore(client: client, systemSurfaces: surfaces)
        let destination = configuration("a")
        defer { store.configure(nil) }
        store.configure(destination)
        try #require(await coreEventually { await client.requestCount == 1 })
        await client.complete(0, try stats(1))
        try #require(await coreEventually {
            let streams = await client.streamCount
            let histories = await client.historyCount
            return streams == 1 && histories == 1
        })
        await client.send(try stats(2), to: destination)
        try #require(await coreEventually { store.stats?.period(.today).totalTokens == 2 })
        #expect(await client.historyCount == 1)
        let history = try JSONDecoder().decode(UsageHistory.self, from: Data(#"{"daily":[{"date":"2026-10-05","tokens":5}]}"#.utf8))
        await client.completeHistory(0, history)
        try #require(await coreEventually { store.history?.daily?.first?.tokens == 5 })
        #expect(surfaces.published.last?.1.period(.today).totalTokens == 2)
    }
}

@MainActor
func coreEventually(_ predicate: @MainActor () async -> Bool) async -> Bool {
    let deadline = Date.now.addingTimeInterval(3)
    while Date.now < deadline {
        if await predicate() { return true }
        do { try await Task.sleep(for: .milliseconds(1)) } catch { return false }
    }
    return false
}
