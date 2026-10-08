import Foundation

nonisolated struct SessionListEntry: Identifiable, Sendable {
    let id: String
    let session: SessionUsage?
    let reviews: [(key: String, value: SessionUsage)]

    var tokens: Double? {
        if let session { return session.measuredTokens }
        return reviews.reduce(0) { $0 + ($1.value.measuredTokens ?? 0) }
    }
    var cost: Double? {
        guard session == nil else { return session?.costUsd }
        guard reviews.allSatisfy({ $0.value.costUsd?.isFinite == true }) else { return nil }
        return reviews.reduce(0) { $0 + ($1.value.costUsd ?? 0) }
    }

    static func rows(_ sessions: [String: SessionUsage], query: String = "") -> [SessionListEntry] {
        let ordered = sessions.filter { key, value in
            // Same session partition as desktop; background runs are source-tagged, never title-guessed.
            !(value.client == "reasonix" && key.contains("reasonix-stats:")) &&
            value.measuredTokens != 0 && value.matches(query)
        }.sorted {
            let left = $0.value.lastActivity ?? .distantPast, right = $1.value.lastActivity ?? .distantPast
            if left != right { return left > right }
            let a = $0.value.measuredTokens ?? 0, b = $1.value.measuredTokens ?? 0
            if a != b { return a > b }
            let c = $0.value.costUsd ?? 0, d = $1.value.costUsd ?? 0
            return c == d ? $0.key < $1.key : c > d
        }
        let primary = ordered.filter { !$0.value.isBackgroundReview }.map {
            SessionListEntry(id: $0.key, session: $0.value, reviews: [])
        }
        let reviews = ordered.filter { $0.value.isBackgroundReview }
        guard !reviews.isEmpty else { return primary }
        return primary + [SessionListEntry(id: "session-group:codex-auto-review", session: nil, reviews: reviews)]
    }
}
