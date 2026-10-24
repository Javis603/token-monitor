import Foundation
import Observation

@MainActor
@Observable
final class TokenMonitorStore {
    var stats: HubStats?
    var history: UsageHistory?
    let subscriptions: SubscriptionStore
    var phase: ConnectionPhase = .idle {
        didSet { updateConnectionNotice() }
    }
    private(set) var connectionNoticePhase: ConnectionPhase = .live
    @ObservationIgnored private var connectionNoticeTask: Task<Void, Never>?
    @ObservationIgnored private let connectionNoticeDelay: Duration
    var selectedPeriod: UsagePeriodKey = .today
    var isRefreshing = false
    private var displayPeriods: [String: UsagePeriod] = [:]
    private var modelAliases = ModelAliasSettings()
    @ObservationIgnored private var aliasTask: Task<Void, Never>?
    @ObservationIgnored private var aliasRequestID: UUID?
    @ObservationIgnored private var aliasRevision: Int?
    @ObservationIgnored private var requestedAliasRevision: Int?
    @ObservationIgnored private var aliasesLoaded = false

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
    @ObservationIgnored private var liveRateTracker = LiveTokenRateTracker()

    init(
        client: any HubDataClient = HubClient(),
        systemSurfaces: any SystemSurfacePublishing = SystemSurfaceCoordinator(),
        connectionNoticeDelay: Duration = .seconds(3)
    ) {
        self.connectionNoticeDelay = connectionNoticeDelay
        self.client = client
        self.subscriptions = SubscriptionStore(client: client)
        self.systemSurfaces = systemSurfaces
    }

    deinit {
        connectionNoticeTask?.cancel()
        connectionTask?.cancel()
        historyTask?.cancel()
        aliasTask?.cancel()
    }

    /// Keep transport retries truthful without flashing or resizing reading pages.
    private func updateConnectionNotice() {
        switch phase {
        case .idle, .live:
            connectionNoticeTask?.cancel()
            connectionNoticeTask = nil
            connectionNoticePhase = .live
        case .connecting:
            // Retain an already-visible offline notice throughout retry attempts.
            // Initial loading has its own full-page state when there is no snapshot.
            break
        case .failed:
            guard stats != nil, connectionNoticeTask == nil,
                  connectionNoticePhase == .live else { return }
            let delay = connectionNoticeDelay
            let generation = generation
            let failure = phase
            connectionNoticeTask = Task { [weak self] in
                do { try await Task.sleep(for: delay) } catch { return }
                guard let self, self.isCurrent(generation), self.stats != nil,
                      self.phase != .live && self.phase != .idle else { return }
                self.connectionNoticePhase = failure
                self.connectionNoticeTask = nil
            }
        }
    }

    var currentPeriod: UsagePeriod {
        displayPeriod(selectedPeriod)
    }

    func displayPeriod(_ period: UsagePeriodKey) -> UsagePeriod {
        displayPeriods[period.rawValue] ?? stats?.period(period) ?? .unknown
    }

    func systemSurfaceSnapshot(limitProviderOrder: [String], hiddenLimitProviders: Set<String>) -> TokenMonitorSharedPayload.Snapshot? {
        guard configuration != nil, let stats else { return nil }
        return .make(stats: stats, history: currentHistory, limitProviderOrder: limitProviderOrder,
                     hiddenLimitProviders: hiddenLimitProviders)
    }

    func liveOutputRate(at date: Date = .now) -> LiveTokenRateTracker.Reading? {
        guard stats != nil else { return nil }
        return liveRateTracker.reading(at: date)
    }

    func liveModelOutputRate(at date: Date = .now) -> LiveTokenRateTracker.Reading? {
        liveOutputRate(at: date)
    }

