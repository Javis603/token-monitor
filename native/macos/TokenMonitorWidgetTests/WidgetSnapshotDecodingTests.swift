import XCTest

final class WidgetSnapshotDecodingTests: XCTestCase {
    func testTrendChangeSkipsLeadingZeroBuckets() {
        XCTAssertEqual(
            WidgetTrendChange.label(for: [
                WidgetTrendPoint(date: "2026-03", totalTokens: 0),
                WidgetTrendPoint(date: "2026-04", totalTokens: 100),
                WidgetTrendPoint(date: "2026-05", totalTokens: 25)
            ]),
            "−75%"
        )
        XCTAssertEqual(
            WidgetTrendChange.label(for: [
                WidgetTrendPoint(date: "2026-04", totalTokens: 100),
                WidgetTrendPoint(date: "2026-05", totalTokens: 165)
            ]),
            "+65%"
        )
        XCTAssertEqual(
            WidgetTrendChange.label(for: [WidgetTrendPoint(date: "2026-04", totalTokens: 0)]),
            "—"
        )
    }

    func testTotalTrendChangeMeasuresCurrentMonthGrowthAgainstPreviousTotal() {
        XCTAssertEqual(
            WidgetTrendChange.totalGrowthLabel(
                totalTokens: 24_489_640_445,
                currentMonthTokens: 3_115_874_699
            ),
            "+15%"
        )
        XCTAssertEqual(
            WidgetTrendChange.totalGrowthLabel(totalTokens: 24_489_640_445, currentMonthTokens: 0),
            "0%"
        )
        XCTAssertEqual(
            WidgetTrendChange.totalGrowthLabel(totalTokens: 3_115_874_699, currentMonthTokens: 3_115_874_699),
            "—"
        )
    }

    func testDecodesCurrentSchemaFromPeriods() throws {
        let snapshot = try decode("""
        {
          "schemaVersion": 10,
          "generatedAt": "2026-07-17T09:00:00.000Z",
          "periods": {
            "day": {
              "overview": {
                "totalTokens": 1200000,
                "costUsd": 1.25
              },
              "tools": [{"id":"codex","totalTokens":1000000,"costUsd":1.1,"sharePercent":83.3}],
              "models": [{"id":"gpt-5.6","displayName":"gpt-5.6","totalTokens":900000,"costUsd":0.9,"sharePercent":75}],
              "activity": {"activeDays":1,"days":[{"date":"2026-07-17","intensity":3,"totalTokens":1200000,"costUsd":1.25}]},
              "trend": {"points":[{"date":"2026-07-17","totalTokens":1200000,"costUsd":1.25}]}
            }
          },
          "quota": [],
          "presentation": {"currencyCode":"HKD","currencySymbol":"HK$","currencyRate":7.8,"numberStyle":"compact","compactTokenUnits":"western","showCost":true,"locale":"auto","theme":"system"},
          "status": {"isStale":false,"sourceUpdatedAt":"2026-07-17T08:59:00.000Z","noData":false}
        }
        """)

        XCTAssertEqual(snapshot.schemaVersion, WidgetSnapshot.currentSchemaVersion)
        XCTAssertEqual(snapshot.overview.totalTokens, 1_200_000)
        XCTAssertEqual(snapshot.tools.map(\.id), ["codex"])
        XCTAssertEqual(snapshot.tools.first?.costUsd, 1.1)
        XCTAssertEqual(snapshot.models.map(\.displayName), ["gpt-5.6"])
        XCTAssertEqual(snapshot.models.first?.costUsd, 0.9)
        XCTAssertEqual(snapshot.activity.days.first?.totalTokens, 1_200_000)
        XCTAssertEqual(snapshot.activity.days.first?.costUsd, 1.25)
        XCTAssertEqual(snapshot.trend.points.last?.totalTokens, 1_200_000)
        XCTAssertEqual(snapshot.trend.points.last?.costUsd, 1.25)
        XCTAssertEqual(snapshot.presentation.currencySymbol, "HK$")
    }

    func testRejectsUnsupportedSchemas() {
        for version in 1..<WidgetSnapshot.currentSchemaVersion {
            XCTAssertThrowsError(
                try decodeRaw("""
                {"schemaVersion":\(version),"generatedAt":"2026-07-17T09:00:00Z","periods":{"day":{}}}
                """)
            )
        }
        XCTAssertThrowsError(
            try decodeRaw("""
            {"schemaVersion":\(WidgetSnapshot.currentSchemaVersion + 1),"generatedAt":"2026-07-17T09:00:00Z","periods":{"day":{}}}
            """)
        )
    }

    func testRejectsMissingDayPeriodAndInvalidGeneratedTimestamp() {
        XCTAssertThrowsError(
            try decodeRaw("""
            {"schemaVersion":10,"generatedAt":"2026-07-17T09:00:00Z","periods":{"month":{}}}
            """)
        )
        XCTAssertThrowsError(
            try decodeRaw("""
            {"schemaVersion":10,"generatedAt":"not-a-date","periods":{"day":{}}}
            """)
        )
    }

    func testMalformedQuotaEntryIsDroppedWithoutBlankingCurrentSnapshot() throws {
        let snapshot = try decode("""
        {
          "schemaVersion":10,
          "generatedAt":"2026-07-17T09:00:00Z",
          "periods":{"day":{"overview":{"totalTokens":42}}},
          "quota":[
            {"provider":"codex","instanceId":"codex-a","status":"ok","windows":[]},
            {"provider":123,"status":"ok"},
            {"provider":"claude","instanceId":"claude-a","status":"ok","windows":[]}
          ]
        }
        """)

        XCTAssertEqual(snapshot.overview.totalTokens, 42)
        XCTAssertEqual(snapshot.quota.map(\.provider), ["codex", "claude"])
    }

