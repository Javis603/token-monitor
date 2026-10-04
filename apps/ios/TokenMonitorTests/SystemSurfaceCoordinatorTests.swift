import Foundation
import Testing
@testable import TokenMonitor

@MainActor
struct SystemSurfaceCoordinatorTests {
    @Test func liveActivityTrailingUpdateUsesLatestSnapshotWithoutAnotherEvent() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let snapshotStore = SharedSnapshotStore(fileURL: directory.appending(path: "payload.json"))
        var preferences = TokenMonitorSharedPayload.Preferences.default
        preferences.liveActivityEnabled = true
        try snapshotStore.updatePreferences(preferences)
        var published: [Double] = []
        let coordinator = SystemSurfaceCoordinator(snapshotStore: snapshotStore,
            liveInterval: 0.05, reloadWidgets: {}, updateLiveActivity: { snapshot, _ in
                published.append(snapshot.today.tokens)
            })
        let configuration = HubConfiguration(baseURL: URL(string: "https://a.example")!, secret: "a")
        coordinator.configure(configuration)
        func stats(_ count: Int) throws -> HubStats {
            try JSONDecoder().decode(HubStats.self,
                from: Data("{\"periods\":{\"today\":{\"totalTokens\":\(count)}}}".utf8))
        }
        await coordinator.publish(stats: try stats(1), history: .empty, configuration: configuration)
        try #require(await coreEventually { published == [1] })
        await coordinator.publish(stats: try stats(2), history: .empty, configuration: configuration)
        await coordinator.publish(stats: try stats(3), history: .empty, configuration: configuration)
        try #require(await coreEventually { published == [1, 3] })
        try await Task.sleep(for: .milliseconds(70))
        #expect(published == [1, 3])
        coordinator.configure(nil)
    }

    @Test func burstReloadsLatestSnapshotOnceAtTrailingDeadlineAndDisconnectCancelsIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let snapshotStore = SharedSnapshotStore(fileURL: directory.appending(path: "payload.json"))
        var reloads = 0
        let coordinator = SystemSurfaceCoordinator(snapshotStore: snapshotStore,
            widgetInterval: 0.05, reloadWidgets: { reloads += 1 })
        let configuration = HubConfiguration(baseURL: URL(string: "https://a.example")!, secret: "a")
        coordinator.configure(configuration)
        let afterConfigure = reloads
        func stats(_ count: Int) throws -> HubStats {
            try JSONDecoder().decode(HubStats.self,
                from: Data("{\"periods\":{\"today\":{\"totalTokens\":\(count)}}}".utf8))
        }
        await coordinator.publish(stats: try stats(1), history: .empty, configuration: configuration)
        await coordinator.publish(stats: try stats(2), history: .empty, configuration: configuration)
        await coordinator.publish(stats: try stats(3), history: .empty, configuration: configuration)
        #expect(reloads == afterConfigure + 1)
        try #require(await coreEventually { reloads == afterConfigure + 2 })
        #expect(try snapshotStore.load().snapshot?.today.tokens == 3)
        try await Task.sleep(for: .milliseconds(70))
        #expect(reloads == afterConfigure + 2)
        await coordinator.publish(stats: try stats(4), history: .empty, configuration: configuration)
        await coordinator.publish(stats: try stats(5), history: .empty, configuration: configuration)
        coordinator.configure(nil)
        let afterDisconnect = reloads
        try await Task.sleep(for: .milliseconds(70))
        #expect(reloads == afterDisconnect)
        #expect(try snapshotStore.load().snapshot == nil)
    }
}
