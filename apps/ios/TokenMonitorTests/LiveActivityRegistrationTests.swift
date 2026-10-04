import Foundation
import Testing
@testable import TokenMonitor

@MainActor
private final class MemoryBindingStore: LiveActivityBindingStore {
    var entries: [LiveActivityBinding] = []
    var fails = false
    func load() throws -> [LiveActivityBinding] { entries }
    func save(_ bindings: [LiveActivityBinding]) throws {
        if fails { throw HubClientError.invalidResponse }
        entries = bindings
    }
}

private actor ControlledActivityClient: LiveActivityClient {
    private var pending: [CheckedContinuation<Bool, any Error>] = []
    private(set) var posts: [HubConfiguration] = []
    private(set) var deletes: [HubConfiguration] = []
    var deleteFails = false
    func setDeleteFailure(_ fails: Bool) { deleteFails = fails }
    func registerLiveActivity(activityID: String, pushToken: Data,
        preferences: TokenMonitorSharedPayload.Preferences, locale: String,
        configuration: HubConfiguration) async throws -> Bool {
        posts.append(configuration)
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func unregisterLiveActivity(activityID: String, configuration: HubConfiguration) async throws {
        deletes.append(configuration)
        if deleteFails { throw HubClientError.invalidResponse }
    }
    func complete(_ index: Int, result: Result<Bool, any Error> = .success(true)) {
        pending[index].resume(with: result)
    }
}

@MainActor
struct LiveActivityRegistrationTests {
    private func destination(_ host: String) -> HubConfiguration {
        HubConfiguration(baseURL: URL(string: "https://\(host).example")!, secret: host)
    }

    @Test func latePostIsCleanedAtOriginalDestinationAndCannotReportRemoteEnabled() async throws {
        let client = ControlledActivityClient()
        let journal = MemoryBindingStore()
        let coordinator = LiveActivityRegistrationCoordinator(client: client, bindingStore: journal)
        let a = destination("a"), b = destination("b")
        coordinator.configure(a)
        let post = Task { try await coordinator.register(activityID: "activity", pushToken: Data([1]), preferences: .default, locale: "en") }
        try #require(await coreEventually { await client.posts.count == 1 })
        #expect(journal.entries.first?.configuration == a)
        coordinator.configure(b)
        await client.complete(0)
        #expect(try await post.value == nil)
        try #require(await coreEventually { await client.deletes.contains(a) })
        #expect(await client.deletes.allSatisfy { $0 == a })
        #expect(journal.entries.isEmpty)
    }

    @Test func ambiguousPostFailureAfterDisableStillGetsDeleted() async throws {
        let client = ControlledActivityClient()
        let journal = MemoryBindingStore()
        let coordinator = LiveActivityRegistrationCoordinator(client: client, bindingStore: journal)
        let destination = destination("a")
        coordinator.configure(destination)
        let post = Task { try await coordinator.register(activityID: "activity", pushToken: Data([1]), preferences: .default, locale: "en") }
        try #require(await coreEventually { await client.posts.count == 1 })
        coordinator.retireAll()
        await client.complete(0, result: .failure(HubClientError.invalidResponse))
        #expect(try await post.value == nil)
        try #require(await coreEventually { await client.deletes.contains(destination) })
        #expect(journal.entries.isEmpty)
    }

    @Test func restartRetainsFailedCleanupAndRetriesWithoutRetargeting() async throws {
        let client = ControlledActivityClient()
        let journal = MemoryBindingStore()
        let a = destination("a"), b = destination("b")
        journal.entries = [.init(id: "old-activity", configuration: a)]
        await client.setDeleteFailure(true)
        let coordinator = LiveActivityRegistrationCoordinator(client: client, bindingStore: journal)
        coordinator.configure(b)
        try #require(await coreEventually { await client.deletes.count == 1 })
        #expect(journal.entries.count == 1)
        await client.setDeleteFailure(false)
        coordinator.configure(nil)
        try #require(await coreEventually { journal.entries.isEmpty })
        #expect(await client.deletes.allSatisfy { $0 == a })
    }

    @Test func journalFailurePreventsSendingAPushToken() async throws {
        let client = ControlledActivityClient()
        let journal = MemoryBindingStore()
        journal.fails = true
        let coordinator = LiveActivityRegistrationCoordinator(client: client, bindingStore: journal)
        coordinator.configure(destination("a"))
        await #expect(throws: (any Error).self) {
            _ = try await coordinator.register(activityID: "activity", pushToken: Data([1]), preferences: .default, locale: "en")
        }
        #expect(await client.posts.isEmpty)
    }
}
