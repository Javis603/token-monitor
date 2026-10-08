import Foundation
import Testing
import UIKit
@testable import TokenMonitor

struct LimitsPresentationTests {
    // Desktop mark catalog: verify the actual compiled resources, including widgets' mapping.
    @Test(arguments: ["claude","codex","opencode","hermes","openclaw","cursor","antigravity","cline","amp","droid","kimi","qwen","grok","copilot","pi","omp","zed","kilo","commandcode","mimo","muse","zcode","kiro","codebuddy","workbuddy","proma","qodercn","reasonix","dsh","cherrystudio","lmstudio","unsloth","devin","fx","mcode","openrouter","gemini","qoder","deepseek","xai","meta","mistral","moonshot","zai","zaiteam","cohere","xiaomi","minimax","doubao","hunyuan","volcengine","ollama","trae","alibaba","stepfun","nvidia","typesafe","thirdparty","factory","newapi","sub2api"])
    func desktopProviderArtworkLoads(providerID: String) throws {
        let asset = ProviderPresentation.assetName(for: providerID)
        #expect(asset != "VendorTokenMonitor")
        #expect(asset == WidgetPresentation.assetName(for: providerID))
        _ = try #require(UIImage(named: asset))
    }

    @Test func unknownProvidersUseAppArtworkAndAliasesKeepTheirBrand() throws {
        #expect(ProviderPresentation.assetName(for: nil) == "VendorTokenMonitor")
        #expect(ProviderPresentation.assetName(for: "future-provider") == "VendorTokenMonitor")
        #expect(ProviderPresentation.assetName(for: " Factory ") == ProviderPresentation.assetName(for: "droid"))
        #expect(ProviderPresentation.assetName(for: "micode") == ProviderPresentation.assetName(for: "mimo"))
        #expect(ProviderPresentation.assetName(for: "kilocode") == ProviderPresentation.assetName(for: "kilo"))
        #expect(ProviderPresentation.assetName(for: "thirdparty") != ProviderPresentation.assetName(for: "newapi"))
        #expect(ProviderPresentation.assetName(for: "sub2api") != ProviderPresentation.assetName(for: "newapi"))
        _ = try #require(UIImage(named: "VendorTokenMonitor"))
    }

    private func provider(_ json: String) throws -> LimitProvider {
        try JSONDecoder().decode(LimitProvider.self, from: Data(json.utf8))
    }

