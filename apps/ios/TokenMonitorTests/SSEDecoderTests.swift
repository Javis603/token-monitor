import Foundation
import Testing
@testable import TokenMonitor

struct SSEDecoderTests {
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