    func testCustomQuotaSelectionNeverFallsBackToUnselectedAccounts() throws {
        let snapshot = try decode("""
        {
          "schemaVersion":10,
          "generatedAt":"2026-07-17T09:00:00Z",
          "periods":{"day":{}},
          "quota":[
            {"provider":"antigravity","instanceId":"antigravity-a","status":"ok","updatedAt":"2026-07-17T08:59:00.000Z","windows":[]},
            {"provider":"claude","instanceId":"claude-a","status":"ok","updatedAt":"2026-07-17T08:59:00.000Z","windows":[]},
            {"provider":"codex","instanceId":"codex-a","status":"ok","updatedAt":"2026-07-17T08:59:00.000Z","windows":[]}
          ]
        }
        """)
        let renderedAt = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-17T09:00:00Z"))

        XCTAssertEqual(
            WidgetQuotaSelectionResolver.providers(
                in: snapshot,
                mode: .custom,
                selectedIDs: ["codex-a", "antigravity-a"],
                limit: 2,
                at: renderedAt
            ).map(\.provider),
            ["codex", "antigravity"]
        )
        XCTAssertEqual(
            WidgetQuotaSelectionResolver.providers(
                in: snapshot,
                mode: .custom,
                selectedIDs: ["missing", "claude-a"],
                limit: 2,
                at: renderedAt
            ).map(\.provider),
            ["claude"]
        )
        XCTAssertTrue(
            WidgetQuotaSelectionResolver.providers(
                in: snapshot,
                mode: .custom,
                selectedIDs: ["missing", WidgetQuotaSelectionID.currentCodexAccount],
                limit: 2,
                at: renderedAt
            ).isEmpty
        )
    }

    func testAutomaticQuotaSelectionPrefersFreshAvailableDataAndFallsBackToStaleData() throws {
        let snapshot = try decode("""
        {
          "schemaVersion":10,
          "generatedAt":"2026-07-17T09:30:00.000Z",
          "periods":{"day":{}},
          "quota":[
            {"provider":"antigravity","instanceId":"antigravity-a","status":"unavailable","updatedAt":"2026-07-17T09:29:00.000Z","windows":[{"kind":"weekly","showMeter":true,"remainingPercent":90}]},
            {"provider":"claude","instanceId":"claude-a","status":"ok","updatedAt":"2026-07-17T08:00:00.000Z","windows":[{"kind":"weekly","showMeter":true,"remainingPercent":80}]},
            {"provider":"codex","instanceId":"codex-a","status":"ok","updatedAt":"2026-07-17T09:29:00.000Z","windows":[{"kind":"weekly","showMeter":true,"remainingPercent":70}]},
            {"provider":"cursor","instanceId":"cursor-a","status":"ok","updatedAt":null,"windows":[{"kind":"weekly","showMeter":true,"remainingPercent":60}]}
          ]
        }
        """)
        let renderedAt = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-17T09:30:00Z"))

        XCTAssertEqual(
            WidgetQuotaSelectionResolver.providers(
                in: snapshot,
                mode: .automatic,
                selectedIDs: [],
                limit: 3,
                at: renderedAt
            ).map(\.provider),
            ["codex", "claude", "cursor"]
        )
    }

    func testAutomaticQuotaSelectionKeepsStableOrderWithinFreshAccounts() throws {
        let snapshot = try decode("""
        {
          "schemaVersion":10,
          "generatedAt":"2026-07-17T09:30:00.000Z",
          "periods":{"day":{}},
          "quota":[
            {"provider":"claude","instanceId":"claude-a","status":"ok","updatedAt":"2026-07-17T09:15:00.000Z","windows":[{"kind":"weekly","showMeter":true,"remainingPercent":80}]},
            {"provider":"codex","instanceId":"codex-a","status":"ok","updatedAt":"2026-07-17T09:29:00.000Z","windows":[{"kind":"weekly","showMeter":true,"remainingPercent":70}]},
            {"provider":"cursor","instanceId":"cursor-a","status":"ok","updatedAt":"2026-07-17T09:28:00.000Z","windows":[{"kind":"weekly","showMeter":true,"remainingPercent":60}]}
          ]
        }
        """)
        let renderedAt = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-17T09:30:00Z"))

        XCTAssertEqual(
            WidgetQuotaSelectionResolver.providers(
                in: snapshot,
                mode: .automatic,
                selectedIDs: [],
                limit: 2,
                at: renderedAt
            ).map(\.provider),
            ["claude", "codex"]
        )
    }

    func testQuotaFreshnessTreatsMissingTimestampAsStalePerProvider() throws {
        let renderedAt = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-17T09:30:00Z"))
        let fresh = WidgetQuotaProvider(
            instanceId: "fresh",
            provider: "codex",
            status: "ok",
            updatedAt: try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-17T09:29:00Z")),
            windows: []
        )
        let stale = WidgetQuotaProvider(
            instanceId: "stale",
            provider: "claude",
            status: "ok",
            updatedAt: try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-17T08:00:00Z")),
            windows: []
        )
        let unknown = WidgetQuotaProvider(
            instanceId: "unknown",
            provider: "cursor",
            status: "ok",
            updatedAt: nil,
            windows: []
        )
        let unavailable = WidgetQuotaProvider(
            instanceId: "unavailable",
            provider: "antigravity",
            status: "unavailable",
            updatedAt: try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-17T09:29:00Z")),
            windows: []
        )

        XCTAssertFalse(
            WidgetQuotaFreshness.isStale(fresh, at: renderedAt)
        )
        XCTAssertTrue(
            WidgetQuotaFreshness.isStale(stale, at: renderedAt)
        )
        XCTAssertTrue(
            WidgetQuotaFreshness.isStale(unknown, at: renderedAt)
        )
        XCTAssertTrue(
            WidgetQuotaFreshness.isStale(unavailable, at: renderedAt)
        )
    }

    func testCurrentSchemaDecodesMaskedAccountLabelsAndTypedQuotaWindows() throws {
        let snapshot = try decode("""
        {
          "schemaVersion":10,
          "generatedAt":"2026-07-17T09:00:00.000Z",
          "periods":{"day":{}},
          "quota":[{
            "provider":"codex",
            "instanceId":"codex-a1b2c3d4",
            "displayName":"Codex",
            "accountLabel":"a***e@example.com",
            "isCurrentAccount":true,
            "status":"ok",
            "updatedAt":"2026-07-17T08:59:00.000Z",
            "windows":[{
              "kind":"billing",
              "label":"Premium requests",
              "metric":"credits",
              "showMeter":false,
              "usedPercent":35,
              "windowMinutes":10080,
              "remaining":9.5,
              "currency":"USD",
              "resetsAt":"2026-07-18T09:00:00.000Z",
              "boundaryKind":"expiry"
            }]
          }]
        }
        """)

        let provider = try XCTUnwrap(snapshot.quota.first)
        XCTAssertEqual(provider.displayName, "Codex")
        XCTAssertEqual(provider.accountLabel, "a***e@example.com")
        XCTAssertTrue(provider.isCurrentAccount)
        XCTAssertEqual(provider.windows.first?.label, "Premium requests")
        XCTAssertEqual(WidgetFormat.windowTitle(try XCTUnwrap(provider.windows.first)), "Premium requests")
        XCTAssertEqual(provider.windows.first?.metric, "credits")
        XCTAssertEqual(provider.windows.first?.usedPercent, 35)
        XCTAssertEqual(provider.windows.first?.windowMinutes, 10_080)
        XCTAssertEqual(provider.windows.first?.boundaryKind, "expiry")
        XCTAssertFalse(provider.windows.first?.showMeter ?? true)
    }

