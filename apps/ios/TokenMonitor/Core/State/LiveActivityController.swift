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

    private let client: HubClient
    private var configuration: HubConfiguration?
    private var latestPreferences = TokenMonitorSharedPayload.Preferences.default
    private var pushTokens: [String: Data] = [:]
    private var tokenTasks: [String: Task<Void, Never>] = [:]

    private static let remoteActivityMigrationKey =
        "tokenMonitor.liveActivity.remoteTokenMigration.v1"

    init(client: HubClient = HubClient()) {
        self.client = client
        isActive = !Activity<TokenMonitorActivityAttributes>.activities.isEmpty
    }

    func configure(_ configuration: HubConfiguration?) {
        self.configuration = configuration
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
            await migrateExistingActivityIfNeeded()
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
        latestPreferences = preferences
        let content = ActivityContent(
            state: contentState(snapshot: snapshot, preferences: preferences),
            staleDate: snapshot.updatedAt.addingTimeInterval(600)
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
            errorMessage = nil
            isActive = true
        } catch {
            errorMessage = error.localizedDescription
            isActive = false
        }
    }

    private func endAll() async {
        for activity in Activity<TokenMonitorActivityAttributes>.activities {
            tokenTasks[activity.id]?.cancel()
            tokenTasks.removeValue(forKey: activity.id)
            pushTokens.removeValue(forKey: activity.id)
            if let configuration {
                try? await client.unregisterLiveActivity(
                    activityID: activity.id,
                    configuration: configuration
                )
            }
            await ActivityReference(activity: activity).end(nil, dismissalPolicy: .immediate)
        }
        errorMessage = nil
        isActive = false
        remoteUpdatesEnabled = false
        remoteUpdateMessage = nil
    }

    private func migrateExistingActivityIfNeeded() async {
        guard configuration != nil,
              !UserDefaults.standard.bool(forKey: Self.remoteActivityMigrationKey) else {
            return
        }

        for activity in Activity<TokenMonitorActivityAttributes>.activities {
            tokenTasks[activity.id]?.cancel()
            tokenTasks.removeValue(forKey: activity.id)
            pushTokens.removeValue(forKey: activity.id)
            await ActivityReference(activity: activity).end(
                nil,
                dismissalPolicy: .immediate
            )
        }
        UserDefaults.standard.set(true, forKey: Self.remoteActivityMigrationKey)
    }

    private func observePushToken(
        for activity: Activity<TokenMonitorActivityAttributes>
    ) {
        guard tokenTasks[activity.id] == nil else {
            return
        }
        let activityID = activity.id
        tokenTasks[activityID] = Task { [weak self] in
            for await pushToken in activity.pushTokenUpdates {
                guard let self else { return }
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
        guard let configuration else {
            return
        }
        do {
            let pushEnabled = try await client.registerLiveActivity(
                activityID: activityID,
                pushToken: pushToken,
                preferences: preferences,
                locale: resolvedLocaleIdentifier(for: preferences),
                configuration: configuration
            )
            remoteUpdatesEnabled = pushEnabled
            remoteUpdateMessage = pushEnabled
                ? nil
                : "Hub accepted the Activity, but APNs remote updates are not configured."
        } catch {
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

    private func contentState(
        snapshot: TokenMonitorSharedPayload.Snapshot,
        preferences: TokenMonitorSharedPayload.Preferences
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
            guard let remaining = limit?.windows.first?.remainingPercent else {
                return nil
            }
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
            if let limit, let window = limit.windows.first,
               let remaining = window.remainingPercent {
                primary = (
                    ProviderPresentation.displayName(for: limit.providerID),
                    MetricFormatter.remaining(remaining, locale: locale),
                    remaining / 100
                )
            } else {
                primary = ("Tokens", tokensValue, nil)
            }
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
        } else if let limit, let window = limit.windows.first,
                  let remaining = window.remainingPercent {
            secondary = (
                ProviderPresentation.displayName(for: limit.providerID),
                MetricFormatter.remaining(remaining, locale: locale)
            )
        } else {
            secondary = nil
        }

        let progress = shouldProvideProgress ? primary.2 : nil

        return TokenMonitorActivityAttributes.ContentState(
            primaryLabel: primary.0,
            primaryValue: primary.1,
            secondaryLabel: secondary?.0,
            secondaryValue: secondary?.1,
            progress: progress,
            updatedAt: snapshot.updatedAt,
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
            lockScreenBottomField: preferences.liveLockScreenBottomField
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
        if let providerID,
           let selected = snapshot.limits.first(
               where: { $0.providerID == providerID }
           ) {
            return selected
        }
        return snapshot.limits.min { lhs, rhs in
            let left = lhs.windows.compactMap(\.remainingPercent).min() ?? 101
            let right = rhs.windows.compactMap(\.remainingPercent).min() ?? 101
            return left < right
        }
    }
}
