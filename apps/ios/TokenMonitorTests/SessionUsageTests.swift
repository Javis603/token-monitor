import Foundation
import Testing
@testable import TokenMonitor

struct SessionUsageTests {
    @Test func capsSpeedAtMeasuredOutputAndKeepsAbsentDurationsUnknown() throws {
        let value = try decode(#"{"totalTokens":100,"outputTokens":20,"timedOutputTokens":50,"timedDurationMs":2000}"#)
        #expect(value.outputTokensPerSecond == 10)
        #expect(try decode(#"{"outputTokens":0,"timedOutputTokens":50,"timedDurationMs":2000}"#).outputTokensPerSecond == nil)
    }

    @Test func modelBreakdownSearchIncludesAllSuppliedModels() throws {
        let value = try decode(#"{"models":{"gpt-6":100,"claude-opus":20,"empty":0}}"#)
        #expect(value.modelEntries.map(\.id) == ["gpt-6", "claude-opus"])
        #expect(value.matches("claude"))
        #expect(!value.matches("empty"))
    }

    @Test func cacheShareRequiresKnownComponentsAndCacheTraffic() throws {
        #expect(try decode(#"{"totalTokens":100,"inputTokens":20,"cacheReadTokens":60,"cacheWriteTokens":20}"#).cacheHitPercent == 60)
        #expect(try decode(#"{"totalTokens":20,"inputTokens":20,"cacheReadTokens":0,"cacheWriteTokens":0}"#).cacheHitPercent == nil)
        #expect(try decode(#"{"totalTokens":20,"cacheReadTokens":10}"#).cacheHitPercent == nil)
        #expect(try decode(#"{"totalTokens":20,"tokenDataUnavailable":true,"inputTokens":0,"cacheReadTokens":10,"cacheWriteTokens":0}"#).cacheHitPercent == nil)
    }

    @Test func contextSurvivesTurnEndButExpiresAndRejectsFutureOrArchivedReads() throws {
        let now = try #require(Date.hubTimestamp(from: "2026-10-09T00:00:00Z"))
        let recent = try decode(#"{"lastUsedAt":"2026-10-08T23:59:00Z","contextTokens":20,"contextWindow":100,"turnEnded":true}"#)
        #expect(recent.contextUsedPercent(at: now) == 20)
        #expect(recent.contextUsedPercent(at: now.addingTimeInterval(601)) == nil)
        #expect(try decode(#"{"lastUsedAt":"2026-10-09T00:01:00Z","contextTokens":20,"contextWindow":100}"#).contextUsedPercent(at: now) == nil)
        #expect(try decode(#"{"lastUsedAt":"2026-10-08T23:59:00Z","contextTokens":20,"contextWindow":100,"archived":true}"#).contextUsedPercent(at: now) == nil)
    }

    @Test func usageBarsMatchDesktopScaleWithoutInventingZero() {
        #expect(UsageRowPresentation.fraction(nil, maximum: 100) == nil)
        #expect(UsageRowPresentation.fraction(.nan, maximum: 100) == nil)
        #expect(UsageRowPresentation.fraction(0, maximum: 100) == 0)
        #expect(UsageRowPresentation.fraction(100, maximum: 100) == 1)
        #expect(UsageRowPresentation.fraction(0.1, maximum: 100) == 0.02)
        #expect(abs((UsageRowPresentation.fraction(0.1, maximum: 0.3) ?? 0) - 1.0 / 3.0) < 1e-12)
        #expect(UsageRowPresentation.maximum([nil, .nan, -1, 0, 0.3]) == 0.3)
        #expect(UsageRowPresentation.share(25, total: 100) == 0.25)
    }

    @Test func promptCacheFollowsDesktopExpiryArchiveClientAndClockRules() throws {
        let now = try #require(Date.hubTimestamp(from: "2026-10-09T00:00:00Z"))
        let active = try decode(#"{"client":"codex","lastUsedAt":"2026-10-08T23:40:00Z","promptCache":{"observedAt":"2026-10-08T23:40:30Z","ttlSeconds":1800}}"#)
        #expect(active.contextUsedPercent(at: now) == nil)
        #expect(active.cacheMinutesRemaining(at: now) == 11)
        #expect(active.cacheMinutesRemaining(at: now.addingTimeInterval(630)) == nil)
        var archived = active; archived.archived = true
        #expect(archived.cacheMinutesRemaining(at: now) == nil)
        #expect(try decode(#"{"client":"codex","promptCache":{"observedAt":"2026-10-09T00:00:01Z","ttlSeconds":1800}}"#).cacheMinutesRemaining(at: now) == nil)
        #expect(try decode(#"{"client":"cursor","promptCache":{"observedAt":"2026-10-08T23:59:00Z","ttlSeconds":300}}"#).cacheMinutesRemaining(at: now) == nil)
        #expect(try decode(#"{"client":"claude","promptCache":{"observedAt":"2026-10-08T23:59:00Z","ttlSeconds":300}}"#).cacheMinutesRemaining(at: now) == 4)
        #expect(try decode(#"{"client":"codex","promptCache":{"observedAt":"2026-10-08T23:59:00Z","ttlSeconds":999}}"#).cacheMinutesRemaining(at: now) == nil)
        #expect(try decode(#"{"client":"codex","promptCache":null}"#).cacheMinutesRemaining(at: now) == nil)
    }

    @Test func backgroundReviewsAreGroupedAtTheBottomWithoutGuessingFromTitles() throws {
        let sessions = [
            "review-old": try decode(#"{"client":"codex","totalTokens":200,"costUsd":0.2,"sessionKind":"background-review","lastUsedAt":"2026-10-08T23:00:00Z"}"#),
            "review-new": try decode(#"{"client":"codex","totalTokens":100,"costUsd":0.1,"sessionKind":"background-review","lastUsedAt":"2026-10-09T00:00:00Z"}"#),
            "interactive": try decode(#"{"client":"codex","totalTokens":50,"title":"Review PR","lastUsedAt":"2026-10-08T22:00:00Z"}"#),
            "zero": try decode(#"{"client":"codex","totalTokens":0}"#)
        ]
        let rows = SessionListEntry.rows(sessions)
        #expect(rows.map(\.id) == ["interactive", "session-group:codex-auto-review"])
        #expect(rows.last?.tokens == 300)
        #expect(abs((rows.last?.cost ?? 0) - 0.3) < 1e-12)
        #expect(rows.last?.reviews.map(\.key) == ["review-new", "review-old"])
        #expect(SessionListEntry.rows(sessions, query: "Review PR").count == 1)
    }

    @Test func aliasesRespectGroupingManualPrecedenceAndRetainSourcePrices() throws {
        let ids = ["vendor/gpt-6", "gpt-6", "vendor/standalone"]
        let duplicates = ModelAliasSettings(modelAliasGrouping: "duplicates").resolver(modelIDs: ids)
        #expect(duplicates["vendor/gpt-6"] == "gpt-6")
        #expect(duplicates["vendor/standalone"] == "vendor/standalone")
        let prefix = ModelAliasSettings(modelAliases: ["gpt-6": "My model"], modelAliasGrouping: "prefix").resolver(modelIDs: ids)
        #expect(prefix["vendor/gpt-6"] == "My model")
        #expect(prefix["vendor/standalone"] == "standalone")
        let manual = ModelAliasSettings(modelAliases: ["VENDOR/GPT_6": "Manual"], modelAliasGrouping: "off").resolver(modelIDs: ids)
        #expect(manual["vendor/gpt-6"] == "Manual")
        #expect(ModelAliasSettings.fold(["vendor/gpt-6": 0.00123, "gpt-6": 0.00456], using: duplicates)?["gpt-6"] == 0.00579)
        #expect(MetricFormatter.usageCostFromUSD(0.00123, currency: .usd) == "$0.0012")
        #expect(MetricFormatter.usageCostFromUSD(10.00123, currency: .usd) == "$10.00")
        #expect(MetricFormatter.usageCostFromUSD(0.0123, currency: .hkd) == "HK$0.0959")
    }

    private func decode(_ json: String) throws -> SessionUsage {
        try JSONDecoder().decode(SessionUsage.self, from: Data(json.utf8))
    }

    @Test func keepsUnknownUsageAndTurnStateDistinctFromZeroAndFalse() throws {
        let unknown = try decode(#"{"client":"codex","totalTokens":0,"tokenDataUnavailable":true}"#)
        #expect(unknown.measuredTokens == nil)
        #expect(unknown.turnEnded == nil)
        #expect(unknown.outputTokensPerSecond == nil)
        let measured = try decode(#"{"totalTokens":0,"turnEnded":false}"#)
        #expect(measured.measuredTokens == 0)
        #expect(measured.turnEnded == false)
    }

    @Test func usesOnlyCanonicalTitleAndSearchesSuppliedMetadata() throws {
        let privateSession = try decode(#"{"client":"codex","preview":"secret prompt","firstUserMessage":"secret prompt"}"#)
        #expect(privateSession.displayTitle == nil)
        #expect(!privateSession.matches("secret"))
        let titled = try decode(#"{"title":"  Fix\n  sidebar  ","projectLabel":"Token Monitor","models":{"gpt-6":100,"gpt-5":2}}"#)
        #expect(titled.displayTitle == "Fix sidebar")
        #expect(titled.matches("monitor"))
        #expect(titled.primaryModel == "gpt-6")
    }

    @Test func derivesThroughputOnlyFromMeasuredDurations() throws {
        let session = try decode(#"{"totalTokens":10000,"timedOutputTokens":200,"timedDurationMs":4000}"#)
        #expect(session.outputTokensPerSecond == 50)
        #expect(try decode(#"{"timedOutputTokens":200,"timedDurationMs":0}"#).outputTokensPerSecond == nil)
    }
}