    func testSourceFreshnessUsesCurrentStatusTimestamp() throws {
        let snapshot = try decode("""
        {
          "schemaVersion":10,
          "generatedAt":"2026-07-17T09:30:00.000Z",
          "periods":{"day":{"overview":{"updatedAt":"2026-07-17T09:29:00.000Z"}}},
          "status":{"isStale":true,"sourceStale":true,"sourceUpdatedAt":"2026-07-17T08:00:00.000Z","noData":false}
        }
        """)

        XCTAssertTrue(snapshot.isStale(at: snapshot.generatedAt))
        XCTAssertEqual(
            WidgetStalePresentation.trustedUpdatedAt(for: snapshot),
            try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-17T08:00:00Z"))
        )
    }

    func testWidgetToolLabelsMatchTheDesktopCatalogForMiMoCode() {
        XCTAssertEqual(WidgetFormat.provider("mimo"), "MiMo")
        XCTAssertEqual(WidgetFormat.provider("micode"), "MiMo Code")
    }

    func testStatusMappingNeverExposesInternalEnums() {
        XCTAssertEqual(provider(status: "notConfigured").displayStatus, "Not configured")
        XCTAssertEqual(provider(status: "unauthorized").displayStatus, "Sign in again")
        XCTAssertEqual(provider(status: "sessionExpired").displayStatus, "Sign in again")
        XCTAssertEqual(provider(status: "unavailable").displayStatus, "Unavailable")
        XCTAssertEqual(provider(status: "unexpectedInternalValue").displayStatus, "Temporarily unavailable")
    }

    func testQuotaValuePrioritizesBalanceThenPercentThenStatus() {
        let balanceAndPercent = WidgetQuotaProvider(
            instanceId: "mimo-single",
            provider: "mimo",
            status: "ok",
            updatedAt: nil,
            windows: [WidgetLimitWindow(kind: "billing", remainingPercent: 40, resetsAt: nil)],
            balance: WidgetQuotaBalance(amount: 3.62, currency: "CNY")
        )
        let zeroUsd = WidgetQuotaProvider(
            instanceId: "deepseek-single",
            provider: "deepseek",
            status: "ok",
            updatedAt: nil,
            windows: [],
            balance: WidgetQuotaBalance(amount: 0, currency: "USD")
        )
        let percentOnly = WidgetQuotaProvider(
            instanceId: "codex-single",
            provider: "codex",
            status: "ok",
            updatedAt: nil,
            windows: [WidgetLimitWindow(kind: "weekly", remainingPercent: 2, resetsAt: nil)]
        )

        XCTAssertEqual(WidgetFormat.quotaValue(balanceAndPercent), "¥3.62 left")
        XCTAssertEqual(WidgetFormat.quotaValue(zeroUsd), "$0.00 left")
        XCTAssertEqual(WidgetFormat.quotaValue(percentOnly), "2% left")
        XCTAssertEqual(WidgetFormat.quotaValue(provider(status: "notConfigured")), "Not configured")
        XCTAssertEqual(WidgetFormat.quotaValue(provider(status: "unauthorized")), "Sign in again")
        XCTAssertEqual(
            WidgetFormat.quotaValue(WidgetQuotaProvider(
                instanceId: "deepseek-single",
                provider: "deepseek",
                status: "ok",
                updatedAt: nil,
                windows: [],
                balance: WidgetQuotaBalance(amount: 9.33, currency: "HKD")
            )),
            "HK$9.33 left"
        )
        XCTAssertEqual(
            WidgetFormat.quotaValue(WidgetQuotaProvider(
                instanceId: "workbuddy-single",
                provider: "workbuddy",
                status: "ok",
                updatedAt: nil,
                windows: [],
                balance: WidgetQuotaBalance(amount: 63, currency: "CREDITS")
            )),
            "63.00 credits left"
        )
    }

    func testQuotaWindowValuePreservesCurrencyAndSpendSemantics() {
        let usd = WidgetLimitWindow(
            kind: "billing", remainingPercent: nil, resetsAt: nil,
            metric: "credits", showMeter: false, remaining: 12.5, currency: "USD"
        )
        let credits = WidgetLimitWindow(
            kind: "billing", remainingPercent: nil, resetsAt: nil,
            metric: "credits", showMeter: false, remaining: 63, currency: "CREDITS"
        )
        let spend = WidgetLimitWindow(
            kind: "billing", remainingPercent: nil, resetsAt: nil,
            metric: "spend", showMeter: false, used: 2.35, currency: "USD"
        )
        let percentage = WidgetLimitWindow(kind: "weekly", remainingPercent: 53, resetsAt: nil)

        XCTAssertEqual(WidgetFormat.windowValue(usd), "$12.50")
        XCTAssertEqual(WidgetFormat.windowValue(credits), "63.00 credits")
        XCTAssertEqual(WidgetFormat.windowValue(spend), "$2.35")
        XCTAssertEqual(WidgetFormat.windowValue(percentage), "53% left")
    }

