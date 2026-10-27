import Foundation
import Testing
@testable import TokenMonitor

struct SSEDecoderTests {
    @Test func streamV3RenewsOnlyExistingAggregateAndDeviceSessionLeases() throws {
        var parser = SSEDecoder()
        // Matches shared/hubProtocol.freshnessEvent: aggregate and per-device
        // sessions can select independent observations for the same identity.
        let full = #"data: {"type":"stats","stats":{"periods":{"today":{"totalTokens":42,"sessions":{"codex:a":{"client":"codex","totalTokens":42,"lastUsedAt":"2026-10-27T23:00:00Z","liveActivity":{"state":"running","observedAt":"2026-10-28T00:00:00Z"}},"plain":{"client":"claude"}}}},"devices":[{"deviceId":"mac","periods":{"today":{"sessions":{"codex:a":{"client":"codex","liveActivity":{"state":"waiting","observedAt":"2026-10-28T00:00:00Z"}}}}}}]}}"# + "\n\n"
        let now = try #require(Date.hubTimestamp(from: "2026-10-28T00:00:40Z"))
        let original = try #require(feed(full, parser: &parser).first)
        #expect(original.period(.today).sessions?["codex:a"]?.activityState(at: now) == .idle)
        let patch = #"data: {"type":"freshness","stats":{"updatedAt":"2026-10-28T00:00:39Z","sessionActivityObservedAt":{"today":{"codex:a":"2026-10-28T00:00:30Z","plain":"2026-10-28T00:00:30Z","absent":"2026-10-28T00:00:30Z"}},"devices":[{"deviceId":"mac","sessionActivityObservedAt":{"today":{"codex:a":"2026-10-28T00:00:25Z"}}}]}}"# + "\n\n"
        let stats = try #require(feed(patch, parser: &parser).first)
        let session = try #require(stats.period(.today).sessions?["codex:a"])
        #expect(session.activityState(at: now) == .running)
        #expect(session.activityState(at: now.addingTimeInterval(21)) == .idle)
        #expect(session.lastUsedAt == "2026-10-27T23:00:00Z")
        #expect(session.totalTokens == 42)
        #expect(stats.period(.today).totalTokens == 42)
        #expect(stats.period(.today).sessions?.count == 2)
        #expect(stats.period(.today).sessions?["plain"]?.liveActivity == nil)
        #expect(stats.devices?.first?.period(.today).sessions?["codex:a"]?.activityState(at: now) == .waiting)
        #expect(original.period(.today).sessions?["codex:a"]?.liveActivity?.observedAt == "2026-10-28T00:00:00Z")
        let invalid = #"data: {"type":"freshness","stats":{"sessionActivityObservedAt":{"today":{"codex:a":"bad-date","plain":7}},"devices":[{"deviceId":"mac","updatedAt":"2026-10-28T00:01:00Z"}]}}"# + "\n\n"
        let retained = try #require(feed(invalid, parser: &parser).first)
        #expect(retained.period(.today).sessions?["codex:a"]?.liveActivity?.observedAt == "2026-10-28T00:00:30Z")
        #expect(retained.devices?.first?.period(.today).sessions?["codex:a"]?.activityState(at: now.addingTimeInterval(21)) == .idle)
    }

    @Test func newFullSnapshotClearsLeasesAndClockPatchesCannotRestoreThem() throws {
        var parser = SSEDecoder()
        let full = #"data: {"type":"stats","stats":{"periods":{"today":{"sessions":{"a":{"client":"claude","liveActivity":null}}}}}}"# + "\n\n"
        _ = try feed(full, parser: &parser)
        let patch = #"data: {"type":"freshness","stats":{"sessionActivityObservedAt":{"today":{"a":"2026-10-28T00:00:30Z"}}}}"# + "\n\n"
        let stats = try #require(feed(patch, parser: &parser).first)
        #expect(stats.period(.today).sessions?["a"]?.liveActivity == nil)
    }

