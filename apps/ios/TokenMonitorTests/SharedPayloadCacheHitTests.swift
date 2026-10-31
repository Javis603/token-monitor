import Foundation
import Testing
@testable import TokenMonitor

/// `TokenMonitorSharedPayload.Usage.cacheHitPercent` mirrors
/// `UsagePeriod.cacheHitPercent` for the widget snapshot.
struct SharedPayloadCacheHitTests {
    private func usage(
        tokens: Double,
        cacheRead: Double,
        output: Double,
        unclassified: Double? = nil,
        components: Bool? = nil
    ) -> TokenMonitorSharedPayload.Usage {
        TokenMonitorSharedPayload.Usage(
            tokens: tokens,
            cost: 0,
            cacheReadTokens: cacheRead,
            outputTokens: output,
            tools: [],
            models: [],
            tokenComponentsKnown: components,
            unclassifiedTokens: unclassified
        )
    }

    @Test func normalReadingSharesRateWithAppFormula() {
        // 1000 total − 200 output leaves 800 classified input, 400 of it cached.
        let value = usage(tokens: 1_000, cacheRead: 400, output: 200)
            .cacheHitPercent
        #expect(value == 50)
    }

    @Test func unclassifiedPortionPermitsRateWhenComponentsUnknown() {
        let value = usage(
            tokens: 1_000, cacheRead: 400, output: 200,
            unclassified: 100, components: false
        ).cacheHitPercent
        // classified = 900, output = 200, input = 700, read = 400.
        #expect(value == 400.0 / 700.0 * 100)
    }

    @Test func falseCapabilityWithoutUnclassifiedCannotProveRate() {
        #expect(
            usage(tokens: 1_000, cacheRead: 400, output: 200, components: false)
                .cacheHitPercent == nil
        )
    }

    @Test func zeroInputReturnsNil() {
        #expect(
            usage(tokens: 200, cacheRead: 0, output: 200)
                .cacheHitPercent == nil
        )
    }

    @Test func nonFiniteReadingsReturnNil() {
        #expect(
            usage(tokens: .nan, cacheRead: 400, output: 200)
                .cacheHitPercent == nil
        )
    }
}
