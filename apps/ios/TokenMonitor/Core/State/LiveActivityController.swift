import ActivityKit
import Foundation
import Observation

// ActivityKit exposes these async calls as concurrent while Activity remains a
// framework-owned reference type without a Sendable annotation. Keep the
// unchecked boundary small and call only ActivityKit's own thread-safe methods.
nonisolated private struct ActivityReference: @unchecked Sendable {
    let activity: Activity<TokenMonitorActivityAttributes>

    func update(
        _ content: ActivityContent<TokenMonitorActivityAttributes.ContentState>
    ) async {
        await activity.update(content)
    }

    func end(
        _ content: ActivityContent<TokenMonitorActivityAttributes.ContentState>?,
        dismissalPolicy: ActivityUIDismissalPolicy
    ) async {
        await activity.end(content, dismissalPolicy: dismissalPolicy)
    }
}

@MainActor
@Observable
final class LiveActivityController {
    private(set) var isActive = false
    private(set) var errorMessage: String?
    private(set) var remoteUpdatesEnabled = false
    private(set) var remoteUpdateMessage: String?

    private let registrations: LiveActivityRegistrationCoordinator
    private var configuration: HubConfiguration?
    private var configured = false
    private var generation = UUID()
    private var endingTask: Task<Void, Never>?
    private var latestPreferences = TokenMonitorSharedPayload.Preferences.default
    private var pushTokens: [String: Data] = [:]
    private var tokenTasks: [String: Task<Void, Never>] = [:]

    init(client: any LiveActivityClient = HubClient(),
         bindingStore: any LiveActivityBindingStore = KeychainLiveActivityBindingStore()) {
        registrations = LiveActivityRegistrationCoordinator(client: client, bindingStore: bindingStore)
        isActive = !Activity<TokenMonitorActivityAttributes>.activities.isEmpty
    }

    func configure(_ configuration: HubConfiguration?) {
        guard !configured || self.configuration != configuration else { return }
        configured = true
        generation = UUID()
        self.configuration = configuration
        registrations.configure(configuration)
        retireActivities()
    }

    func setEnabled(
        _ enabled: Bool,
        snapshot: TokenMonitorSharedPayload.Snapshot?,
        preferences: TokenMonitorSharedPayload.Preferences
    ) async {
        latestPreferences = preferences
        if enabled {
            guard let snapshot else {
                errorMessage = String(localized: "Connect to a Hub before starting Live Activity.")
                return
            }
            await update(snapshot: snapshot, preferences: preferences)
        } else {
            await endAll()
        }
    }

    func update(
        snapshot: TokenMonitorSharedPayload.Snapshot,
        preferences: TokenMonitorSharedPayload.Preferences
    ) async {
        guard preferences.liveActivityEnabled else {
            return
        }
        let generation = generation
        await endingTask?.value
        guard self.generation == generation, !Task.isCancelled else { return }
        latestPreferences = preferences
        let state = Self.contentState(snapshot: snapshot, preferences: preferences)
        let content = ActivityContent(
            state: state,
            staleDate: state.sourceStale == true ? .distantPast : state.updatedAt.addingTimeInterval(900)
        )
        do {
            let activities = Activity<TokenMonitorActivityAttributes>.activities
            if activities.isEmpty {
                // Unsigned/debug builds lack `aps-environment`, which makes a
                // `pushType: .token` request throw outright. Fall back to a
                // local-only activity so the surfaces still run.
                let attributes = TokenMonitorActivityAttributes(title: "Token Monitor")
                let activity: Activity<TokenMonitorActivityAttributes>
                do {
                    activity = try Activity.request(
                        attributes: attributes,
                        content: content,
                        pushType: .token
                    )
                } catch {
                    activity = try Activity.request(
                        attributes: attributes,
                        content: content
                    )
                }
                observePushToken(for: activity)
                if let pushToken = activity.pushToken {
                    pushTokens[activity.id] = pushToken
                    await registerPushToken(
                        pushToken,
                        activityID: activity.id,
                        preferences: preferences
                    )
                } else {
                    remoteUpdateMessage = String(localized: "Waiting for an APNs push token.")
                }
            } else {
                for activity in activities {
                    await ActivityReference(activity: activity).update(content)
                    guard self.generation == generation, !Task.isCancelled else { return }
                    observePushToken(for: activity)
                    if let pushToken = pushTokens[activity.id] ?? activity.pushToken {
                        pushTokens[activity.id] = pushToken
                        await registerPushToken(
                            pushToken,
                            activityID: activity.id,
                            preferences: preferences
                        )
                    } else {
                        remoteUpdateMessage = String(localized: "Waiting for an APNs push token.")
                    }
                }
            }
            guard self.generation == generation, !Task.isCancelled else { return }
            errorMessage = nil
            isActive = true
        } catch {
            guard self.generation == generation, !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
            isActive = false
        }
    }

