import Foundation

nonisolated struct LiveActivityBinding: Codable, Equatable, Sendable {
    let id: String
    let configuration: HubConfiguration
}

@MainActor
protocol LiveActivityBindingStore {
    func load() throws -> [LiveActivityBinding]
    func save(_ bindings: [LiveActivityBinding]) throws
}

// Cleanup destinations contain credentials and belong in Keychain, never in
// the app-group snapshot or UserDefaults. Journal before admitting a POST.
@MainActor
struct KeychainLiveActivityBindingStore: LiveActivityBindingStore {
    private let keychain = KeychainStore(service: "com.javis.tokenmonitor.ios", account: "live-activity-bindings")
    func load() throws -> [LiveActivityBinding] {
        guard let value = try keychain.load() else { return [] }
        return try JSONDecoder().decode([LiveActivityBinding].self, from: Data(value.utf8))
    }
    func save(_ bindings: [LiveActivityBinding]) throws {
        try keychain.save(String(decoding: JSONEncoder().encode(bindings), as: UTF8.self))
    }
}

// Serialize POST/DELETE operations. Cancellation cannot undo a POST already
// accepted by the Hub, so retire it at its captured destination after completion.
@MainActor
final class LiveActivityRegistrationCoordinator {
    private let client: any LiveActivityClient
    private let bindingStore: any LiveActivityBindingStore
    private var journalError: (any Error)?
    private var configuration: HubConfiguration?
    private var generation = UUID()
    private var bindings: [String: HubConfiguration] = [:]
    private var retiredIDs: Set<String> = []
    private var pendingCleanup: [LiveActivityBinding] = []
    private var operation: Task<Void, Never>?
    private var configured = false

    init(client: any LiveActivityClient = HubClient(),
         bindingStore: any LiveActivityBindingStore = KeychainLiveActivityBindingStore()) {
        self.client = client
        self.bindingStore = bindingStore
        do { pendingCleanup = try bindingStore.load() } catch { journalError = error }
    }

    func configure(_ configuration: HubConfiguration?) {
        guard !configured || self.configuration != configuration else { return }
        configured = true
        generation = UUID()
        self.configuration = configuration
        for (id, destination) in bindings { queueCleanup(id, destination) }
        bindings.removeAll()
        scheduleCleanup()
    }

    func retire(activityID: String) {
        retiredIDs.insert(activityID)
        if let destination = bindings.removeValue(forKey: activityID) {
            queueCleanup(activityID, destination)
        }
        scheduleCleanup()
    }

    func retireAll() {
        generation = UUID()
        for (id, destination) in bindings { queueCleanup(id, destination) }
        bindings.removeAll()
        scheduleCleanup()
    }

    func register(activityID: String, pushToken: Data,
                  preferences: TokenMonitorSharedPayload.Preferences) async throws -> Bool? {
        guard let configuration else { return nil }
        let generation = generation
        let previous = operation
        let next = Task { @MainActor in
            await previous?.value
            guard self.generation == generation, !self.retiredIDs.contains(activityID) else { return nil as Bool? }
            if self.journalError != nil {
                self.pendingCleanup.append(contentsOf: try self.bindingStore.load())
                self.journalError = nil
            }
            await self.cleanup()
            guard self.generation == generation, !self.retiredIDs.contains(activityID) else { return nil }
            guard !self.pendingCleanup.contains(where: { $0.id == activityID && $0.configuration == configuration }) else {
                throw HubClientError.invalidResponse
            }
            // Include failed/ambiguous POSTs in cleanup: the response can fail
            // after the server has durably accepted the registration.
            self.bindings[activityID] = configuration
            try self.persistBindings()
            do {
                let enabled = try await self.client.registerLiveActivity(
                    activityID: activityID, pushToken: pushToken,
                    preferences: preferences, configuration: configuration)
                guard self.generation == generation,
                      self.bindings[activityID] == configuration else {
                    self.queueCleanup(activityID, configuration)
                    await self.cleanup()
                    return nil
                }
                return enabled
            } catch {
                if self.generation != generation || self.bindings[activityID] != configuration {
                    self.queueCleanup(activityID, configuration)
                    await self.cleanup()
                    return nil
                }
                throw error
            }
        }
        operation = Task { _ = try? await next.value }
        return try await next.value
    }

    private func queueCleanup(_ id: String, _ configuration: HubConfiguration) {
        guard !pendingCleanup.contains(where: { $0.id == id && $0.configuration == configuration }) else { return }
        pendingCleanup.append(LiveActivityBinding(id: id, configuration: configuration))
    }

    private func scheduleCleanup() {
        let previous = operation
        operation = Task { @MainActor in
            await previous?.value
            await self.cleanup()
        }
    }

    private func cleanup() async {
        let pending = pendingCleanup
        for entry in pending {
            do {
                try await client.unregisterLiveActivity(activityID: entry.id, configuration: entry.configuration)
                pendingCleanup.removeAll { $0 == entry }
                try persistBindings()
            } catch {
                queueCleanup(entry.id, entry.configuration)
            }
        }
    }

    private func persistBindings() throws {
        var entries = pendingCleanup
        for (id, configuration) in bindings {
            let binding = LiveActivityBinding(id: id, configuration: configuration)
            if !entries.contains(binding) { entries.append(binding) }
        }
        try bindingStore.save(entries)
    }
}
