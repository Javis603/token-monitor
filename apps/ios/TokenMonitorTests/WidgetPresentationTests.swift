import Foundation
import Testing
@testable import TokenMonitor

@MainActor
struct WidgetPresentationTests {
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