    private func endAll() async {
        generation = UUID()
        retireActivities()
        await endingTask?.value
    }

    private func retireActivities() {
        registrations.retireAll()
        tokenTasks.values.forEach { $0.cancel() }
        tokenTasks.removeAll()
        pushTokens.removeAll()
        let activities = Activity<TokenMonitorActivityAttributes>.activities.map { ActivityReference(activity: $0) }
        for reference in activities { registrations.retire(activityID: reference.activity.id) }
        let previous = endingTask
        endingTask = Task {
            await previous?.value
            for reference in activities {
                await reference.end(nil, dismissalPolicy: .immediate)
            }
        }
        errorMessage = nil
        isActive = false
        remoteUpdatesEnabled = false
        remoteUpdateMessage = nil
    }

    private func observePushToken(
        for activity: Activity<TokenMonitorActivityAttributes>
    ) {
        guard tokenTasks[activity.id] == nil else {
            return
        }
        let activityID = activity.id
        let generation = generation
        tokenTasks[activityID] = Task { [weak self] in
            for await pushToken in activity.pushTokenUpdates {
                guard let self, self.generation == generation, !Task.isCancelled else { return }
                self.pushTokens[activityID] = pushToken
                self.remoteUpdateMessage = nil
                await self.registerPushToken(
                    pushToken,
                    activityID: activityID,
                    preferences: self.latestPreferences
                )
            }
        }
    }

    private func registerPushToken(
        _ pushToken: Data,
        activityID: String,
        preferences: TokenMonitorSharedPayload.Preferences
    ) async {
        guard configuration != nil else {
            return
        }
        let generation = generation
        do {
            let result = try await registrations.register(
                activityID: activityID,
                pushToken: pushToken,
                preferences: preferences,
                locale: resolvedLocaleIdentifier(for: preferences)
            )
            guard self.generation == generation, !Task.isCancelled, let pushEnabled = result else { return }
            remoteUpdatesEnabled = pushEnabled
            remoteUpdateMessage = pushEnabled
                ? nil
                : String(localized: "Hub accepted the Activity, but APNs remote updates are not configured.")
        } catch {
            guard self.generation == generation, !Task.isCancelled else { return }
            remoteUpdatesEnabled = false
            // A Hub without the live-activities route answers 404 — the fix is
            // deploying a current Worker, not reconnecting.
            if case .httpStatus(404) = error as? HubClientError {
                remoteUpdateMessage = String(
                    localized: "This Hub doesn't support Live Activity push yet. Deploy the latest Worker with APNs configured to get background updates."
                )
            } else {
                remoteUpdateMessage = String(
                    localized: "Hub registration failed; remote updates are unavailable."
                )
            }
        }
    }

