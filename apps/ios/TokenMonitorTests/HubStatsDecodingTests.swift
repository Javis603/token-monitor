import Foundation
import Testing
@testable import TokenMonitor

struct HubStatsDecodingTests {
    @Test func deviceRowsUseConfiguredNamesAndSelectedPeriodUsageOrder() throws {
        let json = #"{"devices":[{"deviceId":"unknown","displayName":"","hostname":"Host"},{"deviceId":"small","displayName":"Work Mac","hostname":"system-host","stale":false,"periods":{"today":{"totalTokens":1},"month":{"totalTokens":100}}},{"deviceId":"large","stale":true,"periods":{"today":{"totalTokens":100},"month":{"totalTokens":1}}}]}"#
        let stats = try JSONDecoder().decode(HubStats.self, from: Data(json.utf8))
        #expect(stats.usageDevices(for: .today).map(\.id) == ["large", "small", "unknown"])
        #expect(stats.usageDevices(for: .month).map(\.id) == ["small", "large", "unknown"])
        #expect(stats.devices?[0].displayName == "Host")
        #expect(stats.devices?[1].displayName == "Work Mac")
        #expect(stats.devices?[0].period(.today).totalTokens == nil)
    }

    @Test
    func decodesCurrentHubShapeAndToleratesMissingOptionalFields() throws {
        let json = """
        {
          "updatedAt": "2026-07-31T01:02:03.000Z",
          "periods": {
            "today": {
              "totalTokens": 123456,
              "costUsd": 1.25,
              "clients": { "codex": 100000, "claude": 23456 },
              "models": { "gpt-5.5": 123456 }
            }
          },
          "devices": [
            {
              "deviceId": "macbook",
              "hostname": "macbook",
              "platform": "darwin-arm64",
              "stale": false,
              "periods": {
                "today": { "totalTokens": 123456 }
              }
            }
          ],
          "limits": {
            "providers": [
              {
                "provider": "codex",
                "status": "ok",
                "windows": [
                  {
                    "kind": "weekly",
                    "remainingPercent": 88,
                    "resetsAt": "2026-08-06T00:00:00.000Z"
                  }
                ]
              }
            ]
          }
        }
        """

        let stats = try JSONDecoder().decode(HubStats.self, from: Data(json.utf8))

        #expect(stats.period(.today).totalTokens == 123_456)
        #expect(stats.period(.today).clientEntries.first?.id == "codex")
        #expect(stats.devices?.first?.displayName == "macbook")
        #expect(stats.sortedLimits.first?.provider == "codex")
        #expect(stats.sortedLimits.first?.lowestRemainingPercent == 88)
    }
    @Test func overviewEfficiencyExcludesUnknownTokensAndUntimedOutput() throws {
        let json = #"{"totalTokens":1000,"cacheReadTokens":600,"outputTokens":100,"unclassifiedTokens":100,"timedOutputTokens":20,"timedDurationMs":2000}"#
        let period = try JSONDecoder().decode(UsagePeriod.self, from: Data(json.utf8))
        #expect(period.cacheHitPercent == 75)
        #expect(period.averageOutputTokensPerSecond == 10)
        let missing = try JSONDecoder().decode(UsagePeriod.self, from: Data(#"{"totalTokens":0}"#.utf8))
        #expect(missing.cacheHitPercent == nil)
        #expect(missing.averageOutputTokensPerSecond == nil)
        let unavailable = try JSONDecoder().decode(UsagePeriod.self, from: Data(#"{"totalTokens":1000,"cacheReadTokens":600,"outputTokens":100,"timedOutputTokens":20,"timedDurationMs":2000,"capabilities":{"tokenComponents":false,"throughput":false}}"#.utf8))
        #expect(unavailable.cacheHitPercent == nil)
        #expect(unavailable.averageOutputTokensPerSecond == nil)
    }

    @Test func overviewCacheHitUsesKnownInputWhenSplitIsPartial() throws {
        let partial = try JSONDecoder().decode(UsagePeriod.self, from: Data(#"{"totalTokens":1000,"cacheReadTokens":600,"outputTokens":100,"unclassifiedTokens":100,"capabilities":{"tokenComponents":false}}"#.utf8))
        #expect(partial.cacheHitPercent == 75)
        #expect(partial.cacheHitUsesPartialData)
        let unknown = try JSONDecoder().decode(UsagePeriod.self, from: Data(#"{"totalTokens":1000,"cacheReadTokens":0,"outputTokens":0,"unclassifiedTokens":1000,"capabilities":{"tokenComponents":false}}"#.utf8))
        #expect(unknown.cacheHitPercent == nil)
        #expect(!unknown.cacheHitUsesPartialData)
        let noHits = try JSONDecoder().decode(UsagePeriod.self, from: Data(#"{"totalTokens":1000,"cacheReadTokens":0,"outputTokens":100,"unclassifiedTokens":100,"capabilities":{"tokenComponents":false}}"#.utf8))
        #expect(noHits.cacheHitPercent == 0)
        #expect(noHits.cacheHitUsesPartialData)
        let unavailable = try JSONDecoder().decode(UsagePeriod.self, from: Data(#"{"totalTokens":1000,"cacheReadTokens":0,"outputTokens":0,"unclassifiedTokens":0,"capabilities":{"tokenComponents":false}}"#.utf8))
        #expect(unavailable.cacheHitPercent == nil)
        #expect(!unavailable.cacheHitUsesPartialData)
    }

    @Test func overviewMessagesUseSelectedHistoryBucketAndPreserveMissing() throws {
        let json = #"{"daily":[{"date":"2026-10-09","messages":12},{"date":"2026-10-08","messages":7}],"monthly":[{"month":"2026-10","perClient":{"codex":{"messages":19},"claude":{"messages":4}}}],"summary":{"messages":200}}"#
        let history = try JSONDecoder().decode(UsageHistory.self, from: Data(json.utf8))
        let date = try #require(Date.hubTimestamp(from: "2026-10-09T01:00:00Z"))
        let utc = try #require(TimeZone(secondsFromGMT: 0))
        #expect(history.messageCount(for: .today, now: date, timeZone: utc) == 12)
        #expect(history.messageCount(for: .month, now: date, timeZone: utc) == 23)
        #expect(history.messageCount(for: .allTime, now: date, timeZone: utc) == 200)
        let beforeUTCMidnight = try #require(Date.hubTimestamp(from: "2026-10-08T17:00:00Z"))
        let hongKong = try #require(TimeZone(identifier: "Asia/Hong_Kong"))
        #expect(history.messageCount(for: .today, now: beforeUTCMidnight, timeZone: hongKong) == 12)
        #expect(history.messageCount(for: .today, now: beforeUTCMidnight, timeZone: utc) == 7)
        let preview = try JSONDecoder().decode(UsageHistory.self, from: Data(#"{"daily":[{"date":"2026-10-09","tokens":100}],"monthly":[{"month":"2026-10","tokens":100}],"summary":{"messages":0}}"#.utf8))
        #expect(preview.messageCount(for: .today, now: date, timeZone: utc) == nil)
        #expect(preview.messageCount(for: .month, now: date, timeZone: utc) == nil)
        #expect(preview.messageCount(for: .allTime, now: date, timeZone: utc) == 0)
        let partial = try JSONDecoder().decode(HistoryMonth.self, from: Data(#"{"month":"2026-10","perClient":{"codex":{"messages":4},"claude":{}}}"#.utf8))
        #expect(partial.messageCount == nil)
    }

}
