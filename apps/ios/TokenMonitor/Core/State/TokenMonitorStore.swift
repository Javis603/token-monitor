import Foundation
import Observation

@MainActor
@Observable
final class TokenMonitorStore {
    var stats: HubStats?
    var history: UsageHistory?
    var phase: ConnectionPhase = .idle
    var selectedPeriod: UsagePeriodKey = .today
    var isRefreshing = false

    @ObservationIgnored
    private let client: any HubDataClient

    @ObservationIgnored
    private let systemSurfaces: any SystemSurfacePublishing

    @ObservationIgnored
    private var connectionTask: Task<Void, Never>?

    @ObservationIgnored
    private var configuration: HubConfiguration?

    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var publication = 0
    @ObservationIgnored private var historyRevision: String?
    @ObservationIgnored private var refreshID: UUID?
    @ObservationIgnored private var historyTask: Task<Void, Never>?
    @ObservationIgnored private var historyRequestID: UUID?
    @ObservationIgnored private var requestedHistoryRevision: String?

    init(
        client: any HubDataClient = HubClient(),
        systemSurfaces: any SystemSurfacePublishing = SystemSurfaceCoordinator()
    ) {
        self.client = client
        self.systemSurfaces = systemSurfaces
    }

    deinit {
        connectionTask?.cancel()
        historyTask?.cancel()
    }

    var currentPeriod: UsagePeriod {
        stats?.period(selectedPeriod) ?? .unknown
    }

    var currentHistory: UsageHistory {
        history ?? stats?.historyPreview ?? .empty
    }

    func configure(_ configuration: HubConfiguration?) {
        guard self.configuration != configuration || connectionTask == nil else { return }
        connectionTask?.cancel()
        connectionTask = nil
        historyTask?.cancel()
        historyTask = nil
        historyRequestID = nil
        requestedHistoryRevision = nil
        generation = UUID()
        publication = 0
        refreshID = nil
        isRefreshing = false
        self.configuration = configuration
        stats = nil
        history = nil
        historyRevision = nil
        phase = configuration == nil ? .idle : .connecting
        systemSurfaces.configure(configuration)
        guard let configuration else { return }
        let generation = generation
        connectionTask = Task { [weak self] in
            await self?.connectionLoop(configuration: configuration, generation: generation)
        }
    }

    func refresh() async {
        guard let configuration, !isRefreshing else { return }
        let generation = generation
        let publication = publication
        let id = UUID()
        refreshID = id
        isRefreshing = true
        defer {
            if refreshID == id { isRefreshing = false; refreshID = nil }
        }
        do {
            let incoming = try await client.fetchStats(configuration: configuration)
            // A newer stream frame wins over an older in-flight manual fetch.
            guard isCurrent(generation), self.publication == publication else { return }
            await accept(incoming, configuration: configuration, generation: generation)
        } catch {
            guard isCurrent(generation), self.publication == publication else { return }
            phase = .failed(error.localizedDescription)
        }
    }

    func resume() async { await refresh() }

    private func isCurrent(_ generation: UUID) -> Bool {
        self.generation == generation && !Task.isCancelled
    }

    private func connectionLoop(configuration: HubConfiguration, generation: UUID) async {
        var retrySeconds = 1.0
        while isCurrent(generation) {
            do {
                phase = .connecting
                let publication = publication
                let incoming = try await client.fetchStats(configuration: configuration)
                guard isCurrent(generation) else { return }
                if self.publication == publication {
                    await accept(incoming, configuration: configuration, generation: generation)
                }
                guard isCurrent(generation) else { return }
                let stream = await client.statsStream(configuration: configuration)
                for try await update in stream {
                    guard isCurrent(generation) else { return }
                    await accept(update, configuration: configuration, generation: generation)
                    retrySeconds = 1
                }
                throw HubClientError.streamEnded
            } catch {
                guard isCurrent(generation) else { return }
                phase = .failed(error.localizedDescription)
                do {
                    try await Task.sleep(for: .seconds(retrySeconds))
                    retrySeconds = min(30, retrySeconds * 2)
                } catch { return }
            }
        }
    }

    private func accept(
        _ incoming: HubStats,
        configuration: HubConfiguration,
        generation: UUID
    ) async {
        guard isCurrent(generation) else { return }
        publication += 1
        let publication = publication
        stats = incoming
        phase = .live
        // Publish stats immediately; history must not block fresh usage or widgets.
        await systemSurfaces.publish(stats: incoming, history: currentHistory, configuration: configuration)
        guard isCurrent(generation), self.publication == publication else { return }
        let needsHistory = history == nil || incoming.historyRevision != historyRevision
        guard needsHistory else { return }
        if historyTask != nil, requestedHistoryRevision == incoming.historyRevision { return }
        historyTask?.cancel()
        let requestID = UUID()
        historyRequestID = requestID
        requestedHistoryRevision = incoming.historyRevision
        historyTask = Task { [weak self, client] in
            do {
                let loaded = try await client.fetchHistory(configuration: configuration)
                guard let self, self.isCurrent(generation), self.historyRequestID == requestID else { return }
                self.history = loaded
                self.historyRevision = incoming.historyRevision
                self.historyTask = nil
                self.historyRequestID = nil
                // Use the latest usage/freshness frame, never the frame that started history.
                if let latest = self.stats {
                    await self.systemSurfaces.publish(stats: latest, history: loaded, configuration: configuration)
                }
            } catch {
                guard let self, self.isCurrent(generation), self.historyRequestID == requestID else { return }
                self.historyTask = nil
                self.historyRequestID = nil
                // Leave the revision unacknowledged so the next frame can retry.
                self.history = self.stats?.historyPreview ?? self.history
            }
        }
    }

}

extension TokenMonitorStore {
    static var preview: TokenMonitorStore {
        let store = TokenMonitorStore()
        store.stats = .sample
        store.history = .sample
        store.phase = .live
        return store
    }
}