    private func feed(_ value: String, parser: inout SSEDecoder) throws -> [HubStats] {
        try value.utf8.compactMap { try parser.consume(byte: $0, decoder: JSONDecoder()) }
    }

    @Test func freshnessNeedsBaselineAndPreservesUsageAndHistory() throws {
        var parser = SSEDecoder()
        let orphan = #"data: {"type":"freshness","stats":{"updatedAt":"2026-10-05T01:00:00Z"}}"# + "\n\n"
        #expect(try feed(orphan, parser: &parser).isEmpty)
        let full = #"data: {"type":"stats","stats":{"historyRevision":"r1","periods":{"today":{"totalTokens":42}},"devices":[{"deviceId":"a","updatedAt":"2026-10-01T00:00:00Z","periods":{"today":{"totalTokens":42}}},{"deviceId":"b","stale":true}],"limits":{"providers":[{"provider":"codex"}]}}}"# + "\n\n"
        #expect(try feed(full, parser: &parser).count == 1)
        let patch = #"data: {"type":"freshness","stats":{"updatedAt":"2026-10-05T00:00:00Z","staleAfterMs":1000,"periods":{"today":{"totalTokens":999}},"limits":{"updatedAt":"2026-10-05T00:00:00Z"},"devices":[{"deviceId":"a","ageMs":20,"receivedAt":"2026-10-05T00:00:00Z","stale":false},{"deviceId":"unknown","stale":false}]}}"# + "\n\n"
        let stats = try #require(feed(patch, parser: &parser).first)
        #expect(stats.period(.today).totalTokens == 42)
        #expect(stats.historyRevision == "r1")
        #expect(stats.devices?.count == 2)
        #expect(stats.devices?.first?.period(.today).totalTokens == 42)
        #expect(stats.devices?.first?.updatedAt == "2026-10-01T00:00:00Z")
        #expect(stats.devices?.first?.ageMs == 20)
        #expect(stats.devices?.last?.stale == true)
        #expect(stats.limits?.providers?.first?.provider == "codex")
        #expect(stats.limits?.updatedAt == "2026-10-05T00:00:00Z")
    }

    @Test func acceptsBOMMultilineAndAllSSEDelimiters() throws {
        for delimiter in ["\n", "\r", "\r\n"] {
            var parser = SSEDecoder()
            let lines = ["\u{FEFF}: heartbeat", "event: snapshot", "data: {\"type\":\"stats\",", "data: \"stats\":{\"periods\":{\"today\":{\"totalTokens\":7}}}}", "", ""]
            #expect(try feed(lines.joined(separator: delimiter), parser: &parser).first?.period(.today).totalTokens == 7)
        }
    }

    @Test func rejectsOversizedEventsAndDoesNotDispatchUnterminatedEvents() throws {
        var parser = SSEDecoder()
        #expect(try feed("data: {\"type\":\"stats\",\"stats\":{}}\n", parser: &parser).isEmpty)
        #expect(throws: (any Error).self) {
            _ = try parser.consume(line: "data: " + String(repeating: "x", count: SSEDecoder.maximumEventBytes), decoder: JSONDecoder())
        }
    }

    @Test
    func decodesSnapshotAndIgnoresHeartbeat() throws {
        var parser = SSEDecoder()
        let decoder = JSONDecoder()

        #expect(try parser.consume(line: ": hb", decoder: decoder) == nil)
        #expect(try parser.consume(line: "", decoder: decoder) == nil)
        #expect(try parser.consume(line: "event: snapshot", decoder: decoder) == nil)
        #expect(
            try parser.consume(
                line: #"data: {"type":"stats","reason":"snapshot","stats":{"periods":{"today":{"totalTokens":42}}}}"#,
                decoder: decoder
            ) == nil
        )

        let stats = try parser.consume(line: "", decoder: decoder)
        #expect(stats?.period(.today).totalTokens == 42)
    }
}
