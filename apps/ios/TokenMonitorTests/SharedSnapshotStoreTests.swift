import Foundation
import Testing
@testable import TokenMonitor

struct SharedSnapshotStoreTests {
    @Test func clearPreservesPreferencesAndRecoversCorruptCache() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appending(path: "surfaces.json")
        let store = SharedSnapshotStore(fileURL: fileURL)
        var preferences = TokenMonitorSharedPayload.Preferences.default
        preferences.widgetPeriod = "month"
        try store.updatePreferences(preferences)
        try store.updateSnapshot(.make(stats: .sample, history: .empty))
        try store.clearSnapshot()
        #expect(try store.load().snapshot == nil)
        #expect(try store.load().preferences == preferences)
        try Data("broken cache".utf8).write(to: fileURL)
        try store.clearSnapshot()
        #expect(try store.load().snapshot == nil)
    }

    @Test
    func roundTripsVersionedPrivacySafePayload() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        let fileURL = directory.appending(path: "surfaces.json")
        let store = SharedSnapshotStore(fileURL: fileURL)
        let snapshot = TokenMonitorSharedPayload.Snapshot(
            updatedAt: Date(timeIntervalSince1970: 1_785_459_507),
            today: .init(
                tokens: 42,
                cost: 1.25,
                cacheReadTokens: 20,
                outputTokens: 5,
                tools: [.init(id: "codex", value: 42)],
                models: [.init(id: "gpt-5.4", value: 42)]
            ),
            month: .empty,
            allTime: .empty,
            limits: [
                .init(
                    id: "codex-0",
                    providerID: "codex",
                    updatedAt: nil,
                    windows: [
                        .init(
                            id: "weekly",
                            label: "Weekly",
                            remainingPercent: 88,
                            amount: nil,
                            currency: nil,
                            resetAt: nil
                        )
                    ]
                )
            ],
            activity: [
                .init(date: "2026-07-31", tokens: 42, cost: 1.25)
            ]
        )

        try store.updateSnapshot(snapshot)
        var preferences = TokenMonitorSharedPayload.Preferences.default
        preferences.widgetContent = "activity"
        preferences.liveActivityEnabled = true
        try store.updatePreferences(preferences)

        let loaded = try store.load()
        #expect(loaded.version == TokenMonitorSharedPayload.currentVersion)
        #expect(loaded.snapshot == snapshot)
        #expect(loaded.preferences == preferences)

        let json = try String(
            contentsOf: fileURL,
            encoding: .utf8
        )
        #expect(!json.contains("accountEmail"))
        #expect(!json.contains("accountName"))
        #expect(!json.contains("secret"))
        #expect(!json.contains("credential"))
    }
}
