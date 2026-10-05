import Foundation
import Observation

@MainActor
@Observable
final class TokenMonitorStore {
    var stats: HubStats?
    var history: UsageHistory?
    var phase: ConnectionPhase = .idle
    var selectedPeriod: UsagePeriodKey = .today
    var isRefreshing = false

    @ObservationIgnored
    private let client: HubClient

    @ObservationIgnored
    private let systemSurfaces: SystemSurfaceCoordinator

    @ObservationIgnored
    private var connectionTask: Task<Void, Never>?

    @ObservationIgnored
    private var configuration: HubConfiguration?

    init(
        client: HubClient = HubClient(),
        systemSurfaces: SystemSurfaceCoordinator = SystemSurfaceCoordinator()
    ) {
        self.client = client
        self.systemSurfaces = systemSurfaces
    }

    deinit {
        connectionTask?.cancel()
    }

    var currentPeriod: UsagePeriod {
        stats?.period(selectedPeriod) ?? .empty
    }

    var currentHistory: UsageHistory {
        history ?? stats?.historyPreview ?? .empty
    }

    func configure(_ configuration: HubConfiguration?) {
        connectionTask?.cancel()
        self.configuration = configuration
        guard let configuration else {
            phase = .idle
            stats = nil
            history = nil
            return
        }
        connectionTask = Task { [weak self] in
            await self?.connectionLoop(configuration: configuration)
        }
    }

    func refresh() async {
        guard let configuration else {
            phase = .idle
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let incoming = try await client.fetchStats(configuration: configuration)
            await accept(incoming, configuration: configuration)
            phase = .live
        } catch is CancellationError {
            return
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func resume() async {
        guard configuration != nil else {
            return
        }
        await refresh()
    }

    private func connectionLoop(configuration: HubConfiguration) async {
        while !Task.isCancelled {
            do {
                phase = .connecting
                let incoming = try await client.fetchStats(configuration: configuration)
                await accept(incoming, configuration: configuration)
                phase = .live

                let stream = await client.statsStream(configuration: configuration)
                for try await update in stream {
                    try Task.checkCancellation()
                    await accept(update, configuration: configuration)
                    phase = .live
                }
            } catch is CancellationError {
                return
            } catch {
                phase = .failed(error.localizedDescription)
                do {
                    try await Task.sleep(for: .seconds(4))
                } catch {
                    return
                }
            }
        }
    }

    private func accept(
        _ incoming: HubStats,
        configuration: HubConfiguration
    ) async {
        let previousRevision = stats?.historyRevision
        stats = incoming

        let needsHistory = history == nil
            || (
                incoming.historyRevision?.isEmpty == false
                    && incoming.historyRevision != previousRevision
            )
        if needsHistory {
            do {
                history = try await client.fetchHistory(configuration: configuration)
            } catch is CancellationError {
                return
            } catch {
                history = incoming.historyPreview ?? history
            }
        }
        await systemSurfaces.publish(stats: incoming, history: currentHistory)
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
}