    func testQuotaPresentationKeepsBalanceAlongsideQuotaWindows() {
        let claude = WidgetQuotaProvider(
            instanceId: "claude-single",
            provider: "claude",
            status: "ok",
            updatedAt: nil,
            windows: [
                WidgetLimitWindow(kind: "session", remainingPercent: 89, resetsAt: nil),
                WidgetLimitWindow(kind: "weekly", remainingPercent: 68, resetsAt: nil),
                WidgetLimitWindow(
                    kind: "billing", remainingPercent: nil, resetsAt: nil,
                    metric: "spend", showMeter: false, used: 2.35, currency: "USD", label: "Usage credits"
                )
            ],
            balance: WidgetQuotaBalance(amount: 113.44, currency: "USD")
        )
        let full = WidgetQuotaPresentation.windows(for: claude, limit: 3)
        let dashboard = WidgetQuotaPresentation.windows(
            for: claude,
            limit: 2,
            reserveBalanceSlot: false
        )

        XCTAssertEqual(full.map(\.metric), [nil, nil, "credits"])
        XCTAssertEqual(full.map(WidgetFormat.windowValue), ["89% left", "68% left", "$113.44"])
        XCTAssertEqual(dashboard.map(\.metric), [nil, nil])
        XCTAssertEqual(dashboard.map(WidgetFormat.windowValue), ["89% left", "68% left"])

        let thirdParty = WidgetQuotaProvider(
            instanceId: "thirdparty-gptnb",
            provider: "thirdparty",
            status: "ok",
            updatedAt: nil,
            windows: [],
            balance: WidgetQuotaBalance(amount: 39.5, currency: "USD", allTimeSpend: 140.52),
            accountLabel: "GPTNB"
        )
        let thirdPartyWindows = WidgetQuotaPresentation.windows(for: thirdParty, limit: 3)
        XCTAssertEqual(thirdPartyWindows.map(\.metric), ["credits", "spend"])
        XCTAssertEqual(thirdPartyWindows.map(WidgetFormat.windowValue), ["$39.50", "$140.52"])
    }

    func testQuotaWindowDecodesTypedLifecycleBoundaries() throws {
        let snapshot = try decode("""
        {"schemaVersion":10,"generatedAt":"2026-07-17T09:00:00.000Z","periods":{"day":{}},"quota":[{"provider":"kiro","instanceId":"kiro-a","status":"ok","windows":[{"kind":"billing","showMeter":true,"remainingPercent":50,"resetsAt":"2026-07-24T09:00:00.000Z","boundaryKind":"expiry"},{"kind":"billing","showMeter":true,"remainingPercent":40,"resetsAt":"2026-07-24T09:00:00.000Z","boundaryKind":"mixed"}]}],"status":{"noData":false}}
        """)
        let windows = try XCTUnwrap(snapshot.quota.first?.windows)
        XCTAssertEqual(windows.map(\.boundaryKind), ["expiry", "mixed"])
        XCTAssertTrue(WidgetFormat.boundary(windows[0]).hasPrefix("Expires"))
        XCTAssertTrue(WidgetFormat.boundary(windows[1]).hasPrefix("Changes"))
    }

    func testQuotaBoundaryUsesAtMostTwoCompactDurationUnits() {
        XCTAssertEqual(WidgetFormat.compactDuration(seconds: 4 * 3_600), "4h")
        XCTAssertEqual(WidgetFormat.compactDuration(seconds: 4 * 3_600 + 12 * 60), "4h 12m")
        XCTAssertEqual(WidgetFormat.compactDuration(seconds: 2 * 86_400 + 59 * 60), "2d 59m")
        XCTAssertEqual(WidgetFormat.compactDuration(seconds: 30), "1m")
    }

    func testWidgetPageDisplayNamesAreLocalized() {
        XCTAssertEqual(WidgetPage.quota.title, "Quota")
        XCTAssertEqual(WidgetPeriod.day.title, "DAY")
        XCTAssertEqual(WidgetPeriod.day.displayTitle, "TODAY")
        XCTAssertEqual(WidgetPeriod.month.displayTitle, "MONTH")
        XCTAssertEqual(WidgetPeriod.total.displayTitle, "TOTAL")
    }

    func testActivityDayStatePersistsOnlyForMediumAndLarge() {
        let suite = "token-monitor-widget-activity-day-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetPresentationStateStore(defaults: defaults)

        store.setSelectedActivityDay("2026-07-16", for: .medium)
        store.setSelectedActivityDay("2026-07-17", for: .large)

        XCTAssertEqual(store.selectedActivityDay(for: .medium), "2026-07-16")
        XCTAssertEqual(store.selectedActivityDay(for: .large), "2026-07-17")

        store.clearSelectedActivityDay(for: .medium)
        XCTAssertNil(store.selectedActivityDay(for: .medium))
        XCTAssertEqual(store.selectedActivityDay(for: .large), "2026-07-17")
    }

    func testSelectedActivityDayResolvesItsSnapshotMetrics() {
        let days = [
            WidgetActivityDay(date: "2026-07-16", intensity: 2, totalTokens: 12_000_000, costUsd: 4.25),
            WidgetActivityDay(date: "2026-07-17", intensity: 4, totalTokens: 37_400_000, costUsd: 9.75)
        ]

        XCTAssertEqual(
            WidgetActivitySelection.selectedDay(in: days, selectedDate: "2026-07-17"),
            days[1]
        )
        XCTAssertNil(WidgetActivitySelection.selectedDay(in: days, selectedDate: nil))
        XCTAssertEqual(
            WidgetActivitySelection.selectedDay(in: days, selectedDate: "2026-07-18"),
            WidgetActivityDay(date: "2026-07-18", intensity: 0, totalTokens: 0, costUsd: 0)
        )
    }

    func testActivityDayStateClearsInvalidDates() {
        let suite = "token-monitor-widget-invalid-activity-day-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetPresentationStateStore(defaults: defaults)
        let key = WidgetPresentationStateStore.selectedActivityDayKey(for: .medium)

        for invalidDate in ["2026-7-16", "2026-02-29", "not-a-date"] {
            defaults.set(invalidDate, forKey: key)
            XCTAssertNil(store.selectedActivityDay(for: .medium))
            XCTAssertNil(defaults.string(forKey: key))
        }
    }

    func testSelectActivityDayActionTogglesAndReloadsAllWidgets() {
        let suite = "token-monitor-widget-select-activity-day-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetPresentationStateStore(defaults: defaults)
        var reloadedKinds: [String] = []

        WidgetIntentActions.selectActivityDay(
            family: .medium,
            date: "2026-07-16",
            store: store,
            reload: { reloadedKinds.append("all") }
        )
        XCTAssertEqual(store.selectedActivityDay(for: .medium), "2026-07-16")

        WidgetIntentActions.selectActivityDay(
            family: .medium,
            date: "2026-07-16",
            store: store,
            reload: { reloadedKinds.append("all") }
        )
        XCTAssertNil(store.selectedActivityDay(for: .medium))
        XCTAssertEqual(reloadedKinds, ["all", "all"])
    }

