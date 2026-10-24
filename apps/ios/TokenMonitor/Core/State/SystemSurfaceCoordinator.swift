import Foundation
import BackgroundTasks
import WidgetKit

@MainActor
protocol SystemSurfacePublishing: AnyObject {
    func configure(_ configuration: HubConfiguration?)
    func publish(stats: HubStats, history: UsageHistory, configuration: HubConfiguration) async
}

@MainActor
final class SystemSurfaceCoordinator: SystemSurfacePublishing {
    static let backgroundTaskIdentifier = "com.javis.tokenmonitor.ios.refresh"

    let liveActivityController: LiveActivityController

    private let client: any HubDataClient
    private let snapshotStore: SharedSnapshotStore
    private var lastWidgetReloadAt: Date?
    private var lastLiveActivityUpdateAt: Date?

    private var configuration: HubConfiguration?
    private var generation = UUID()
    private var publication = 0
    private var configured = false
    private var widgetTask: Task<Void, Never>?
    private var liveTask: Task<Void, Never>?
    private var latestSnapshot: TokenMonitorSharedPayload.Snapshot?
    private let widgetInterval: TimeInterval
    private let liveInterval: TimeInterval
    private let reloadWidgets: @MainActor () -> Void
    private let updateLiveActivity: @MainActor (TokenMonitorSharedPayload.Snapshot, TokenMonitorSharedPayload.Preferences) async -> Void

    init(
        client: any HubDataClient = HubClient(),
        snapshotStore: SharedSnapshotStore = SharedSnapshotStore(),
        liveActivityController: LiveActivityController = LiveActivityController(),
        widgetInterval: TimeInterval = 60,
        liveInterval: TimeInterval = 5,
        reloadWidgets: @escaping @MainActor () -> Void = { WidgetCenter.shared.reloadAllTimelines() },
        updateLiveActivity: (@MainActor (TokenMonitorSharedPayload.Snapshot, TokenMonitorSharedPayload.Preferences) async -> Void)? = nil
    ) {
        self.client = client
        self.snapshotStore = snapshotStore
        self.liveActivityController = liveActivityController
        self.widgetInterval = widgetInterval
        self.liveInterval = liveInterval
        self.reloadWidgets = reloadWidgets
        self.updateLiveActivity = updateLiveActivity ?? { snapshot, preferences in
            await liveActivityController.update(snapshot: snapshot, preferences: preferences)
        }
    }

    func configure(_ configuration: HubConfiguration?) {
        guard !configured || self.configuration != configuration else { return }
        configured = true
        generation = UUID()
        publication += 1
        self.configuration = configuration
        widgetTask?.cancel()
        liveTask?.cancel()
        widgetTask = nil
        liveTask = nil
        latestSnapshot = nil
        lastWidgetReloadAt = nil
        lastLiveActivityUpdateAt = nil
        // A legacy cache has no destination identity. Clear on first configuration
        // too, rather than showing a previous Hub's data before the first response.
        try? snapshotStore.clearSnapshot()
        reloadWidgets()
        liveActivityController.configure(configuration)
        if configuration == nil {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.backgroundTaskIdentifier)
        } else {
            scheduleBackgroundRefresh()
        }
    }

    func scheduleBackgroundRefresh() {
        guard configuration != nil else { return }
        let request = BGAppRefreshTaskRequest(
            identifier: Self.backgroundTaskIdentifier
        )
        request.earliestBeginDate = .now.addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func performBackgroundRefresh() async {
        if !configured { configure(ConnectionSettings().configuration) }
        defer { scheduleBackgroundRefresh() }
        guard let configuration else { return }
        let generation = generation
        let publication = publication
        do {
            let stats = try await client.fetchStats(configuration: configuration)
            guard !Task.isCancelled, self.generation == generation,
                  self.publication == publication else { return }
            let history = (try? await client.fetchHistory(configuration: configuration))
                ?? stats.historyPreview ?? .empty
            guard !Task.isCancelled, self.generation == generation,
                  self.publication == publication,
                  ConnectionSettings().configuration == configuration else { return }
            await publish(stats: stats, history: history, configuration: configuration)
        } catch {
            // Keep the current destination's last good snapshot with its original timestamp.
        }
    }

    func publish(stats: HubStats, history: UsageHistory, configuration: HubConfiguration) async {
        guard !Task.isCancelled, configured, self.configuration == configuration else { return }
        publication += 1
        let preferences = (try? snapshotStore.load().preferences) ?? .default
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(
            stats: stats,
            history: history,
            limitProviderOrder: preferences.limitProviderOrder ?? [],
            hiddenLimitProviders: Set(preferences.hiddenLimitProviders ?? [])
        )
        do {
            try snapshotStore.updateSnapshot(snapshot)
        } catch { return }
        latestSnapshot = snapshot
        if shouldUpdate(lastWidgetReloadAt, minimumInterval: widgetInterval) {
            widgetTask?.cancel()
            widgetTask = nil
            reloadWidgets()
            lastWidgetReloadAt = .now
        } else if widgetTask == nil {
            let generation = generation
            let delay = remainingDelay(lastWidgetReloadAt, interval: widgetInterval)
            widgetTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                guard let self, self.generation == generation else { return }
                self.widgetTask = nil
                self.reloadWidgets()
                self.lastWidgetReloadAt = .now
            }
        }
        if !preferences.liveActivityEnabled {
            liveTask?.cancel()
            liveTask = nil
        } else if liveTask == nil {
            let generation = generation
            liveTask = Task { [weak self] in
                guard let self else { return }
                while !Task.isCancelled, self.generation == generation {
                    let delay = self.remainingDelay(self.lastLiveActivityUpdateAt, interval: self.liveInterval)
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                    guard self.generation == generation, let snapshot = self.latestSnapshot else { return }
                    let preferences = (try? self.snapshotStore.load().preferences) ?? .default
                    guard preferences.liveActivityEnabled else { self.liveTask = nil; return }
                    let publication = self.publication
                    self.lastLiveActivityUpdateAt = .now
                    await self.updateLiveActivity(snapshot, preferences)
                    guard self.generation == generation, !Task.isCancelled else { return }
                    if self.publication == publication { self.liveTask = nil; return }
                }
            }
        }
    }

    private func remainingDelay(_ lastUpdate: Date?, interval: TimeInterval) -> TimeInterval {
        max(0, interval - Date.now.timeIntervalSince(lastUpdate ?? .distantPast))
    }

    private func shouldUpdate(
        _ lastUpdate: Date?,
        minimumInterval: TimeInterval
    ) -> Bool {
        guard let lastUpdate else {
            return true
        }
        return Date.now.timeIntervalSince(lastUpdate) >= minimumInterval
    }
}
