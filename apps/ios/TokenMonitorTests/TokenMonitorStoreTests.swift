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
    init(holdHistory: Bool = false) { self.holdHistory = holdHistory }
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
