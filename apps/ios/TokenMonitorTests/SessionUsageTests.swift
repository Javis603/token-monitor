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

    @Test func backgroundReviewGroupsSortByActivityWithoutGuessingFromTitles() throws {
        let sessions = [
            "review-old": try decode(#"{"client":"codex","totalTokens":200,"costUsd":0.2,"sessionKind":"background-review","lastUsedAt":"2026-10-08T23:00:00Z"}"#),
            "review-new": try decode(#"{"client":"codex","totalTokens":100,"costUsd":0.1,"sessionKind":"background-review","lastUsedAt":"2026-10-09T00:00:00Z"}"#),
            "interactive": try decode(#"{"client":"codex","totalTokens":50,"title":"Review PR","lastUsedAt":"2026-10-08T22:00:00Z"}"#),
            "zero": try decode(#"{"client":"codex","totalTokens":0}"#)
        ]
        let rows = SessionListEntry.rows(sessions)
        #expect(rows.map(\.id) == ["session-group:codex-auto-review", "interactive"])
        #expect(rows.first?.tokens == 300)
        #expect(abs((rows.first?.cost ?? 0) - 0.3) < 1e-12)
        #expect(rows.first?.reviews.map(\.key) == ["review-new", "review-old"])
        #expect(SessionListEntry.rows(sessions, query: "Review PR").count == 1)
    }

    @Test func botGroupingKeepsMixedModelsAndTotalsWithActivityOrderAndSearch() throws {
        let sessions = [
            "cursor:sand-subagent-1": try decode(#"{"client":"cursor","totalTokens":10,"costUsd":0.1,"models":{"claude":10},"lastUsedAt":"2026-10-09T00:03:00Z"}"#),
            "cursor:regular-bot": try decode(#"{"client":"cursor","sessionId":"regular-bot","totalTokens":20,"costUsd":0.2,"models":{"grok-bot-default":10,"claude":10},"lastUsedAt":"2026-10-09T00:01:00Z"}"#),
            "interactive": try decode(#"{"client":"cursor","totalTokens":5,"costUsd":0.01,"title":"Use Grok Bot","models":{"grok":5},"lastUsedAt":"2026-10-09T00:02:00Z"}"#),
            "review": try decode(#"{"client":"codex","totalTokens":40,"costUsd":0.3,"sessionKind":"background-review","lastUsedAt":"2026-10-09T00:00:00Z"}"#)
        ]
        let rows = SessionListEntry.rows(sessions)
        #expect(rows.map(\.id) == ["session-group:cursor-grok-bot", "interactive", "session-group:codex-auto-review"])
        #expect(rows.first?.reviews.count == 2)
        #expect(rows.first?.tokens == 30)
        #expect(abs((rows.first?.cost ?? 0) - 0.3) < 1e-12)
        #expect(rows.reduce(0) { $0 + ($1.tokens ?? 0) } == 75)
        #expect(SessionListEntry.rows(sessions, query: "claude").first?.reviews.count == 2)
        #expect(SessionListEntry.rows(sessions, query: "Grok Bot").first?.reviews.count == 2)
        #expect(try decode(#"{"client":"codex","sessionId":"sand-subagent-x","models":{"grok-bot-default":1}}"#).isGrokBot(key: "") == false)
        #expect(try decode(#"{"client":"cursor","models":{"grok-bot-default":0}}"#).isGrokBot(key: "") == false)
        #expect(try decode(#"{"client":"cursor","sessionId":"sand-subagent-x","grokBotSession":false}"#).isGrokBot(key: "") == false)
    }

    @Test func botIdentityJoinsRawPeriodsBeforeAliasProjectionWithoutChangingPeriodTotals() throws {
        let today = try JSONDecoder().decode(UsagePeriod.self, from: Data(#"{"sessions":{"cursor:room":{"client":"cursor","sessionId":"room","totalTokens":5,"models":{"claude":5}}}}"#.utf8))
        let total = try JSONDecoder().decode(UsagePeriod.self, from: Data(#"{"sessions":{"cursor:room":{"client":"cursor","sessionId":"room","totalTokens":99,"models":{"grok-bot-default":99}}}}"#.utf8))
        let ids = SessionListEntry.grokBotIDs(["today": today, "allTime": total])
        let rows = SessionListEntry.rows(today.sessions ?? [:], grokBotIDs: ids)
        #expect(rows.first?.group == .grokBot)
        #expect(rows.first?.tokens == 5)
        #expect(SessionListEntry.grokBotIDs(["allTime": total], authoritative: []).isEmpty)
        var aliased = try #require(total.sessions?["cursor:room"])
        aliased.grokBotSession = aliased.isGrokBot(key: "cursor:room")
        aliased.models = ["Custom display name": 99]
        #expect(SessionListEntry.rows(["cursor:room": aliased]).first?.group == .grokBot)
        let now = try #require(Date.hubTimestamp(from: "2026-10-09T00:04:00Z"))
        #expect(SessionPreviewPresentation.rows(["cursor:room": aliased], now: now).isEmpty)
    }

    @Test func previewRunsFirstThenRecentActivityWithStableOrder() throws {
        let now = try #require(Date.hubTimestamp(from: "2026-10-09T00:00:00Z"))
        let sessions = [
            "run-old": try decode(#"{"client":"codex","totalTokens":10,"lastUsedAt":"2026-10-08T23:50:00Z","turnEnded":false}"#),
            "done-recent": try decode(#"{"client":"claude","totalTokens":999,"lastUsedAt":"2026-10-08T23:59:30Z","turnEnded":true}"#),
            "run-new": try decode(#"{"client":"claude","totalTokens":5,"lastUsedAt":"2026-10-08T23:59:50Z","turnEnded":false}"#),
            "done-stale": try decode(#"{"client":"codex","totalTokens":7,"lastUsedAt":"2026-10-08T20:00:00Z","turnEnded":true}"#),
        ]
        #expect(SessionPreviewPresentation.rows(sessions, now: now).map(\.id) == ["run-new", "run-old", "done-recent"])
        #expect(SessionPreviewPresentation.runningCount(sessions, at: now) == 2)
    }

    @Test func previewDropsBackgroundReviewsAndKeepsUnknownUsage() throws {
        let now = try #require(Date.hubTimestamp(from: "2026-10-09T00:00:00Z"))
        let sessions = [
            "review": try decode(#"{"client":"codex","totalTokens":500,"sessionKind":"background-review","lastUsedAt":"2026-10-08T23:59:59Z"}"#),
            "reasonix-stats:1": try decode(#"{"client":"reasonix","totalTokens":10,"lastUsedAt":"2026-10-08T23:59:58Z"}"#),
            "reasonix-live": try decode(#"{"client":"reasonix","totalTokens":10,"lastUsedAt":"2026-10-08T23:59:57Z"}"#),
            "zero": try decode(#"{"client":"codex","totalTokens":0,"lastUsedAt":"2026-10-08T23:59:56Z"}"#),
            "unknown": try decode(#"{"client":"codex","totalTokens":0,"tokenDataUnavailable":true,"lastUsedAt":"2026-10-08T23:59:55Z"}"#),
        ]
        #expect(SessionPreviewPresentation.rows(sessions, now: now).map(\.id) == ["reasonix-live", "unknown"])
        #expect(SessionPreviewPresentation.runningCount(sessions, at: now) == 2)
    }

    @Test func previewCapsRowsAndTieBreaksByTokensCostThenKey() throws {
        let now = try #require(Date.hubTimestamp(from: "2026-10-09T00:00:00Z"))
        let sessions = [
            "b": try decode(#"{"client":"codex","totalTokens":10,"lastUsedAt":"2026-10-08T20:00:00Z","turnEnded":true}"#),
            "a": try decode(#"{"client":"claude","totalTokens":10,"lastUsedAt":"2026-10-08T20:00:00Z","turnEnded":true}"#),
            "costly": try decode(#"{"client":"claude","totalTokens":10,"costUsd":0.1,"lastUsedAt":"2026-10-08T20:00:00Z","turnEnded":true}"#),
            "big": try decode(#"{"client":"codex","totalTokens":20,"lastUsedAt":"2026-10-08T20:00:00Z","turnEnded":true}"#),
            "older": try decode(#"{"client":"claude","totalTokens":999,"lastUsedAt":"2026-10-08T19:00:00Z","turnEnded":true}"#),
        ]
        #expect(SessionPreviewPresentation.rows(sessions, now: now).map(\.id) == ["big", "costly", "a"])
        #expect(SessionPreviewPresentation.rows(sessions, now: now, limit: 5).map(\.id) == ["big", "costly", "a", "b", "older"])
        #expect(SessionPreviewPresentation.runningCount(sessions, at: now) == 0)
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
