import Foundation
import Testing
@testable import TokenMonitor

struct SessionUsageTests {
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
