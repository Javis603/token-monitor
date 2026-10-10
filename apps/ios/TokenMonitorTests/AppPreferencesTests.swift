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
        #expect(preferences.showsLiveTokenRate)

        preferences.homeLimitCount = 0
        #expect(preferences.homeLimitCount == 1)

        preferences.homeLimitCount = 99
        #expect(preferences.homeLimitCount == 8)

        preferences.showsLiveTokenRate = false
        let reloaded = AppPreferences(defaults: defaults, snapshotStore: SharedSnapshotStore(fileURL: nil))
        #expect(!reloaded.showsLiveTokenRate)
    }

    @Test
    func overviewLayoutPersistsSectionOrderAndVisibility() {
        let suiteName = "OverviewLayoutTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let preferences = AppPreferences(
            defaults: defaults,
            snapshotStore: SharedSnapshotStore(fileURL: nil)
        )
        preferences.overviewSectionOrder = ["models", "summary", "limits", "trend", "tools", "devices"]
        preferences.hiddenOverviewSections = ["trend", "devices"]

        let reloaded = AppPreferences(
            defaults: defaults,
            snapshotStore: SharedSnapshotStore(fileURL: nil)
        )
        #expect(OverviewSection.ordered(by: reloaded.overviewSectionOrder).map(\.id) ==
            ["models", "summary", "limits", "trend", "tools", "devices"])
        #expect(reloaded.hiddenOverviewSections == ["trend", "devices"])
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
        var layout = LiveActivityLayout()
        layout.compactLeading = .init(style: .percentReset, source: .init(providerID: "codex", accountKey: "work", window: .weekly, value: .used))
        layout.compactTrailing = .init(style: .tokens, source: .init(period: .month, scope: .recent))
        layout.expanded = .providers
        layout.lockScreen = .quota
        layout.minimal = .percent
        layout.lockScreenSource = .init(automatic: .recent)
        preferences.liveLayout = layout
        preferences.currency = .hkd
        preferences.language = .traditionalChinese

        let persisted = try snapshotStore.load().preferences
        #expect(persisted.widgetContent == "limits")
        #expect(persisted.widgetPeriod == "month")
        #expect(persisted.widgetProviderID == "claude")
        #expect(persisted.liveActivityEnabled)
        #expect(persisted.liveLayout.referencedProviderIDs == ["codex"])
        #expect(persisted.liveLayout.referencedAccountKeys == ["work"])
        #expect(persisted.liveLayout == layout)
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
    func legacySurfacePreferencesDecodeWithLayoutDefaults() throws {
        // Old payloads carry removed live* keys; unknown keys are ignored and
        // the layout falls back to its defaults.
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
              "liveIconProviderID": "claude",
              "liveCompactTrailingField": "cost",
              "liveLockScreenBottomField": "progress",
              "liveCompactLeading": "mark",
              "currencyCode": "USD",
              "languageCode": "auto"
            }
            """.utf8
        )

        let preferences = try JSONDecoder().decode(
            TokenMonitorSharedPayload.Preferences.self,
            from: data
        )

        #expect(preferences.liveLayout == LiveActivityLayout())
    }

    @Test
    func liveLayoutDecodesUnknownValuesFieldByField() throws {
        let data = Data(#"{"compactLeading":{"style":"agents","source":{"providerID":"claude","window":"hourly","value":"used"}},"compactTrailing":"bogus","expanded":"usage","lockScreenSource":{"scope":7}}"#.utf8)
        let layout = try JSONDecoder().decode(LiveActivityLayout.self, from: data)
        #expect(layout.compactLeading.style == .agents)
        #expect(layout.compactLeading.source.providerID == "claude")
        #expect(layout.compactLeading.source.window == .primary)
        #expect(layout.compactLeading.source.value == .used)
        #expect(layout.compactTrailing == LiveActivityLayout().compactTrailing)
        #expect(layout.expanded == .usage)
        #expect(layout.lockScreenSource == .init())
        #expect(layout.lockScreen == .overview)
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