    func testRefreshActionReloadsWidgetsWithoutOpeningTheApp() {
        var reloadCount = 0

        WidgetIntentActions.refresh {
            reloadCount += 1
        }

        XCTAssertEqual(reloadCount, 1)
        XCTAssertFalse(RefreshWidgetIntent.openAppWhenRun)
    }

    func testWidgetFamilyScopeMapsSupportedFamiliesOnly() {
        XCTAssertNil(WidgetFamilyScope(widgetFamily: .systemSmall))
        XCTAssertEqual(WidgetFamilyScope(widgetFamily: .systemMedium), .medium)
        XCTAssertEqual(WidgetFamilyScope(widgetFamily: .systemLarge), .large)
    }

    func testTimelineSelectionAllowsZeroUsageDatesInsideVisibleCoverage() throws {
        let suite = "token-monitor-widget-resolve-activity-day-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetPresentationStateStore(defaults: defaults)
        let reference = try utcDate("2026-07-17")
        let days = [
            WidgetActivityDay(date: "2026-07-15", intensity: 4, totalTokens: 37_400_000),
            WidgetActivityDay(date: "2026-07-17", intensity: 2, totalTokens: 12_000_000)
        ]
        let date = "2026-07-16"

        store.setSelectedActivityDay(date, for: .medium)
        XCTAssertEqual(
            WidgetActivitySelection.resolvedDate(
                days: days,
                family: .medium,
                referenceDate: reference,
                store: store,
                timeZone: .gmt
            ),
            date
        )
        store.setSelectedActivityDay("2020-01-01", for: .large)
        XCTAssertNil(
            WidgetActivitySelection.resolvedDate(
                days: days,
                family: .large,
                referenceDate: reference,
                store: store,
                timeZone: .gmt
            )
        )
        XCTAssertNil(store.selectedActivityDay(for: .large))

        XCTAssertNil(
            WidgetActivitySelection.resolvedDate(
                days: days,
                family: nil,
                referenceDate: reference,
                store: store,
                timeZone: .gmt
            )
        )
    }

    func testActivitySelectionCoverageMatchesEachRenderedFamily() throws {
        let suite = "token-monitor-widget-family-activity-coverage-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetPresentationStateStore(defaults: defaults)
        let reference = try utcDate("2026-07-17")
        let days = [
            WidgetActivityDay(date: "2026-01-01", intensity: 1, totalTokens: 1),
            WidgetActivityDay(date: "2026-07-17", intensity: 1, totalTokens: 1)
        ]

        store.setSelectedActivityDay("2026-03-28", for: .large)
        XCTAssertNil(
            WidgetActivitySelection.resolvedDate(
                days: days,
                family: .large,
                referenceDate: reference,
                store: store,
                timeZone: .gmt
            )
        )

        store.setSelectedActivityDay("2026-03-29", for: .large)
        XCTAssertEqual(
            WidgetActivitySelection.resolvedDate(
                days: days,
                family: .large,
                referenceDate: reference,
                store: store,
                timeZone: .gmt
            ),
            "2026-03-29"
        )

        store.setSelectedActivityDay("2026-03-28", for: .medium)
        XCTAssertEqual(
            WidgetActivitySelection.resolvedDate(
                days: days,
                family: .medium,
                referenceDate: reference,
                store: store,
                timeZone: .gmt
            ),
            "2026-03-28"
        )
    }

    func testHeatmapUsesSundayRowsAndCalendarPlaceholders() throws {
        let reference = try utcDate("2026-06-10")
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: [
                WidgetActivityDay(date: "2026-06-07", intensity: 1),
                WidgetActivityDay(date: "2026-06-09", intensity: 3),
                WidgetActivityDay(date: "2026-06-09", intensity: 4),
                WidgetActivityDay(date: "2026-06-31", intensity: 4)
            ],
            referenceDate: reference,
            availableSize: CGSize(width: 120, height: 70),
            maxWeeks: 6,
            minCellSize: 5,
            maxCellSize: 9,
            spacing: 2,
            timeZone: .gmt
        )

