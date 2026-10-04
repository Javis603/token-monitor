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
                errorMessage = "Connect to a Hub before starting Live Activity."
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
        let state = contentState(snapshot: snapshot, preferences: preferences)
        let content = ActivityContent(
            state: state,
            staleDate: state.sourceStale == true ? .distantPast : state.updatedAt.addingTimeInterval(600)
        )
        do {
            let activities = Activity<TokenMonitorActivityAttributes>.activities
            if activities.isEmpty {
                let activity = try Activity.request(
                    attributes: TokenMonitorActivityAttributes(title: "Token Monitor"),
                    content: content,
                    pushType: .token
                )
                observePushToken(for: activity)
                if let pushToken = activity.pushToken {
                    pushTokens[activity.id] = pushToken
                    await registerPushToken(
                        pushToken,
                        activityID: activity.id,
                        preferences: preferences
                    )
                } else {
                    remoteUpdateMessage = "Waiting for an APNs push token."
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
                        remoteUpdateMessage = "Waiting for an APNs push token."
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
                : "Hub accepted the Activity, but APNs remote updates are not configured."
        } catch {
            guard self.generation == generation, !Task.isCancelled else { return }
            remoteUpdatesEnabled = false
            remoteUpdateMessage = "Hub registration failed; remote updates are unavailable."
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

    func contentState(
        snapshot: TokenMonitorSharedPayload.Snapshot,
        preferences: TokenMonitorSharedPayload.Preferences,
        now: Date = .now
    ) -> TokenMonitorActivityAttributes.ContentState {
        let usage = snapshot.usage(for: preferences.livePeriod)
        let limit = preferredLimit(
            in: snapshot,
            providerID: preferences.liveProviderID
        )
        let currency = AppCurrency(
            rawValue: preferences.currencyCode ?? "USD"
        ) ?? .usd
        let locale = AppLanguage(
            rawValue: preferences.languageCode ?? "auto"
        )?.locale ?? .autoupdatingCurrent

        let dataProviderID = limit?.providerID ?? nonEmpty(preferences.liveProviderID)
        let iconProviderID = nonEmpty(preferences.liveIconProviderID)
            ?? dataProviderID
            ?? usage.models.first.flatMap {
                ProviderPresentation.modelVendor(for: $0.id)
            }
        let providerName = ProviderPresentation.displayName(for: dataProviderID)
        let tokensValue = MetricFormatter.tokens(usage.tokens)
        let costValue = MetricFormatter.currencyFromUSD(
            usage.cost,
            currency: currency
        )
        let limitValue: String? = {
            guard let window = limit?.windows.first else { return nil }
            if let amount = window.amount, amount.isFinite {
                guard let code = window.currency, !code.isEmpty else {
                    return amount.formatted(.number.precision(.fractionLength(0...2)))
                }
                return MetricFormatter.currency(amount, code: code)
            }
            guard let remaining = window.remainingPercent else { return nil }
            return MetricFormatter.remaining(remaining, locale: locale)
        }()

        let primary: (String, String, Double?)
        switch preferences.livePrimaryMetric {
        case "cost":
            primary = (
                "Cost",
                costValue,
                nil
            )
        case "limit":
            primary = (providerName, limitValue ?? "—", limit?.windows.first?.remainingPercent.map { $0 / 100 })
        default:
            primary = ("Tokens", tokensValue, nil)
        }

        let configuredFields = [
            preferences.liveCompactTrailingField,
            preferences.liveExpandedLeadingField,
            preferences.liveExpandedCenterField,
            preferences.liveExpandedTrailingField,
            preferences.liveExpandedBottomField,
            preferences.liveLockScreenPrimaryField,
            preferences.liveLockScreenSecondaryField,
            preferences.liveLockScreenBottomField
        ]
        let shouldProvideSecondary = preferences.liveShowsSecondaryMetric
            || configuredFields.contains(TokenMonitorActivityAttributes.Field.secondary.rawValue)
        let shouldProvideProgress = preferences.liveShowsProgress
            || configuredFields.contains(TokenMonitorActivityAttributes.Field.progress.rawValue)

        let secondary: (String, String)?
        if !shouldProvideSecondary {
            secondary = nil
        } else if preferences.livePrimaryMetric == "limit" {
            secondary = (
                "Cost",
                costValue
            )
        } else if let limitValue {
            secondary = (providerName, limitValue)
        } else {
            secondary = nil
        }

        let progress = shouldProvideProgress
            ? limit?.windows.first?.remainingPercent.flatMap { value in
                value.isFinite ? min(1, max(0, value / 100)) : nil
            }
            : nil
        let usesLimit = preferences.livePrimaryMetric == "limit"
        let candidate = usesLimit ? limit?.updatedAt ?? .distantPast : snapshot.updatedAt
        let sourceDate = candidate <= now ? candidate : .distantPast
        let sourceStale = (usesLimit ? limit?.sourceStale == true : snapshot.sourceStale == true)
            || now.timeIntervalSince(sourceDate) >= 600

        return TokenMonitorActivityAttributes.ContentState(
            primaryLabel: primary.0,
            primaryValue: primary.1,
            secondaryLabel: secondary?.0,
            secondaryValue: secondary?.1,
            progress: progress,
            updatedAt: sourceDate,
            providerID: dataProviderID,
            providerName: providerName,
            iconProviderID: iconProviderID,
            tokensValue: tokensValue,
            costValue: costValue,
            limitValue: limitValue,
            compactTrailingField: preferences.liveCompactTrailingField,
            expandedLeadingField: preferences.liveExpandedLeadingField,
            expandedCenterField: preferences.liveExpandedCenterField,
            expandedTrailingField: preferences.liveExpandedTrailingField,
            expandedBottomField: preferences.liveExpandedBottomField,
            lockScreenPrimaryField: preferences.liveLockScreenPrimaryField,
            lockScreenSecondaryField: preferences.liveLockScreenSecondaryField,
            lockScreenBottomField: preferences.liveLockScreenBottomField,
            sourceStale: sourceStale
        )
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }

    private func preferredLimit(
        in snapshot: TokenMonitorSharedPayload.Snapshot,
        providerID: String?
    ) -> TokenMonitorSharedPayload.Limit? {
        if let providerID = nonEmpty(providerID) {
            return snapshot.limits.first(where: { $0.providerID == providerID })
        }
        return snapshot.limits.min { lhs, rhs in
            let left = lhs.windows.compactMap(\.remainingPercent).min() ?? 101
            let right = rhs.windows.compactMap(\.remainingPercent).min() ?? 101
            return left < right
        }
    }
}
