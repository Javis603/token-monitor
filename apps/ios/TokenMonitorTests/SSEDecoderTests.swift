import Foundation
import Testing
@testable import TokenMonitor

struct SSEDecoderTests {
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