    private func projectModelNames() {
        guard let stats else { displayPeriods = [:]; return }
        let allPeriods = Array((stats.periods ?? [:]).values) + (stats.devices ?? []).flatMap { Array(($0.periods ?? [:]).values) }
        let modelIDs = allPeriods.flatMap { period in
            Array((period.models ?? [:]).keys) + (period.sessions ?? [:]).values.flatMap { Array(($0.models ?? [:]).keys) }
        }
        let botIDs = SessionListEntry.grokBotIDs(stats.periods ?? [:], authoritative: stats.grokBotSessionIds)
        let resolver = modelAliases.resolver(modelIDs: modelIDs)
        displayPeriods = (stats.periods ?? [:]).mapValues { period in
            var result = period
            result.models = ModelAliasSettings.fold(period.models, using: resolver)
            result.modelCosts = ModelAliasSettings.fold(period.modelCosts, using: resolver)
            result.modelUnpricedTokens = ModelAliasSettings.fold(period.modelUnpricedTokens, using: resolver)
            result.sessions = period.sessions?.map { key, session in
                var result = session
                if session.client == "cursor" {
                    result.grokBotSession = session.isGrokBot(key: key) || botIDs.contains(session.identityKey(fallback: key))
                }
                result.models = ModelAliasSettings.fold(session.models, using: resolver)
                return (key, result)
            }.reduce(into: [String: SessionUsage]()) { $0[$1.0] = $1.1 }
            return result
        }
    }

    private func syncModelAliases(configuration: HubConfiguration, generation: UUID) {
        let revision = stats?.syncSettingsRevisions?["modelAliases"]
        if aliasesLoaded && (revision == nil || revision == aliasRevision) { return }
        if aliasTask != nil && requestedAliasRevision == revision { return }
        aliasTask?.cancel()
        let requestID = UUID()
        aliasRequestID = requestID
        requestedAliasRevision = revision
        aliasTask = Task { [weak self, client] in
            do {
                let document = try await client.fetchModelAliases(configuration: configuration)
                guard let self, self.isCurrent(generation), self.aliasRequestID == requestID else { return }
                self.aliasTask = nil
                self.aliasRequestID = nil
                if let revision, let document, document.revision < revision { return }
                let settings = document?.value ?? ModelAliasSettings()
                let changed = self.modelAliases.modelAliases != settings.modelAliases
                    || self.modelAliases.modelAliasGrouping != settings.modelAliasGrouping
                self.modelAliases = settings
                if changed {
                    // Aliases change counter identity, so establish a fresh baseline
                    // from the latest raw snapshot before accepting more deltas.
                    self.liveRateTracker.reset()
                    if let latest = self.stats {
                        self.liveRateTracker.observe(latest, aliases: settings, at: .now)
                    }
                }
                self.aliasRevision = document?.revision ?? revision
                self.aliasesLoaded = true
                self.projectModelNames()
            } catch {
                guard let self, self.isCurrent(generation), self.aliasRequestID == requestID else { return }
                self.aliasTask = nil
                self.aliasRequestID = nil
                // Keep the last valid map. A later frame/manual refresh retries.
            }
        }
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
        connectionNoticeTask?.cancel()
        connectionNoticeTask = nil
        connectionNoticePhase = .live
        generation = UUID()
        publication = 0
        refreshID = nil
        isRefreshing = false
        self.configuration = configuration
        subscriptions.configure(configuration)
        aliasTask?.cancel()
        aliasTask = nil
        aliasRequestID = nil
        aliasRevision = nil
        requestedAliasRevision = nil
        aliasesLoaded = false
        modelAliases = ModelAliasSettings()
        displayPeriods = [:]
        liveRateTracker.reset()
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
        liveRateTracker.observe(incoming, aliases: modelAliases, at: .now)
        stats = incoming
        projectModelNames()
        syncModelAliases(configuration: configuration, generation: generation)
        subscriptions.observe(revision: incoming.subscriptionsUpdatedAt)
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

    #if DEBUG
    static var previewLimitLayout: TokenMonitorStore {
        let store = TokenMonitorStore()
        store.stats = .sampleLimitLayout
        store.history = .sample
        store.phase = .live
        return store
    }
    #endif
}
