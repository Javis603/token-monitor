import Foundation

nonisolated struct SessionListEntry: Identifiable, Sendable {
    enum Group: Sendable {
        case codexAutoReview
        case grokBot

        var client: String { self == .grokBot ? "cursor" : "codex" }
        var title: String { self == .grokBot ? "Grok Bot" : "Codex Auto Review" }
    }

    /// One member of a folded session group. `main` marks rows that share the
    /// header's conversation identity — T3 continuations and Codex rollout
    /// files of one native conversation — everything else is a subagent.
    struct Member: Sendable {
        let key: String
        let session: SessionUsage
        let isMain: Bool
    }

    let id: String
    let session: SessionUsage?
    let reviews: [(key: String, value: SessionUsage)]
    var group: Group? = nil
    /// Non-empty marks a folded subagent/conversation group: `session` is the
    /// display header, `members` lists every row of the group — mains first,
    /// then subagents, each sorted by latest activity.
    var members: [Member] = []
    var subagentCount = 0

    var isSessionGroup: Bool { !members.isEmpty }

    /// Latest activity across the header, group members and aggregate rows —
    /// the clock every surface sorts by.
    var lastActivity: Date {
        session?.lastActivity
            ?? members.lazy.compactMap { $0.session.lastActivity }.max()
            ?? reviews.first?.value.lastActivity
            ?? .distantPast
    }

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
        if isSessionGroup {
            return members.allSatisfy { $0.session.measuredTokens == nil }
                ? nil : members.reduce(0) { $0 + ($1.session.measuredTokens ?? 0) }
        }
        if let session { return session.measuredTokens }
        return reviews.allSatisfy { $0.value.measuredTokens == nil }
            ? nil : reviews.reduce(0) { $0 + ($1.value.measuredTokens ?? 0) }
    }
    var cost: Double? {
        if isSessionGroup {
            guard members.allSatisfy({ $0.session.costUsd?.isFinite == true }) else { return nil }
            return members.reduce(0) { $0 + ($1.session.costUsd ?? 0) }
        }
        guard session == nil else { return session?.costUsd }
        guard reviews.allSatisfy({ $0.value.costUsd?.isFinite == true }) else { return nil }
        return reviews.reduce(0) { $0 + ($1.value.costUsd ?? 0) }
    }
    var unpricedTokens: Double {
        if isSessionGroup { return members.reduce(0) { $0 + ($1.session.unpricedTokens ?? 0) } }
        if let session { return session.unpricedTokens ?? 0 }
        return reviews.reduce(0) { $0 + ($1.value.unpricedTokens ?? 0) }
    }

    static func rows(
        _ sessions: [String: SessionUsage],
        activity: [String: LiveSessionActivity]? = nil,
        query: String = "",
        grokBotIDs: Set<String> = [],
        now: Date = .now
    ) -> [SessionListEntry] {
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
            var session = value
            if let observation = activity?[key],
               let state = observation.state, LiveSessionActivity.validStates.contains(state),
               !session.isArchived, ["claude", "codex"].contains(session.client ?? ""),
               observation.canReplace(session.liveActivity, now: now) {
                session.liveActivity = observation
            }
            if value.isGrokBot(key: key) || (value.client == "cursor" && grokBotIDs.contains(value.identityKey(fallback: key))) {
                bots.append((key, session))
            } else if value.isBackgroundReview {
                reviews.append((key, session))
            } else {
                primary.append(SessionListEntry(id: key, session: session, reviews: []))
            }
        }
        primary = foldSubagents(primary)
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

    // MARK: - Subagent / conversation grouping

    /// Mirrors `groupSubagentRows` in src/electron/renderer/sessionRows.js: a
    /// subagent folds under the session that started it while that parent is
    /// visible in the same list. Verified conversation identities (T3 thread,
    /// Codex native UUID) alias several accounting rows to one conversation
    /// without changing their keys, so continuations render as mains rather
    /// than delegated children. A child whose parent is absent stays its own
    /// row; contradictory relationship facts never collapse identities.
    private static func foldSubagents(_ entries: [SessionListEntry]) -> [SessionListEntry] {
        struct Row {
            let key: String
            let session: SessionUsage
            var rowKey: String { "session:\(key)" }
            var identity: String { session.conversationIdentity(key: key) }
        }
        let rows = entries.compactMap { entry -> Row? in
            guard let session = entry.session else { return nil }
            return Row(key: entry.id, session: session)
        }
        var byKey: [String: Row] = [:]
        for row in rows { byKey[row.rowKey] = row }
        // Canonical row per conversation identity: the lowest key wins.
        var aliases: [String: Row] = [:]
        for row in rows {
            if let previous = aliases[row.identity], row.rowKey >= previous.rowKey { continue }
            aliases[row.identity] = row
        }
        var parentLinks: [String: (link: String, parentKey: String)] = [:]
        var conflicts: Set<String> = []
        for row in rows {
            guard let parentKey = row.session.parentKey else { continue }
            let parent = byKey[parentKey]
            let link = parent?.identity ?? parentKey
            if link == row.identity { continue }
            if let existing = parentLinks[row.identity], existing.link != link {
                conflicts.insert(row.identity)
            } else {
                parentLinks[row.identity] = (link, parentKey)
            }
        }
        func canonical(_ row: Row) -> Row {
            conflicts.contains(row.identity) ? row : (aliases[row.identity] ?? row)
        }
        func rootOf(_ row: Row) -> Row {
            var seen: Set<String> = []
            var current = canonical(row)
            while !seen.contains(current.rowKey) {
                let parentKey = conflicts.contains(current.identity)
                    ? current.session.parentKey
                    : parentLinks[current.identity]?.parentKey
                guard let parentKey else { break }
                seen.insert(current.rowKey)
                guard let parent = byKey[parentKey] else { break }
                let next = canonical(parent)
                if seen.contains(next.rowKey) { return canonical(row) }
                current = next
            }
            return current
        }
        var children: [String: [Row]] = [:]
        var grouped: Set<String> = []
        for row in rows {
            let root = rootOf(row)
            if root.rowKey == row.rowKey { continue }
            children[root.rowKey, default: []].append(row)
            grouped.insert(row.rowKey)
        }
        guard !grouped.isEmpty else { return entries }
        return entries.compactMap { entry in
            let rowKey = "session:\(entry.id)"
            if grouped.contains(rowKey) { return nil }
            guard let members = children[rowKey], let session = entry.session else { return entry }
            return sessionGroup(key: entry.id, session: session,
                                members: members.map { (key: $0.key, session: $0.session) },
                                splitIdentity: conflicts.contains(session.conversationIdentity(key: entry.id)))
        }
    }

    /// The group entry is the latest same-conversation row — a continuation
    /// can out-sort the root — carrying the group's totals. Members are mains
    /// (same conversation identity, incl. the header) then subagents, each by
    /// latest activity; the count covers distinct subagent conversations.
    private static func sessionGroup(
        key: String,
        session: SessionUsage,
        members: [(key: String, session: SessionUsage)],
        splitIdentity: Bool
    ) -> SessionListEntry {
        struct Row {
            let key: String
            let session: SessionUsage
            var identity: String { session.conversationIdentity(key: key) }
        }
        let parentIdentity = session.conversationIdentity(key: key)
        let all = [Row(key: key, session: session)]
            + members.map { Row(key: $0.key, session: $0.session) }
        let mains = all.filter { $0.identity == parentIdentity }
            .sorted { ($0.session.lastActivity ?? .distantPast) > ($1.session.lastActivity ?? .distantPast) }
        let subs = all.filter { $0.identity != parentIdentity }
            .sorted { ($0.session.lastActivity ?? .distantPast) > ($1.session.lastActivity ?? .distantPast) }
        let display = mains[0]
        let identityLabel = parentIdentity.hasPrefix("session:")
            ? String(parentIdentity.dropFirst("session:".count)) : parentIdentity
        let suffix = splitIdentity ? ":root:\(key)" : ""
        return SessionListEntry(
            id: "session-group:subagents:\(identityLabel)\(suffix)",
            session: display.session,
            reviews: [],
            members: (mains + subs).map { Member(key: $0.key, session: $0.session, isMain: $0.identity == parentIdentity) },
            subagentCount: Set(subs.map(\.identity)).count
        )
    }
}
