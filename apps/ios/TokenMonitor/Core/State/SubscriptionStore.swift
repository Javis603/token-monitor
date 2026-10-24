import Foundation
import Observation

@MainActor
@Observable
final class SubscriptionStore {
    private(set) var document: SubscriptionDocument?
    private(set) var errorMessage: String?
    private(set) var isLoading = false
    private(set) var isUnsupported = false
    private(set) var isStale = false
    @ObservationIgnored private let client: any HubDataClient
    @ObservationIgnored private var configuration: HubConfiguration?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var requestedRevision: String?
    @ObservationIgnored private var latestRevision: String?
    @ObservationIgnored private var retryAfter = Date.distantPast

    init(client: any HubDataClient) { self.client = client }
    deinit { task?.cancel() }

    func configure(_ configuration: HubConfiguration?) {
        task?.cancel(); task = nil
        generation = UUID(); self.configuration = configuration
        document = nil; errorMessage = nil; isUnsupported = false; isStale = false
        isLoading = false; requestedRevision = nil; latestRevision = nil; retryAfter = .distantPast
    }
    func observe(revision: String?) {
        // A missing stamp is no news; an explicit empty stamp describes an unwritten list.
        if let revision {
            if revision != latestRevision { isUnsupported = false }
            latestRevision = revision
        }
        let needsUpdate = latestRevision.map { $0 > (document?.updatedAt ?? "") } ?? false
        guard document == nil || needsUpdate else { return }
        if document != nil { isStale = true }
        guard Date.now >= retryAfter, !isUnsupported,
              task == nil || requestedRevision != latestRevision else { return }
        load()
    }
    func refresh() { retryAfter = .distantPast; load() }

    private func load() {
        guard let configuration else { return }
        task?.cancel()
        let generation = UUID()
        self.generation = generation
        let revision = [latestRevision, document?.updatedAt].compactMap { $0 }.max()
        requestedRevision = revision
        isLoading = true; errorMessage = nil
        task = Task { [weak self, client] in
            do {
                // A small bounded retry handles stats arriving before a replica read catches up.
                var loaded: SubscriptionDocument?
                for attempt in 0..<3 {
                    if attempt > 0 { try await Task.sleep(for: .milliseconds(250 * attempt)) }
                    loaded = try await client.fetchSubscriptions(configuration: configuration)
                    if loaded == nil || revision.map({ (loaded?.updatedAt ?? "") >= $0 }) ?? true { break }
                }
                guard let self, !Task.isCancelled, self.generation == generation else { return }
                if let loaded {
                    guard loaded.version == 1 else { throw LoadError.unsupportedVersion }
                    guard revision.map({ loaded.updatedAt >= $0 }) ?? true else { throw LoadError.outdatedRevision }
                    self.document = loaded; self.isStale = false; self.isUnsupported = false
                } else {
                    self.isUnsupported = true
                    self.isStale = self.document != nil
                }
                self.isLoading = false; self.task = nil
            } catch {
                guard let self, !Task.isCancelled, self.generation == generation else { return }
                self.errorMessage = error.localizedDescription
                self.isStale = self.document != nil
                self.retryAfter = .now.addingTimeInterval(30)
                self.isLoading = false; self.task = nil
            }
        }
    }

    private enum LoadError: LocalizedError {
        case unsupportedVersion, outdatedRevision
        var errorDescription: String? {
            switch self {
            case .unsupportedVersion:
                String(localized: "This subscription format is not supported. Update the app and try again.", table: "AppAlignment")
            case .outdatedRevision:
                String(localized: "The Hub returned an older subscription list. Retry to load the latest records.", table: "AppAlignment")
            }
        }
    }
}