    private func resolvedLocaleIdentifier(
        for preferences: TokenMonitorSharedPayload.Preferences
    ) -> String {
        switch preferences.languageCode {
        case "en": return "en"
        case "zh-TW": return "zh-Hant"
        case "zh-CN": return "zh-Hans"
        case "ja": return "ja"
        case "ko": return "ko"
        default: return Locale.autoupdatingCurrent.identifier
        }
    }

    /// Structured ContentState v2 — identical selection semantics to
    /// `buildLiveActivityContentState` in `src/shared/liveActivity.js` so the
    /// locally driven and APNs-driven updates draw the same thing.
    nonisolated static func contentState(
        snapshot: TokenMonitorSharedPayload.Snapshot,
        preferences: TokenMonitorSharedPayload.Preferences,
        now: Date = .now
    ) -> TokenMonitorActivityAttributes.ContentState {
        let usage = snapshot.usage(for: preferences.livePeriod)
        let limit = quotaLimit(in: snapshot.limits, providerID: preferences.liveProviderID)
        let sourceDate = snapshot.updatedAt <= now ? snapshot.updatedAt : .distantPast
        let sourceStale = snapshot.sourceStale == true
            || sourceDate == .distantPast
            || now.timeIntervalSince(sourceDate) >= 900
        return TokenMonitorActivityAttributes.ContentState(
            updatedAt: sourceDate,
            sourceStale: sourceStale,
            period: preferences.livePeriod,
            tokens: usage.tokens.isFinite ? usage.tokens : nil,
            costUSD: usage.cost.isFinite ? usage.cost : nil,
            quota: limit.map { limit in
                TokenMonitorActivityAttributes.ContentState.Quota(
                    providerID: limit.providerID,
                    planLabel: limit.planLabel,
                    updatedAt: limit.updatedAt,
                    stale: limit.sourceStale,
                    windows: limit.windows.prefix(2).map { window in
                        .init(
                            label: window.label,
                            remainingPercent: window.remainingPercent,
                            resetsAt: window.resetAt,
                            creditsAmount: window.amount,
                            creditsCurrency: window.currency
                        )
                    }
                )
            },
            layout: .init(
                compactLeading: preferences.liveCompactLeading,
                compactTrailing: preferences.liveCompactTrailing,
                expanded: preferences.liveExpandedStyle,
                lockScreen: preferences.liveLockScreenStyle,
                currencyCode: preferences.currencyCode ?? "USD",
                languageCode: preferences.languageCode ?? "auto"
            )
        )
    }

    /// Quota selection shared with the Hub: a specific id picks that provider's
    /// lowest-remaining account; Auto considers only `ok`, non-stale providers,
    /// lowest canonical remaining wins, and ties or an empty pool fall back to
    /// the default catalog order.
    nonisolated private static func quotaLimit(
        in limits: [TokenMonitorSharedPayload.Limit],
        providerID: String?
    ) -> TokenMonitorSharedPayload.Limit? {
        func remaining(_ limit: TokenMonitorSharedPayload.Limit) -> Double? {
            limit.windows.compactMap(\.remainingPercent).min()
        }
        func catalogRank(_ limit: TokenMonitorSharedPayload.Limit) -> Int {
            LimitProviderOrder.defaultOrder.firstIndex(of: limit.providerID)
                ?? LimitProviderOrder.defaultOrder.count
        }
        if let providerID, !providerID.isEmpty {
            return limits
                .filter { $0.providerID == providerID.lowercased() }
                .min { left, right in
                    switch (remaining(left), remaining(right)) {
                    case let (left?, right?): return left < right
                    case (_?, nil): return true
                    default: return false
                    }
                }
        }
        let eligible = limits.filter {
            ($0.status ?? "ok") == "ok" && $0.sourceStale != true
        }
        let pool = eligible.isEmpty ? limits : eligible
        return pool.min { left, right in
            switch (remaining(left), remaining(right)) {
            case let (left?, right?) where left != right:
                return left < right
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            default:
                return catalogRank(left) < catalogRank(right)
            }
        }
    }
}
