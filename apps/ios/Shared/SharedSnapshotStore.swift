import Foundation

nonisolated struct SharedSnapshotStore: Sendable {
    static let appGroupIdentifier = "group.com.javis.tokenmonitor.ios"
    static let payloadFilename = "token-monitor-surfaces.json"

    let fileURL: URL?

    init(fileURL: URL? = SharedSnapshotStore.defaultFileURL()) {
        self.fileURL = fileURL
    }

    func load() throws -> TokenMonitorSharedPayload {
        guard let fileURL else {
            return TokenMonitorSharedPayload()
        }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return TokenMonitorSharedPayload()
        }
        let data = try Data(contentsOf: fileURL)
        let payload = try JSONDecoder().decode(TokenMonitorSharedPayload.self, from: data)
        guard payload.version == TokenMonitorSharedPayload.currentVersion else {
            return TokenMonitorSharedPayload()
        }
        return payload
    }

    func updateSnapshot(_ snapshot: TokenMonitorSharedPayload.Snapshot) throws {
        var payload = try load()
        payload.snapshot = snapshot
        try save(payload)
    }

    func updatePreferences(_ preferences: TokenMonitorSharedPayload.Preferences) throws {
        var payload = try load()
        payload.preferences = preferences
        try save(payload)
    }

    private func save(_ payload: TokenMonitorSharedPayload) throws {
        guard let fileURL else {
            return
        }
        let parent = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: parent,
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(payload)
        try data.write(to: fileURL, options: .atomic)
    }

    private static func defaultFileURL() -> URL? {
        FileManager.default
            .containerURL(
                forSecurityApplicationGroupIdentifier: appGroupIdentifier
            )?
            .appending(path: payloadFilename)
    }
}