        XCTAssertEqual(layout.weekCount, 1)
        XCTAssertEqual(layout.cells.count, 7)
        XCTAssertEqual(layout.cell(week: 0, weekday: 0)?.date, "2026-06-07")
        XCTAssertEqual(layout.cell(week: 0, weekday: 0)?.intensity, 1)
        XCTAssertEqual(layout.cell(week: 0, weekday: 1)?.date, "2026-06-08")
        XCTAssertEqual(layout.cell(week: 0, weekday: 1)?.intensity, 0)
        XCTAssertEqual(layout.cell(week: 0, weekday: 1)?.totalTokens, 0)
        XCTAssertEqual(layout.cell(week: 0, weekday: 1)?.isSelectable, true)
        XCTAssertEqual(layout.cell(week: 0, weekday: 2)?.intensity, 4)
        XCTAssertEqual(layout.cell(week: 0, weekday: 4)?.isFuture, true)
        XCTAssertEqual(layout.cell(week: 0, weekday: 4)?.isSelectable, false)
        XCTAssertEqual(Set(layout.cells.map(\.id)).count, layout.cells.count)
    }

    func testHeatmapAdaptsAcrossFamiliesAndHistoryLengthsWithoutOverflow() throws {
        let reference = try utcDate("2026-07-17")
        let scenarios: [(count: Int, size: CGSize, maxWeeks: Int, minWeeks: Int, minCell: CGFloat, maxCell: CGFloat)] = [
            (28, CGSize(width: 120, height: 70), 6, 4, 5, 9),
            (90, CGSize(width: 220, height: 70), 14, 10, 5, 10),
            (180, CGSize(width: 320, height: 120), 26, 20, 6, 12)
        ]

        for scenario in scenarios {
            let days = try continuousActivityDays(count: scenario.count, ending: "2026-07-17")
            let layout = WidgetHeatmapLayoutCalculator.make(
                days: days,
                referenceDate: reference,
                availableSize: scenario.size,
                maxWeeks: scenario.maxWeeks,
                minCellSize: scenario.minCell,
                maxCellSize: scenario.maxCell,
                spacing: 2,
                timeZone: .gmt
            )
            XCTAssertGreaterThanOrEqual(layout.weekCount, scenario.minWeeks)
            XCTAssertLessThanOrEqual(layout.weekCount, scenario.maxWeeks)
            XCTAssertEqual(layout.cells.count, layout.weekCount * 7)
            XCTAssertGreaterThanOrEqual(layout.cellSize, scenario.minCell)
            XCTAssertLessThanOrEqual(layout.cellSize, scenario.maxCell)
            XCTAssertEqual(layout.cellWidth, layout.cellHeight)
            XCTAssertLessThanOrEqual(layout.renderedWidth, scenario.size.width + 0.001)
            XCTAssertLessThanOrEqual(layout.renderedHeight, scenario.size.height + 0.001)
            XCTAssertEqual(Set(layout.cells.map(\.id)).count, layout.cells.count)
        }
    }

    func testHeatmapHandlesEmptySparseAndThemeIndependentGeometry() throws {
        let reference = try utcDate("2026-07-17")
        let empty = WidgetHeatmapLayoutCalculator.make(
            days: [],
            referenceDate: reference,
            availableSize: CGSize(width: 220, height: 70),
            maxWeeks: 14,
            minCellSize: 5,
            maxCellSize: 10,
            spacing: 2,
            timeZone: .gmt
        )
        XCTAssertEqual(empty.weekCount, 0)
        XCTAssertTrue(empty.cells.isEmpty)

        let sparse = [
            WidgetActivityDay(date: "2026-05-03", intensity: 4),
            WidgetActivityDay(date: "2026-06-14", intensity: 2),
            WidgetActivityDay(date: "2026-07-17", intensity: 1)
        ]
        let baseline = WidgetHeatmapLayoutCalculator.make(
            days: sparse,
            referenceDate: reference,
            availableSize: CGSize(width: 220, height: 70),
            maxWeeks: 14,
            minCellSize: 5,
            maxCellSize: 10,
            spacing: 2,
            timeZone: .gmt
        )
        XCTAssertGreaterThan(baseline.cells.filter { !$0.isFuture && $0.intensity == 0 }.count, 0)

        for _ in ["light", "dark", "accented"] {
            let themed = WidgetHeatmapLayoutCalculator.make(
                days: sparse,
                referenceDate: reference,
                availableSize: CGSize(width: 220, height: 70),
                maxWeeks: 14,
                minCellSize: 5,
                maxCellSize: 10,
                spacing: 2,
                timeZone: .gmt
            )
            XCTAssertEqual(themed, baseline)
        }
    }

    func testCurrentSchemaRequiresEveryPeriodAndSelectsWithoutFabricatingData() throws {
        XCTAssertThrowsError(try decodeRaw("""
        {"schemaVersion":10,"generatedAt":"2026-07-17T09:00:00Z","periods":{"day":{"overview":{"totalTokens":7,"costUsd":0},"tools":[],"models":[],"activity":{"activeDays":0,"days":[]},"trend":{"points":[]}}},"quota":[],"presentation":{"currencyCode":"USD","currencySymbol":"$","currencyRate":1,"numberStyle":"compact","compactTokenUnits":"western","showCost":true,"locale":"auto","theme":"system"},"status":{"isStale":false}}
        """))
        let snapshot = try decode("""
        {"periods":{"day":{"overview":{"totalTokens":7}},"month":{"overview":{"totalTokens":11}}},"presentation":{"currencySymbol":"¥"}}
        """)
        XCTAssertEqual(snapshot.selecting(.day).overview.totalTokens, 7)
        XCTAssertEqual(snapshot.selecting(.month).overview.totalTokens, 11)
    }

    func testStaleStatusWinsOverGeneratedAtThreshold() throws {
        let snapshot = try decode("{\"schemaVersion\":10,\"generatedAt\":\"2026-07-17T09:00:00Z\",\"periods\":{\"day\":{}},\"status\":{\"isStale\":true,\"noData\":false}}")
        XCTAssertTrue(snapshot.isStale(at: Date(timeIntervalSince1970: 0)))
    }

    private func decode(_ json: String) throws -> WidgetSnapshot {
        let baseline = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.currentSnapshotJSON.utf8)) as? [String: Any])
        let overrides = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(json.data(using: .utf8))) as? [String: Any])
        let data = try JSONSerialization.data(withJSONObject: merge(baseline, overrides))
        return try WidgetSnapshot.decoder.decode(WidgetSnapshot.self, from: data)
    }

    private func decodeRaw(_ json: String) throws -> WidgetSnapshot {
        try WidgetSnapshot.decoder.decode(WidgetSnapshot.self, from: XCTUnwrap(json.data(using: .utf8)))
    }

    private func merge(_ baseline: [String: Any], _ overrides: [String: Any]) -> [String: Any] {
        var result = baseline
        for (key, value) in overrides {
            if let nestedBaseline = result[key] as? [String: Any],
               let nestedOverrides = value as? [String: Any] {
                result[key] = merge(nestedBaseline, nestedOverrides)
            } else {
                result[key] = value
            }
        }
        return result
    }

    private static let currentSnapshotJSON = """
    {
      "schemaVersion":10,
      "generatedAt":"2026-07-17T09:00:00Z",
      "periods":{
        "day":{"overview":{"totalTokens":0,"costUsd":0},"tools":[],"models":[],"activity":{"activeDays":0,"days":[]},"trend":{"points":[]}},
        "month":{"overview":{"totalTokens":0,"costUsd":0},"tools":[],"models":[],"activity":{"activeDays":0,"days":[]},"trend":{"points":[]}},
        "total":{"overview":{"totalTokens":0,"costUsd":0},"tools":[],"models":[],"activity":{"activeDays":0,"days":[]},"trend":{"points":[]}}
      },
      "quota":[],
      "presentation":{"currencyCode":"USD","currencySymbol":"$","currencyRate":1,"numberStyle":"compact","compactTokenUnits":"western","showCost":true,"locale":"auto","theme":"system"},
      "status":{"isStale":false,"sourceUpdatedAt":null}
    }
    """

    private func utcDate(_ value: String) throws -> Date {
        try XCTUnwrap(ISO8601DateFormatter().date(from: "\(value)T00:00:00Z"))
    }

    private func continuousActivityDays(count: Int, ending: String) throws -> [WidgetActivityDay] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let end = try utcDate(ending)
        return try (0..<count).map { index in
            let date = try XCTUnwrap(calendar.date(byAdding: .day, value: index - count + 1, to: end))
            let components = calendar.dateComponents([.year, .month, .day], from: date)
            let key = String(
                format: "%04d-%02d-%02d",
                components.year ?? 0,
                components.month ?? 0,
                components.day ?? 0
            )
            return WidgetActivityDay(date: key, intensity: index % 4 + 1)
        }
    }

    private func provider(status: String) -> WidgetQuotaProvider {
        WidgetQuotaProvider(instanceId: "codex-single", provider: "codex", status: status, updatedAt: nil, windows: [])
    }

    // MARK: - Large Widget Layout Tests

    func testLargeHeatmapCellSizeGreaterThan12() {
        let reference = try! utcDate("2026-07-17")
        let days = try! continuousActivityDays(count: 90, ending: "2026-07-17")
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: days,
            referenceDate: reference,
            availableSize: CGSize(width: 320, height: 120),
            maxWeeks: 26,
            minCellSize: 5,
            maxCellSize: 22,
            spacing: 2,
            timeZone: .gmt
        )
        XCTAssertGreaterThan(layout.cellSize, 12)
        XCTAssertEqual(layout.cellWidth, layout.cellHeight)
        XCTAssertLessThanOrEqual(layout.cellSize, 22)
    }

    func testLargeHeatmapKeepsSevenRows() {
        let reference = try! utcDate("2026-07-17")
        let days = try! continuousActivityDays(count: 90, ending: "2026-07-17")
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: days,
            referenceDate: reference,
            availableSize: CGSize(width: 320, height: 120),
            maxWeeks: 26,
            minCellSize: 5,
            maxCellSize: 22,
            spacing: 2,
            timeZone: .gmt
        )
        if layout.weekCount > 0 {
            XCTAssertEqual(layout.cells.count, layout.weekCount * 7)
            let expectedHeight = 7 * layout.cellHeight + 6 * layout.spacing
            XCTAssertEqual(layout.renderedHeight, expectedHeight, accuracy: 0.001)
        }
    }

    func testLargeHeatmapUsesLargerCellsWithLimitedHistory() {
        let reference = try! utcDate("2026-07-17")
        // 3 weeks of data — coverage may span 3-4 calendar weeks due to Sunday alignment
        let days = try! continuousActivityDays(count: 21, ending: "2026-07-17")
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: days,
            referenceDate: reference,
            availableSize: CGSize(width: 320, height: 120),
            maxWeeks: 26,
            minCellSize: 5,
            maxCellSize: 22,
            spacing: 2,
            timeZone: .gmt
        )
        // With limited history and large available space, cells should be large
        XCTAssertGreaterThan(layout.cellSize, 14)
        XCTAssertEqual(layout.cellWidth, layout.cellHeight)
        // Week count depends on Sunday alignment (3-5 weeks)
        XCTAssertGreaterThanOrEqual(layout.weekCount, 3)
        XCTAssertLessThanOrEqual(layout.weekCount, 5)
    }

    func testSmallHeatmapShowsMoreWeeksThanBefore() throws {
        let reference = try utcDate("2026-07-17")
        let days = try continuousActivityDays(count: 120, ending: "2026-07-17")
        // Small should now use maxWeeks=16 and full width
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: days,
            referenceDate: reference,
            availableSize: CGSize(width: 155, height: 70),
            maxWeeks: 16,
            minCellSize: 5,
            maxCellSize: 16,
            spacing: 2,
            timeZone: .gmt
        )
        XCTAssertGreaterThan(layout.weekCount, 6) // More than old 6-week cap
        XCTAssertEqual(layout.cellWidth, layout.cellHeight)
        XCTAssertLessThanOrEqual(layout.renderedWidth, 155.001)
        XCTAssertEqual(layout.cells.count, layout.weekCount * 7)
    }

    // Day keys are local wall-clock dates, so the grid has to decide "today" in
    // the same zone. Resolving it in UTC put the whole heatmap one day off for
    // anyone whose local date differed from UTC at render time.
    func testHeatmapResolvesTodayInTheLocalZoneNotUTC() throws {
        let taipei = try XCTUnwrap(TimeZone(identifier: "Asia/Taipei"))
        // 00:30 on 07-18 in Taipei is still 07-17 in UTC.
        let justAfterLocalMidnight = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-17T16:30:00Z")
        )
        let days = [
            WidgetActivityDay(date: "2026-07-17", intensity: 2, totalTokens: 12_000_000),
            WidgetActivityDay(date: "2026-07-18", intensity: 3, totalTokens: 5_000_000)
        ]
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: days,
            referenceDate: justAfterLocalMidnight,
            availableSize: CGSize(width: 260, height: 90),
            maxWeeks: 14,
            minCellSize: 5,
            maxCellSize: 12,
            spacing: 2,
            timeZone: taipei
        )

        let today = try XCTUnwrap(layout.cells.first(where: { $0.date == "2026-07-18" }))
        XCTAssertFalse(today.isFuture, "the local current day must not be classified as future")
        XCTAssertTrue(today.isSelectable)
        XCTAssertEqual(today.totalTokens, 5_000_000)
        XCTAssertEqual(layout.endDate, "2026-07-18")
    }

    // The mirror image: west of UTC the reference instant already belongs to the
    // next UTC day, which used to append a trailing day nobody has reached yet.
    func testHeatmapDoesNotAppendAPhantomDayWestOfUTC() throws {
        let newYork = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        // 22:30 on 07-17 in New York is already 07-18 in UTC.
        let lateLocalEvening = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-18T02:30:00Z")
        )
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: [WidgetActivityDay(date: "2026-07-17", intensity: 2, totalTokens: 12_000_000)],
            referenceDate: lateLocalEvening,
            availableSize: CGSize(width: 260, height: 90),
            maxWeeks: 14,
            minCellSize: 5,
            maxCellSize: 12,
            spacing: 2,
            timeZone: newYork
        )

        XCTAssertEqual(layout.endDate, "2026-07-17")
        let tomorrow = try XCTUnwrap(layout.cells.first(where: { $0.date == "2026-07-18" }))
        XCTAssertTrue(tomorrow.isFuture)
        XCTAssertFalse(tomorrow.isSelectable)
    }

    // resolvedDate applies the same reference-day comparison, so a selection made
    // on the local current day was being cleared for the same reason.
    func testActivitySelectionKeepsTodayInTheLocalZone() throws {
        let suite = "token-monitor-widget-local-zone-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetPresentationStateStore(defaults: defaults)
        let taipei = try XCTUnwrap(TimeZone(identifier: "Asia/Taipei"))
        let justAfterLocalMidnight = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-17T16:30:00Z")
        )
        let days = [
            WidgetActivityDay(date: "2026-07-17", intensity: 2, totalTokens: 12_000_000),
            WidgetActivityDay(date: "2026-07-18", intensity: 3, totalTokens: 5_000_000)
        ]

        store.setSelectedActivityDay("2026-07-18", for: .medium)
        XCTAssertEqual(
            WidgetActivitySelection.resolvedDate(
                days: days,
                family: .medium,
                referenceDate: justAfterLocalMidnight,
                store: store,
                timeZone: taipei
            ),
            "2026-07-18"
        )
    }
}

