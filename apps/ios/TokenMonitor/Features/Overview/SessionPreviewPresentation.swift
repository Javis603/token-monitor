import Foundation

/// Selection for the compact Overview sessions card. Entries come from
/// `SessionListEntry.rows` so a folded conversation group occupies one
/// preview row; the fixed aggregates (background reviews, Grok Bot) stay on
/// the Sessions tab rather than occupying a preview row.
nonisolated enum SessionPreviewPresentation {
    /// Up to `limit` entries — running sessions first, then most recent activity.
    static func rows(
        _ sessions: [String: SessionUsage],
        activity: [String: LiveSessionActivity]? = nil,
        grokBotIDs: Set<String> = [],
        now: Date,
        limit: Int = 3
    ) -> [SessionListEntry] {
        let entries = SessionListEntry.rows(sessions, activity: activity, grokBotIDs: grokBotIDs, now: now)
            .filter { $0.group == nil }
        let sorted = entries.sorted { precedes($0, $1, now: now) }
        // The count limits inactive previews; active work stays visible beyond it.
        return sorted.enumerated().compactMap { index, entry in
            index < max(1, min(50, limit)) || entry.activityState(at: now) == .running
                || entry.activityState(at: now) == .waiting ? entry : nil
        }
    }

    /// Running entries across the whole eligible set — a group counts once
    /// when any of its members is running.
    static func runningCount(_ sessions: [String: SessionUsage], at now: Date,
                             activity: [String: LiveSessionActivity]? = nil,
                             grokBotIDs: Set<String> = []) -> Int {
        SessionListEntry.rows(sessions, activity: activity, grokBotIDs: grokBotIDs, now: now)
            .filter { $0.group == nil }
            .count { $0.isRunning(at: now) }
    }

    private static func precedes(_ lhs: SessionListEntry, _ rhs: SessionListEntry, now: Date) -> Bool {
        if lhs.isRunning(at: now) != rhs.isRunning(at: now) {
            return lhs.isRunning(at: now)
        }
        if lhs.lastActivity != rhs.lastActivity { return lhs.lastActivity > rhs.lastActivity }
        let a = lhs.tokens ?? 0, b = rhs.tokens ?? 0
        if a != b { return a > b }
        let c = lhs.cost ?? 0, d = rhs.cost ?? 0
        return c == d ? lhs.id < rhs.id : c > d
    }
}

nonisolated extension SessionListEntry {
    /// The group is live when any member is; waiting only when nothing runs.
    func activityState(at now: Date) -> SessionActivityState {
        guard isSessionGroup else { return session?.activityState(at: now) ?? .idle }
        let states = members.map { $0.session.activityState(at: now) }
        if states.contains(.running) { return .running }
        if states.contains(.waiting) { return .waiting }
        return session?.activityState(at: now) ?? .idle
    }

    func isRunning(at now: Date) -> Bool { activityState(at: now) == .running }
}
