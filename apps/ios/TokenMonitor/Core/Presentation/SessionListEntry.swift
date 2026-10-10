import Foundation

nonisolated struct SessionListEntry: Identifiable, Sendable {
    enum Group: Sendable {
        case codexAutoReview
        case grokBot

        var client: String { self == .grokBot ? "cursor" : "codex" }
        var title: String { self == .grokBot ? "Grok Bot" : "Codex Auto Review" }
    }

    let id: String
    let session: SessionUsage?
    let reviews: [(key: String, value: SessionUsage)]
    var group: Group? = nil

    private var lastActivity: Date { session?.lastActivity ?? reviews.first?.value.lastActivity ?? .distantPast }

    /// Resolve identity from source models before aliases can hide the grok-bot prefix.
    static func grokBotIDs(_ periods: [String: UsagePeriod], authoritative: [String]? = nil) -> Set<String> {
        if let authoritative { return Set(authoritative) }
        return Set(periods.values.flatMap { period in
            (period.sessions ?? [:]).compactMap { key, session in
                session.isGrokBot(key: key) ? session.identityKey(fallback: key) : nil
            }
        })
    }

    var tokens: Double? {
        if let session { return session.measuredTokens }
        return reviews.reduce(0) { $0 + ($1.value.measuredTokens ?? 0) }
    }
    var cost: Double? {
        guard session == nil else { return session?.costUsd }
        guard reviews.allSatisfy({ $0.value.costUsd?.isFinite == true }) else { return nil }
        return reviews.reduce(0) { $0 + ($1.value.costUsd ?? 0) }
    }

    static func rows(_ sessions: [String: SessionUsage], query: String = "", grokBotIDs: Set<String> = []) -> [SessionListEntry] {
        let ordered = sessions.filter { key, value in
            // Same session partition as desktop; background runs are source-tagged, never title-guessed.
            !(value.client == "reasonix" && key.contains("reasonix-stats:")) &&
            value.measuredTokens != 0 && (value.matches(query)
                || (value.isBackgroundReview && "Codex Auto Review".localizedStandardContains(query))
                || ((value.isGrokBot(key: key) || (value.client == "cursor" && grokBotIDs.contains(value.identityKey(fallback: key))))
                    && "Grok Bot".localizedStandardContains(query)))
        }.sorted {
            let left = $0.value.lastActivity ?? .distantPast, right = $1.value.lastActivity ?? .distantPast
            if left != right { return left > right }
            let a = $0.value.measuredTokens ?? 0, b = $1.value.measuredTokens ?? 0
            if a != b { return a > b }
            let c = $0.value.costUsd ?? 0, d = $1.value.costUsd ?? 0
            return c == d ? $0.key < $1.key : c > d
        }
        var primary: [SessionListEntry] = []
        var reviews: [(key: String, value: SessionUsage)] = []
        var bots: [(key: String, value: SessionUsage)] = []
        for (key, value) in ordered {
            if value.isGrokBot(key: key) || (value.client == "cursor" && grokBotIDs.contains(value.identityKey(fallback: key))) {
                bots.append((key, value))
            } else if value.isBackgroundReview {
                reviews.append((key, value))
            } else {
                primary.append(SessionListEntry(id: key, session: value, reviews: []))
            }
        }
        if !reviews.isEmpty {
            primary.append(SessionListEntry(id: "session-group:codex-auto-review", session: nil,
                                            reviews: reviews, group: .codexAutoReview))
        }
        if !bots.isEmpty {
            primary.append(SessionListEntry(id: "session-group:cursor-grok-bot", session: nil,
                                            reviews: bots, group: .grokBot))
        }
        return primary.sorted {
            if $0.lastActivity != $1.lastActivity { return $0.lastActivity > $1.lastActivity }
            if ($0.tokens ?? 0) != ($1.tokens ?? 0) { return ($0.tokens ?? 0) > ($1.tokens ?? 0) }
            if ($0.cost ?? 0) != ($1.cost ?? 0) { return ($0.cost ?? 0) > ($1.cost ?? 0) }
            return $0.id < $1.id
        }
    }
}