    @Test func codexPairsPrimaryAndSeparatesMonthlyAndAdditional() throws {
        let value = try provider(#"{"provider":"codex","windows":[{"kind":"billing"},{"kind":"weekly"},{"kind":"session"},{"kind":"session","additional":true,"limitId":"reserve"}]}"#)
        let rows = try #require(LimitWindowSection.make(provider: value, windows: value.displayWindows).first).rows
        #expect(rows.map(\.count) == [2, 1, 1])
        #expect(rows[0].map(\.kind) == ["session", "weekly"])
        #expect(rows[1][0].kind == "billing")
        #expect(rows[2][0].additional == true)
        let lone = try provider(#"{"provider":"codex","windows":[{"kind":"weekly"}]}"#)
        #expect(LimitWindowSection.make(provider: lone, windows: lone.displayWindows)[0].rows.map(\.count) == [1])
    }

    @Test func claudeScopedWeeklyAndSpendUseWholeRows() throws {
        let value = try provider(#"{"provider":"claude","windows":[{"kind":"session"},{"kind":"weekly","label":""},{"kind":"weekly","label":"Fable"},{"kind":"billing","metric":"spend","showMeter":false}]}"#)
        let rows = LimitWindowSection.make(provider: value, windows: value.displayWindows)[0].rows
        #expect(rows.map(\.count) == [2, 1, 1])
        #expect(rows[1][0].label == "Fable")
        #expect(rows[2][0].showMeter == false)
    }

    @Test func cursorFullWidthAndAntigravityGroupsKeepTheirOwnPairs() throws {
        let cursor = try provider(#"{"provider":"cursor","windows":[{"kind":"billing","label":"Cursor Models"},{"kind":"billing","label":"Other Models"},{"kind":"weekly","label":"Grok Bot"}]}"#)
        #expect(LimitWindowSection.make(provider: cursor, windows: cursor.displayWindows)[0].rows.map(\.count) == [1, 1, 1])
        let antigravity = try provider(#"{"provider":"antigravity","windows":[{"kind":"session","label":"Gemini 5-hour"},{"kind":"session","label":"Claude/GPT 5-hour"},{"kind":"weekly","label":"Gemini weekly"},{"kind":"weekly","label":"Claude/GPT weekly"}]}"#)
        let groups = LimitWindowSection.make(provider: antigravity, windows: antigravity.displayWindows)
        #expect(groups.map(\.title) == ["Gemini", "Claude/GPT"])
        #expect(groups.map { $0.rows.map(\.count) } == [[2], [2]])
        #expect(groups[0].rows[0].map(\.label) == ["5-hour", "Weekly"])
        let legacy = try provider(#"{"provider":"antigravity","windows":[{"kind":"weekly","label":"Gemini Pro"},{"kind":"weekly","label":"Claude"}]}"#)
        #expect(LimitWindowSection.make(provider: legacy, windows: legacy.displayWindows)[0].rows.map(\.count) == [1, 1])
    }

    @Test func unknownWindowIsKeptAndZeroIsNotUnknown() throws {
        let value = try provider(#"{"provider":"devin","windows":[{"kind":"daily","resetsAt":"2026-10-09T00:00:00Z"},{"kind":"weekly","remainingPercent":0}]}"#)
        #expect(value.displayWindows.count == 2)
        #expect(value.displayWindows[0].effectiveRemainingPercent == nil)
        #expect(value.displayWindows[1].effectiveRemainingPercent == 0)
        #expect(LimitWindowSection.make(provider: value, windows: value.displayWindows)[0].rows.map(\.count) == [2])
    }

    @Test func resetCreditsDecodeSortFallbackAndPreserveRestrictions() throws {
        let value = try provider(#"{"provider":"claude","resetCredits":{"availableCount":1,"expirations":["bad","2026-10-29T00:00:00Z","2026-10-14T00:00:00Z"],"grants":[{"resetsLeft":1,"resetsTotal":2,"clears":["five_hour","seven_day","seven_day_overage_included"],"usableNow":false,"useRequiresLimit":true,"paused":true}]}}"#)
        let credits = try #require(value.resetCredits)
        #expect(credits.visibleCount == 1)
        #expect(credits.expirationDates.count == 2)
        #expect(credits.expirationDates[0] == Date.hubTimestamp(from: "2026-10-14T00:00:00Z"))
        let grant = try #require(credits.grants?.first)
        #expect(grant.clearedWindowLabels == ["Session", "Weekly"])
        #expect(grant.usableNow == false)
        #expect(grant.useRequiresLimit == true)
        #expect(grant.paused == true)
        let fallback = try provider(#"{"resetCredits":{"availableCount":3,"expirations":["bad"],"nextExpiresAt":"2026-10-14T00:00:00Z"}}"#)
        #expect(fallback.resetCredits?.expirationDates.count == 1)
        #expect(try provider(#"{"resetCredits":{"availableCount":0}}"#).resetCredits?.visibleCount == nil)
        #expect(try provider(#"{"resetCredits":{}}"#).resetCredits?.visibleCount == nil)
        #expect(try provider(#"{}"#).resetCredits == nil)
    }

    @Test func countdownKeepsDaysHoursAndHoursMinutes() throws {
        let now = try #require(Date.hubTimestamp(from: "2026-10-08T00:00:00Z"))
        let en = Locale(identifier: "en")
        #expect(MetricFormatter.limitCountdown(to: now.addingTimeInterval(5 * 86400 + 14 * 3600), now: now, locale: en) == "5d 14h")
        #expect(MetricFormatter.limitCountdown(to: now.addingTimeInterval(3 * 3600 + 34 * 60), now: now, locale: en) == "3h 34m")
        #expect(MetricFormatter.limitCountdown(to: now.addingTimeInterval(10), now: now, locale: en) == "<1m")
        #expect(MetricFormatter.limitCountdown(to: now, now: now, locale: en) == "Now")
        #expect(MetricFormatter.resetCount(1, locale: en) == "1 reset")
        #expect(MetricFormatter.resetCount(3, locale: Locale(identifier: "zh-Hant")) == "3 次重設")
    }
}
