import Foundation

nonisolated extension TokenMonitorSharedPayload.Usage {
    /// Same formula as `UsagePeriod.cacheHitPercent`: cache-read share of the
    /// classified input tokens. An explicit unclassified portion permits a
    /// rate for the classified input; a false capability without that
    /// breakdown still cannot prove a rate.
    var cacheHitPercent: Double? {
        guard tokens.isFinite, tokens >= 0,
              cacheReadTokens.isFinite, cacheReadTokens >= 0,
              outputTokens.isFinite, outputTokens >= 0 else { return nil }
        let unknown = unclassifiedTokens ?? 0
        guard unknown.isFinite, unknown >= 0 else { return nil }
        guard tokenComponentsKnown != false || unknown > 0 else { return nil }
        let classified = tokens - min(tokens, unknown)
        let read = min(classified, cacheReadTokens)
        let output = min(classified - read, outputTokens)
        let input = classified - output
        guard input > 0 else { return nil }
        return read / input * 100
    }
}
