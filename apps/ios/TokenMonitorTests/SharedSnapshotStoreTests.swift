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
                    planLabel: nil,
                    status: nil,
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
    @Test func widgetAccountLabelsAreMaskedAndLegacySnapshotsDecode() throws {
        let stats = try JSONDecoder().decode(HubStats.self, from: Data(#"{"limits":{"providers":[{"provider":"codex","accountEmail":"javis@example.com","windows":[{"kind":"weekly","remainingPercent":28}]}]}}"#.utf8))
        let snapshot = TokenMonitorSharedPayload.Snapshot.make(stats: stats, history: .empty)
        #expect(snapshot.limits.first?.maskedAccountLabel == "j***s@example.com")
        let data = try JSONEncoder().encode(snapshot)
        #expect(!String(decoding: data, as: UTF8.self).contains("javis@example.com"))
        let decoded = try JSONDecoder().decode(TokenMonitorSharedPayload.Snapshot.self, from: data)
        #expect(decoded.limits.first?.maskedAccountLabel == "j***s@example.com")
        let legacy = try JSONDecoder().decode(TokenMonitorSharedPayload.Limit.self,
            from: Data(#"{"id":"codex","providerID":"codex","windows":[]}"#.utf8))
        #expect(legacy.maskedAccountLabel == nil)
        let malformed = try JSONDecoder().decode(HubStats.self,
            from: Data(#"{"limits":{"providers":[{"provider":"codex","accountEmail":"@private***"}]}}"#.utf8))
        #expect(TokenMonitorSharedPayload.Snapshot.make(stats: malformed, history: .empty)
            .limits.first?.maskedAccountLabel == nil)
    }

}
