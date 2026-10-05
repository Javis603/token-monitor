import Foundation
import Testing
@testable import TokenMonitor

@MainActor
struct AppPreferencesTests {
    @Test
    func defaultsHomeLimitCountToThreeAndClampsEdits() {
        let suiteName = "AppPreferencesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let preferences = AppPreferences(
            defaults: defaults,
            snapshotStore: SharedSnapshotStore(fileURL: nil)
        )

        #expect(preferences.homeLimitCount == 3)

        preferences.homeLimitCount = 0
        #expect(preferences.homeLimitCount == 1)

        preferences.homeLimitCount = 99
        #expect(preferences.homeLimitCount == 8)
    }

    @Test
    func persistsWidgetAndLiveActivityDefaultsToSharedPayload() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        let fileURL = directory.appending(path: "surfaces.json")
        let snapshotStore = SharedSnapshotStore(fileURL: fileURL)
        let suiteName = "AppPreferencesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let preferences = AppPreferences(
            defaults: defaults,
            snapshotStore: snapshotStore
        )

        preferences.widgetContent = .limits
        preferences.widgetPeriod = .month
        preferences.widgetProviderID = "claude"
        preferences.liveActivityEnabled = true
        preferences.livePrimaryMetric = .limit
        preferences.liveShowsSecondaryMetric = false
        preferences.liveShowsProgress = false
        preferences.liveIconProviderID = "claude"
        preferences.liveCompactTrailingField = "cost"
        preferences.liveExpandedLeadingField = "provider"
        preferences.liveExpandedCenterField = "limit"
        preferences.liveExpandedTrailingField = "updated"
        preferences.liveExpandedBottomField = "progress"
        preferences.liveLockScreenPrimaryField = "tokens"
        preferences.liveLockScreenSecondaryField = "cost"
        preferences.liveLockScreenBottomField = "none"
        preferences.currency = .hkd
        preferences.language = .traditionalChinese

        let persisted = try snapshotStore.load().preferences
        #expect(persisted.widgetContent == "limits")
        #expect(persisted.widgetPeriod == "month")
        #expect(persisted.widgetProviderID == "claude")
        #expect(persisted.liveActivityEnabled)
        #expect(persisted.livePrimaryMetric == "limit")
        #expect(!persisted.liveShowsSecondaryMetric)
        #expect(!persisted.liveShowsProgress)
        #expect(persisted.liveIconProviderID == "claude")
        #expect(persisted.liveCompactTrailingField == "cost")
        #expect(persisted.liveExpandedLeadingField == "provider")
        #expect(persisted.liveExpandedCenterField == "limit")
        #expect(persisted.liveExpandedTrailingField == "updated")
        #expect(persisted.liveExpandedBottomField == "progress")
        #expect(persisted.liveLockScreenPrimaryField == "tokens")
        #expect(persisted.liveLockScreenSecondaryField == "cost")
        #expect(persisted.liveLockScreenBottomField == "none")
        #expect(persisted.currencyCode == "HKD")
        #expect(persisted.languageCode == "zh-TW")
    }

    @Test
    func persistsRegionalPreferencesAndFormatsUSDWithoutCountryPrefix() {
        let suiteName = "AppPreferencesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let preferences = AppPreferences(
            defaults: defaults,
            snapshotStore: SharedSnapshotStore(fileURL: nil)
        )

        #expect(preferences.currency == .usd)
        #expect(preferences.language == .system)
        #expect(MetricFormatter.currencyFromUSD(48.4, currency: .usd) == "$48.40")
        #expect(MetricFormatter.currencyFromUSD(10, currency: .hkd) == "HK$78.00")
        #expect(
            MetricFormatter.remaining(
                35,
                locale: Locale(identifier: "zh-Hant")
            ) == "35% 剩餘"
        )
        #expect(
            MetricFormatter.accountCount(
                3,
                locale: Locale(identifier: "en")
            ) == "3 accounts"
        )
        #expect(
            AppCurrency.hkd.displayName(
                locale: Locale(identifier: "zh-Hant")
            ) == "HKD — 港幣"
        )

        preferences.currency = .twd
        preferences.language = .japanese

        let reloaded = AppPreferences(
            defaults: defaults,
            snapshotStore: SharedSnapshotStore(fileURL: nil)
        )
        #expect(reloaded.currency == .twd)
        #expect(reloaded.language == .japanese)
    }

    @Test
    func legacySurfacePreferencesKeepNewLiveActivityOptionsEnabled() throws {
        let data = Data(
            """
            {
              "widgetContent": "overview",
              "widgetPeriod": "today",
              "widgetShowsCost": true,
              "widgetShowsUpdateTime": true,
              "liveActivityEnabled": false,
              "livePrimaryMetric": "tokens",
              "livePeriod": "today",
              "currencyCode": "USD",
              "languageCode": "auto"
            }
            """.utf8
        )

        let preferences = try JSONDecoder().decode(
            TokenMonitorSharedPayload.Preferences.self,
            from: data
        )

        #expect(preferences.liveShowsSecondaryMetric)
        #expect(preferences.liveShowsProgress)
        #expect(preferences.liveIconProviderID == nil)
        #expect(preferences.liveCompactTrailingField == "primary")
        #expect(preferences.liveExpandedLeadingField == "provider")
        #expect(preferences.liveExpandedCenterField == "primary")
        #expect(preferences.liveExpandedTrailingField == "secondary")
        #expect(preferences.liveExpandedBottomField == "progress")
        #expect(preferences.liveLockScreenPrimaryField == "primary")
        #expect(preferences.liveLockScreenSecondaryField == "secondary")
        #expect(preferences.liveLockScreenBottomField == "progress")
    }

    @Test
    func routesTokenMonitorLinksToNativeTabs() throws {
        #expect(AppTab(url: try #require(URL(string: "tokenmonitor://overview"))) == .overview)
        #expect(AppTab(url: try #require(URL(string: "tokenmonitor://limits"))) == .limits)
        #expect(AppTab(url: try #require(URL(string: "tokenmonitor://insights"))) == .insights)
        #expect(AppTab(url: try #require(URL(string: "tokenmonitor://settings"))) == .settings)
        #expect(AppTab(url: try #require(URL(string: "https://example.com"))) == nil)
        #expect(AppTab(url: try #require(URL(string: "tokenmonitor://unknown"))) == nil)
    }
}
