import Foundation
import Testing
@testable import TokenMonitor

@MainActor
struct WidgetPresentationTests {
    @Test func automaticActivityFollowsWorkThenQuotaThenUsageWithoutChangingSavedSlots() throws {
        typealias State = TokenMonitorActivityAttributes.ContentState
        let now = Date.now
        var state = State(updatedAt: now, usage: .init(today: .init(tokens: 1000), month: .init()),
            quotas: [.init(providerID: "codex", accountKey: "work", updatedAt: now,
                windows: [.init(label: "Session", kind: "session", remainingPercent: 80),
                          .init(label: "Weekly", kind: "weekly", remainingPercent: 5)])],
            agents: .init(running: 2, clients: ["claude"], waiting: 1))
        var saved = LiveActivityLayout.automatic
        saved.compactTrailing = .init(style: .cost)
        let active = ActivityContext(state: state, layout: saved, isStale: false, now: now)
        #expect(active.layout.compactLeading.style == .agents)
        #expect(active.layout.compactTrailing.style == .none)
        state.agents = .none
        let alert = ActivityContext(state: state, layout: saved, isStale: false, now: now)
        #expect(alert.layout.compactLeading.style == .ring)
        #expect(alert.reading(alert.layout.compactTrailing.source)?.window.label == "Weekly")
        #expect(alert.layout.lockScreen == .quota)
        state.quotas[0].stale = true
        let idle = ActivityContext(state: state, layout: saved, isStale: false, now: now)
        #expect(idle.layout.compactTrailing.style == .tokens)
        #expect(idle.layout.minimal == .appIcon)
        state.agents = .init(running: 0, clients: ["codex"], waiting: 1)
        #expect(ActivityContext(state: state, layout: saved, isStale: false, now: now).layout.compactLeading.style == .agents)
        #expect(ActivityContext(state: state, layout: saved, isStale: true, now: now).layout.compactTrailing.style == .tokens)
        #expect(saved.compactTrailing.style == .cost)
        saved.mode = .custom
        #expect(ActivityContext(state: state, layout: saved, isStale: false, now: now).layout == saved)
        #expect(try JSONDecoder().decode(LiveActivityLayout.self, from: Data("{}".utf8)).mode == .custom)
        #expect(TokenMonitorSharedPayload.Preferences.default.liveLayout.mode == .automatic)
        #expect(try JSONDecoder().decode(State.Agents.self, from: Data(#"{"running":1,"clients":["claude"]}"#.utf8)).waiting == nil)
    }

    private let reference = Date(timeIntervalSince1970: 1_800_000_000)

    private func age(_ seconds: TimeInterval) -> String {
        WidgetPresentation.compactAge(
            since: reference.addingTimeInterval(-seconds),
            now: reference
        )
    }

    @Test func compactAgeBoundaries() {
        #expect(age(0) == "now")
        #expect(age(59) == "now")
        #expect(age(60) == "1m")
        #expect(age(300) == "5m")
        #expect(age(3_599) == "59m")
        #expect(age(3_600) == "1h")
        #expect(age(10_800) == "3h")
        #expect(age(86_399) == "23h")
        #expect(age(86_400) == "1d")
        #expect(age(172_800) == "2d")
    }
    private func limitsEntry(providerID: String?) -> TokenMonitorWidgetEntry {
        let base = TokenMonitorWidgetEntry.placeholderSnapshot
        let limits: [TokenMonitorSharedPayload.Limit] = [
            .init(id: "claude", providerID: "claude", planLabel: "Pro", status: "ok",
                  updatedAt: reference, windows: [.init(id: "session", label: "Session", remainingPercent: 50, amount: nil, currency: nil, resetAt: nil)]),
            .init(id: "codex-pro", providerID: "codex", planLabel: "Pro", status: "ok",
                  updatedAt: reference, windows: [.init(id: "weekly", label: "Weekly", remainingPercent: 28, amount: nil, currency: nil, resetAt: nil)]),
            .init(id: "codex-free", providerID: "codex", planLabel: "Free", status: "ok",
                  updatedAt: reference, windows: [.init(id: "monthly", label: "Monthly", remainingPercent: 100, amount: nil, currency: nil, resetAt: nil)]),
            .init(id: "codex-plus", providerID: "codex", planLabel: "Plus", status: "ok",
                  updatedAt: reference, windows: [.init(id: "session", label: "Session", remainingPercent: 31, amount: nil, currency: nil, resetAt: nil)])
        ]
        let snapshot = TokenMonitorSharedPayload.Snapshot(updatedAt: reference, today: base.today,
            month: base.month, allTime: base.allTime, limits: limits, activity: [])
        return TokenMonitorWidgetEntry(date: reference, snapshot: snapshot, preferences: .default,
            content: "limits", period: "today", providerID: providerID,
            showsCost: false, showsUpdateTime: true, ink: .recommended)
    }

    @Test func selectedProviderKeepsEveryAccountInDesktopOrder() {
        let entry = limitsEntry(providerID: "codex")
        #expect(entry.orderedLimits.map(\.id) == ["codex-pro", "codex-free", "codex-plus"])
        #expect(entry.preferredLimit?.id == "codex-pro")
    }

    @Test func automaticListKeepsDesktopOrderWhileSmallUsesConstrainedAccount() {
        let entry = limitsEntry(providerID: nil)
        #expect(entry.orderedLimits.map(\.id) == ["claude", "codex-pro", "codex-free", "codex-plus"])
        #expect(entry.preferredLimit?.id == "codex-pro")
    }

    @Test func unavailableSelectedProviderDoesNotShowAnotherProvider() {
        let entry = limitsEntry(providerID: "cursor")
        #expect(entry.orderedLimits.isEmpty)
        #expect(!entry.hasData)
    }

    @Test func smallSkipsAnAccountWithoutReportedWindows() {
        let base = limitsEntry(providerID: "codex")
        let snapshot = base.snapshot!
        let empty = TokenMonitorSharedPayload.Limit(id: "empty", providerID: "codex",
            planLabel: "Pro", status: "notConfigured", updatedAt: nil, windows: [])
        let modified = TokenMonitorSharedPayload.Snapshot(updatedAt: reference, today: snapshot.today,
            month: snapshot.month, allTime: snapshot.allTime,
            limits: [empty] + snapshot.limits, activity: [])
        let entry = TokenMonitorWidgetEntry(date: reference, snapshot: modified, preferences: .default,
            content: "limits", period: "today", providerID: "codex", showsCost: false,
            showsUpdateTime: true, ink: .recommended)
        #expect(entry.hasData)
        #expect(entry.preferredLimit?.id == "codex-pro")
    }

}


extension WidgetPresentationTests {
    @Test func creditsHeadlineUsesBalanceWhileKeepingTheDerivedMeter() {
        let window = TokenMonitorSharedPayload.LimitWindow(id: "billing", label: "Credits", remainingPercent: 20,
            amount: 20, currency: "USD", resetAt: nil)
        let column = WidgetWindowColumn(window: window, providerID: "cursor", now: .now, locale: Locale(identifier: "en_US"))
        #expect(column.valueText == "$20.00")
        #expect(column.shortValueText == "$20.00")
        #expect(!column.isPercent)
        #expect(column.fraction == 0.2)
    }
}
