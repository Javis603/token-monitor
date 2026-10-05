import Foundation
import BackgroundTasks
import WidgetKit

@MainActor
final class SystemSurfaceCoordinator {
    static let backgroundTaskIdentifier = "com.javis.tokenmonitor.ios.refresh"

    let liveActivityController: LiveActivityController

    private let client: HubClient
    private let snapshotStore: SharedSnapshotStore
    private var lastWidgetReloadAt: Date?
    private var lastLiveActivityUpdateAt: Date?

    init(
        client: HubClient = HubClient(),
        snapshotStore: SharedSnapshotStore = SharedSnapshotStore(),
        liveActivityController: LiveActivityController = LiveActivityController()
    ) {
        self.client = client
        self.snapshotStore = snapshotStore
        self.liveActivityController = liveActivityController
    }

    func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(
            identifier: Self.backgroundTaskIdentifier
        )
        request.earliestBeginDate = .now.addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func performBackgroundRefresh() async {
        defer { scheduleBackgroundRefresh() }

        guard let configuration = ConnectionSettings().configuration else {
            return
        }

        do {
            let stats = try await client.fetchStats(configuration: configuration)
            let history = (try? await client.fetchHistory(configuration: configuration))
                ?? stats.historyPreview
                ?? .empty
            await publish(stats: stats, history: history)
        } catch {
            // The last shared snapshot remains available to widgets and Live Activity.
        }
    }

    func publish(stats: HubStats, history: UsageHistory) async {
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(
            stats: stats,
            history: history
        )
        try? snapshotStore.updateSnapshot(snapshot)

        if shouldUpdate(lastWidgetReloadAt, minimumInterval: 60) {
            WidgetCenter.shared.reloadAllTimelines()
            lastWidgetReloadAt = .now
        }

        let preferences = (try? snapshotStore.load().preferences) ?? .default
        if preferences.liveActivityEnabled,
           shouldUpdate(lastLiveActivityUpdateAt, minimumInterval: 15) {
            await liveActivityController.update(
                snapshot: snapshot,
                preferences: preferences
            )
            lastLiveActivityUpdateAt = .now
        }
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
