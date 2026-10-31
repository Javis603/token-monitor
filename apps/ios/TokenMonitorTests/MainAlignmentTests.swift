import Foundation
import SwiftUI
import Testing
@testable import TokenMonitor

@MainActor
struct MainAlignmentTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func overviewCountsPreserveNativeDefaultsAndIndependentEdits() {
        let name = "MainAlignment-\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = AppPreferences(defaults: defaults, snapshotStore: .init(fileURL: nil))
        #expect(preferences.homeCount("tool") == 3)
        #expect(preferences.homeCount("device") == 4)
        preferences.setHomeCount(50, for: "model")
        preferences.setHomeCount(0, for: "session")
        let reloaded = AppPreferences(defaults: defaults, snapshotStore: .init(fileURL: nil))
        #expect(reloaded.homeCount("model") == 50)
        #expect(reloaded.homeCount("session") == 1)
        #expect(reloaded.homeCount("tool") == 3)
        reloaded.setHomeCount(99, for: "device")
        #expect(reloaded.homeCount("device") == 50)
    }

    @Test func activeAndWaitingSessionsSurvivePreviewCount() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let sessions = try decode([String: SessionUsage].self, #"{"quiet":{"client":"codex","totalTokens":5,"lastUsedAt":"1970-01-01T00:16:39Z","turnEnded":true},"waiting":{"client":"codex","totalTokens":5,"lastUsedAt":"1970-01-01T00:16:38Z","waitingForInput":true},"running":{"client":"claude","totalTokens":5,"lastUsedAt":"1970-01-01T00:16:37Z"},"old":{"client":"codex","totalTokens":5,"lastUsedAt":"1970-01-01T00:00:00Z"}}"#)
        let rows = SessionPreviewPresentation.rows(sessions, now: now, limit: 1)
        #expect(Set(rows.map(\.id)) == ["running", "waiting"])
    }

    @Test func spendPeriodsKeepZeroAndSkipUnknownValues() throws {
        let balance = try decode(ProviderBalance.self, #"{"todaySpend":0,"weekSpend":null,"monthSpend":12.5,"allTimeSpend":90,"currency":"CNY"}"#)
        #expect(balance.spendEntries.map(\.label) == ["Today", "Month", "All time"])
        #expect(balance.spendEntries.first?.amount == 0)
        #expect(balance.currency == "CNY")
    }

    private func snapshot(_ a: (Int, Int), _ b: (Int, Int), models: Bool = true, unknownDevice: Bool = false) throws -> HubStats {
        let attribution = models ? #", "modelThroughput":{"a":{"timedTokens":\#(a.0),"timedOutputTokens":\#(a.0),"timedDurationMs":\#(a.1)},"b":{"timedTokens":\#(b.0),"timedOutputTokens":\#(b.0),"timedDurationMs":\#(b.1)}}"# : ""
        let unknown = unknownDevice ? #",{"deviceId":"legacy","stale":false,"periods":{"today":{}}}"# : ""
        return try decode(HubStats.self, #"{"devices":[{"deviceId":"mac","displayName":"Mac","stale":false,"periods":{"today":{"timedTokens":\#(a.0+b.0),"timedOutputTokens":\#(a.0+b.0),"timedDurationMs":\#(a.1+b.1)\#(attribution)}}}\#(unknown)]}"#)
    }

    @Test func concurrentModelRatesRetainSamplesAndWeightDeviceHeadline() throws {
        var tracker = LiveTokenRateTracker()
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.observe(try snapshot((100, 1_000), (100, 1_000)), at: start)
        #expect(tracker.reading(at: start) == nil)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000)), at: start.addingTimeInterval(1))
        tracker.observe(try snapshot((200, 2_000), (400, 3_000)), at: start.addingTimeInterval(2))
        let current = tracker.reading(at: start.addingTimeInterval(2))
        let reading = try #require(current)
        #expect(abs(reading.tokensPerSecond - 400.0 / 3) < 0.0001)
        #expect(reading.devices.first?.models.map(\.tokensPerSecond) == [100, 150])
        #expect(tracker.reading(at: start.addingTimeInterval(9.5))?.devices.first?.models.map(\.id) == ["b"])
        #expect(tracker.reading(at: start.addingTimeInterval(11))?.isIdle == true)
        #expect(tracker.reading(at: start.addingTimeInterval(11))?.tokensPerSecond == 150)
        #expect(tracker.reading(at: start.addingTimeInterval(183)) == nil)
        tracker.observe(try snapshot((0, 0), (0, 0)), at: start.addingTimeInterval(184))
        #expect(tracker.reading(at: start.addingTimeInterval(184)) == nil)
    }

    @Test func canonicalModelIdentityPrecedesLatestSampleSelection() throws {
        var tracker = LiveTokenRateTracker()
        let aliases = ModelAliasSettings(modelAliases: ["a": "Shared", "b": "Shared"])
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.observe(try snapshot((100, 1_000), (100, 1_000)), aliases: aliases, at: start)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000)), aliases: aliases, at: start.addingTimeInterval(1))
        tracker.observe(try snapshot((200, 2_000), (400, 3_000)), aliases: aliases, at: start.addingTimeInterval(2))
        let current = tracker.reading(at: start.addingTimeInterval(2))
        let reading = try #require(current)
        #expect(reading.tokensPerSecond == 150)
        #expect(reading.devices.first?.models.map(\.id) == ["Shared"])
        #expect(reading.devices.first?.models.first?.tokensPerSecond == 150)
    }

    @Test func unknownDeviceDoesNotEraseAnotherDevicesIdleReading() throws {
        var tracker = LiveTokenRateTracker()
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.observe(try snapshot((100, 1_000), (100, 1_000), unknownDevice: true), at: start)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000), unknownDevice: true), at: start.addingTimeInterval(1))
        #expect(tracker.reading(at: start.addingTimeInterval(10))?.tokensPerSecond == 100)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000), unknownDevice: true), at: start.addingTimeInterval(11))
        #expect(tracker.reading(at: start.addingTimeInterval(11))?.tokensPerSecond == 100)
        #expect(tracker.reading(at: start.addingTimeInterval(11))?.isIdle == true)
    }

    @Test func billingKeysUseGregorianFieldsInLocalZoneForEverySystemCalendar() throws {
        let date = try #require(Date.hubTimestamp(from: "2026-10-22T00:30:00Z"))
        for identifier in [Calendar.Identifier.gregorian, .buddhist, .japanese, .islamic] {
            var calendar = Calendar(identifier: identifier)
            calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
            let today = SharedSubscription.dayString(date, calendar: calendar)
            #expect(today == "2026-10-21")
            let record = try decode(SharedSubscription.self, #"{"id":"topup","provider":"codex","kind":"topup","currency":"USD","topUps":[{"id":"1","date":"2026-10-01","amountMinor":5000}]}"#)
            #expect(record.monthlyAmountUSD(today: today) == 50)
        }
    }

    @Test func unavailableOrConflictingModelAttributionFallsBackWithoutDoubleCounting() throws {
        var tracker = LiveTokenRateTracker()
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.observe(try snapshot((100, 1_000), (100, 1_000)), at: start)
        tracker.observe(try snapshot((200, 2_000), (100, 1_000)), at: start.addingTimeInterval(1))
        tracker.observe(try snapshot((200, 2_000), (400, 3_000), models: false), at: start.addingTimeInterval(2))
        #expect(tracker.reading(at: start.addingTimeInterval(2))?.tokensPerSecond == 150)
        #expect(tracker.reading(at: start.addingTimeInterval(2))?.devices.isEmpty == true)
        tracker.observe(try snapshot((400, 4_000), (400, 3_000)), at: start.addingTimeInterval(3))
        #expect(tracker.reading(at: start.addingTimeInterval(3))?.tokensPerSecond == 100)
        #expect(tracker.reading(at: start.addingTimeInterval(3))?.devices.isEmpty == true)
    }

    @Test func subscriptionsUseOriginalBillingAnchorAndCalendarMonthTopups() throws {
        let plan = try decode(SharedSubscription.self, #"{"id":"a","provider":"codex","kind":"subscription","currency":"USD","amountMinor":2000,"interval":"month","startDate":"2026-01-31","autoRenew":true}"#)
        #expect(plan.nextRenewal(today: "2026-02-01") == "2026-02-28")
        #expect(plan.nextRenewal(today: "2026-03-01") == "2026-03-31")
        #expect(plan.monthlyAmountUSD(today: "2026-10-22") == 20)
        let cancelled = try decode(SharedSubscription.self, #"{"id":"a","provider":"codex","currency":"USD","amountMinor":2000,"startDate":"2026-01-31","autoRenew":false}"#)
        #expect(cancelled.coverageStop == "2026-02-28")
        #expect(cancelled.monthlyAmountUSD(today: "2026-02-28") == 0)
        #expect(cancelled.nextRenewal(today: "2026-02-01") == nil)
        let ledger = try decode(SharedSubscription.self, #"{"id":"b","provider":"newapi","kind":"topup","currency":"HKD","topUps":[{"id":"1","date":"2026-10-01","amountMinor":7800},{"id":"2","date":"2026-09-30","amountMinor":7800}]}"#)
        #expect(ledger.monthlyAmountUSD(today: "2026-10-22") == 10)
        #expect(SharedSubscription.validDay("2026-02-30") == nil)
        #expect(SharedSubscription.validDay("2026-2-3") == nil)
    }

    @Test func sharedSubscriptionsRejectLateDestinationAndRefreshOnVersion() async throws {
        let client = AlignmentSubscriptionClient()
        let state = SubscriptionStore(client: client)
        let a = HubConfiguration(baseURL: URL(string: "https://a.example")!, secret: "a")
        let b = HubConfiguration(baseURL: URL(string: "https://b.example")!, secret: "b")
        state.configure(a); state.observe(revision: "1")
        try #require(await coreEventually { await client.count == 1 })
        state.configure(b); state.observe(revision: "2")
        try #require(await coreEventually { await client.count == 2 })
        await client.complete(0, revision: "1")
        await client.complete(1, revision: "2")
        try #require(await coreEventually { state.document?.updatedAt == "2" })
        state.observe(revision: nil); state.observe(revision: "1")
        #expect(await client.count == 2)
        state.observe(revision: "3")
        try #require(await coreEventually { await client.count == 3 })
        #expect(state.isStale)
        await client.complete(2, revision: "3")
        try #require(await coreEventually { state.document?.updatedAt == "3" })
        #expect(!state.isStale)
        state.configure(nil)
        #expect(state.document == nil)
    }
    @Test func subscriptionReadFailuresKeepLastDocumentAndBoundRetry() async throws {
        let client = AlignmentSubscriptionClient()
        let state = SubscriptionStore(client: client)
        let config = HubConfiguration(baseURL: URL(string: "https://fixture.example")!, secret: "fixture")
        state.configure(config); state.observe(revision: "2")
        try #require(await coreEventually { await client.count == 1 })
        await client.complete(0, revision: "2")
        try #require(await coreEventually { state.document?.updatedAt == "2" })
        state.observe(revision: "3")
        for index in 1...3 {
            try #require(await coreEventually { await client.count == index + 1 })
            await client.complete(index, revision: "1")
        }
        try #require(await coreEventually { state.errorMessage != nil })
        #expect(state.document?.updatedAt == "2")
        #expect(state.isStale)
        state.observe(revision: "3")
        #expect(await client.count == 4)
        state.configure(nil)
    }

}

private actor AlignmentSubscriptionClient: HubDataClient {
    private var pending: [CheckedContinuation<SubscriptionDocument?, any Error>] = []
    var count: Int { pending.count }
    func fetchSubscriptions(configuration: HubConfiguration) async throws -> SubscriptionDocument? {
        try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func complete(_ index: Int, revision: String) {
        pending[index].resume(returning: .init(version: 1, updatedAt: revision, subscriptions: []))
    }
    func fetchStats(configuration: HubConfiguration) async throws -> HubStats { throw HubClientError.streamEnded }
    func fetchHistory(configuration: HubConfiguration) async throws -> UsageHistory { .empty }
    func statsStream(configuration: HubConfiguration) async -> AsyncThrowingStream<HubStats, any Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

// Exercise real card placement at landscape, portrait, narrow and accessibility sizes.
@MainActor
private final class DashboardFrameRecorder {
    var frames: [Int: CGRect] = [:]
}

@MainActor
@Suite(.serialized)
struct DashboardLayoutTests {
    @Test func cardColumnsFollowViewportAndTextSize() async throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        let cases: [(CGSize, DynamicTypeSize, Int, Int?)] = [
            (CGSize(width: 1180, height: 760), .large, isPad ? 2 : 1, nil),
            (CGSize(width: 820, height: 1100), .large, 1, nil),
            (CGSize(width: 390, height: 760), .large, 1, nil),
            (CGSize(width: 1180, height: 760), .accessibility3, 1, nil),
            // Exercise uneven-height masonry even on CI's iPhone simulator.
            (CGSize(width: 1180, height: 760), .large, 2, 2)
        ]
        for (size, typeSize, columnCount, forcedColumns) in cases {
            let recorder = DashboardFrameRecorder()
            let content = DashboardScrollView { columns in
                DashboardCardLayout(columns: forcedColumns ?? columns) {
                    ForEach(0..<4) { index in
                        Color.blue.frame(height: [40.0, 160, 60, 80][index])
                            .onGeometryChange(for: CGRect.self) { geometry in
                                geometry.frame(in: .named("dashboard-grid-test"))
                            } action: { frame in
                                recorder.frames[index] = frame
                            }
                    }
                }
                .coordinateSpace(name: "dashboard-grid-test")
            }
            .environment(\.dynamicTypeSize, typeSize)
            .environment(\.horizontalSizeClass, size.width >= 700 ? .regular : .compact)
            .frame(width: size.width, height: size.height)
            let host = UIHostingController(rootView: content)
            host.safeAreaRegions = []
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(origin: .zero, size: size)
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer {
                window.isHidden = true
                window.rootViewController = nil
                previousKeyWindow?.makeKey()
            }
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(400))
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(200))
            let first = try #require(recorder.frames[0])
            let second = try #require(recorder.frames[1])
            let third = try #require(recorder.frames[2])
            #expect(abs(first.width - second.width) < 1)
            if columnCount == 2 {
                #expect(abs(first.minY - second.minY) < 1)
                #expect(second.minX > first.maxX)
                #expect(first.width < size.width * 0.55)
                // The next card follows the shorter column, not the tall neighbor.
                #expect(abs(third.minX - first.minX) < 1)
                #expect(abs(third.minY - first.maxY - 24) < 1)
            } else {
                #expect(abs(first.minX - second.minX) < 1)
                #expect(second.minY > first.maxY)
                #expect(first.width > size.width * 0.8)
            }
            print("DASHBOARD_GEOMETRY \(size) \(typeSize) columns=\(columnCount): \(first), \(second)")
        }
    }

    // Keep both window-manipulating tests in this serialized suite.
    // Toolbar controls stay inside the window while native leading items reserve space.
    @Test func overviewPeriodPickerStaysInsideResizedWindow() async throws {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = try #require(scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let actualSize = scene.coordinateSpace.bounds.size
        let suiteName = "HeaderResize-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let preferences = AppPreferences(defaults: defaults, snapshotStore: .init(fileURL: nil))
        preferences.showsLiveTokenRate = true
        let store = TokenMonitorStore.preview

        func content(size: CGSize) -> some View {
            NavigationStack {
                OverviewView(selectedTab: .constant(.overview))
                    .toolbar {
                        // Reserve leading toolbar space, as window controls do on iPad.
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Back", systemImage: "chevron.left") {}
                                .frame(width: 64)
                        }
                    }
            }
            .environment(store)
            .environment(preferences)
            .environment(\.locale, Locale(identifier: "en_US"))
            .environment(\.colorScheme, .light)
            .environment(\.dynamicTypeSize, .large)
            .environment(\.horizontalSizeClass, size.width >= 700 ? .regular : .compact)
            .frame(width: size.width, height: size.height)
        }
        let host = UIHostingController(rootView: content(size: actualSize))
        host.safeAreaRegions = []
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
            defaults.removePersistentDomain(forName: suiteName)
        }

        let sizes: [(String, CGSize)] = [
            ("actual-window", actualSize),
            ("wide", CGSize(width: 1180, height: 775)),
            ("narrow-500", CGSize(width: 500, height: 775)),
            ("narrow-390", CGSize(width: 390, height: 775)),
            ("restore-500", CGSize(width: 500, height: 775))
        ]
        for (name, size) in sizes {
            // Keep one hosting controller / NavigationStack alive through resize.
            host.rootView = content(size: size)
            window.frame = CGRect(origin: .zero, size: size)
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(400))
            // A managed iPad scene can reassert the physical UIWindow frame.
            // Preserve an explicit viewport on the same hosted SwiftUI root.
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(250))

            let pickers = segmentedControls(in: host.view)
            print("HEADER_RESIZE \(name): scene=\(actualSize), requested=\(size), host=\(host.view.bounds), window=\(window.bounds), segments=\(pickers.count)")
            // The narrowest viewport may use Overview's menu fallback.
            if size.width >= 500 { #expect(!pickers.isEmpty) }
            for picker in pickers {
                let rect = picker.convert(picker.bounds, to: host.view)
                print("HEADER_PICKER \(name): \(rect)")
                #expect(rect.minX >= -1)
                #expect(rect.maxX <= host.view.bounds.width + 1)
                #expect(rect.minY >= -1)
                #expect(rect.maxY <= host.view.bounds.height + 1)
            }

        }
    }

    private func segmentedControls(in view: UIView) -> [UISegmentedControl] {
        guard !view.isHidden && view.alpha > 0.01 else { return [] }
        return (view as? UISegmentedControl).map { [$0] } ?? view.subviews.flatMap { segmentedControls(in: $0) }
    }
}