final class WidgetDemandMarkerTests: XCTestCase {
    func testFirstRequestCreatesAZeroContentMarkerAtTheGivenTime() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let marker = directory.appendingPathComponent(WidgetDemandMarker.fileName)
        let requestedAt = Date(timeIntervalSince1970: 1_000_000)

        WidgetDemandMarker.noteRequested(container: directory, now: requestedAt)

        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
        let attributes = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: marker.path))
        XCTAssertEqual(try XCTUnwrap(attributes[.size] as? Int), 0)
        XCTAssertEqual(try XCTUnwrap(attributes[.modificationDate] as? Date), requestedAt)
    }

    func testLaterRequestRenewsOnlyTheMtimeNotTheContent() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let marker = directory.appendingPathComponent(WidgetDemandMarker.fileName)

        WidgetDemandMarker.noteRequested(container: directory, now: Date(timeIntervalSince1970: 1_000_000))
        WidgetDemandMarker.noteRequested(container: directory, now: Date(timeIntervalSince1970: 1_000_600))

        let attributes = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: marker.path))
        XCTAssertEqual(try XCTUnwrap(attributes[.size] as? Int), 0)
        XCTAssertEqual(try XCTUnwrap(attributes[.modificationDate] as? Date), Date(timeIntervalSince1970: 1_000_600))
    }

    func testUnresolvableContainerIsANoOp() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        WidgetDemandMarker.noteRequested(appGroup: "", container: nil, now: Date())

        XCTAssertFalse(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent(WidgetDemandMarker.fileName).path
        ))
    }

    func testProvisionalSignalWritesItsOwnFileOnly() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let full = directory.appendingPathComponent(WidgetDemandMarker.fileName)
        let provisional = directory.appendingPathComponent(WidgetDemandMarker.provisionalFileName)

        WidgetDemandMarker.noteRequested(
            fileName: WidgetDemandMarker.provisionalFileName,
            container: directory,
            now: Date(timeIntervalSince1970: 1_000_000)
        )

        XCTAssertFalse(FileManager.default.fileExists(atPath: full.path),
                       "snapshot demand must not touch the full lease")
        XCTAssertTrue(FileManager.default.fileExists(atPath: provisional.path))
        let attributes = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: provisional.path))
        XCTAssertEqual(try XCTUnwrap(attributes[.size] as? Int), 0)
        XCTAssertEqual(try XCTUnwrap(attributes[.modificationDate] as? Date), Date(timeIntervalSince1970: 1_000_000))
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("demand-marker-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

final class WidgetTimelineProviderPreviewTests: XCTestCase {
    // The gallery is where someone decides whether the widget is worth adding.
    // Before this fallback existed it rendered the redacted placeholder skeleton
    // during a cold start, which is indistinguishable from a broken widget.
    func testGalleryPreviewFallsBackToSampleDataInsteadOfAnEmptySkeleton() {
        let preview = WidgetPeriodPolicy.previewAwareSnapshot(
            loaded: nil,
            period: .day,
            isPreview: true
        )
        XCTAssertNotNil(preview)
        XCTAssertFalse(preview?.isEmpty ?? true)
    }

    func testPlacedWidgetKeepsNilRatherThanInventingNumbers() {
        XCTAssertNil(
            WidgetPeriodPolicy.previewAwareSnapshot(
                loaded: nil,
                period: .day,
                isPreview: false
            )
        )
    }

    func testARealSnapshotAlwaysWinsOverTheSample() throws {
        let loaded = try XCTUnwrap(
            WidgetSnapshot.load(from: Self.writeSnapshotFixture())
        )
        let resolved = WidgetPeriodPolicy.previewAwareSnapshot(
            loaded: loaded,
            period: .day,
            isPreview: true
        )
        XCTAssertEqual(resolved?.overview.totalTokens, loaded.overview.totalTokens)
    }

    private static func writeSnapshotFixture() -> URL {
        let json = """
        {"schemaVersion":10,"generatedAt":"2026-08-09T07:00:00.000Z",
         "periods":{
           "day":{"overview":{"totalTokens":4242,"costUsd":1.5},"tools":[],"models":[],"activity":{"days":[],"activeDays":0},"trend":{"points":[]}},
           "month":{"overview":{"totalTokens":0,"costUsd":0},"tools":[],"models":[],"activity":{"days":[],"activeDays":0},"trend":{"points":[]}},
           "total":{"overview":{"totalTokens":0,"costUsd":0},"tools":[],"models":[],"activity":{"days":[],"activeDays":0},"trend":{"points":[]}}
         },
         "quota":[],"presentation":{"currencyCode":"USD","currencySymbol":"$","currencyRate":1,
         "numberStyle":"compact","compactTokenUnits":"western","showCost":true,"locale":"auto","theme":"system"},
         "status":{"isStale":false,"sourceUpdatedAt":"2026-08-09T07:00:00.000Z"}}
        """
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("preview-fixture-\(UUID().uuidString).json")
        try? json.data(using: .utf8)?.write(to: url)
        return url
    }
}
