import Foundation

/// Selection for the compact Overview sessions card. Eligibility matches the
/// full Sessions list (`SessionListEntry`) minus its background-review
/// aggregate: background runs stay on the Sessions tab rather than occupying a
/// preview row.
nonisolated enum SessionPreviewPresentation {
    struct Row: Identifiable, Sendable {
        /// The Hub session key, stable across stream frames.
        let id: String
        let session: SessionUsage
    }

    /// Up to `limit` rows — running sessions first, then most recent activity.
    static func rows(
        _ sessions: [String: SessionUsage],
        now: Date,
        limit: Int = 3
    ) -> [Row] {
        Array(eligible(sessions).sorted { precedes($0, $1, now: now) }.prefix(limit))
    }

    /// Running sessions across the whole eligible set, not just the shown rows.
    static func runningCount(_ sessions: [String: SessionUsage], at now: Date) -> Int {
        eligible(sessions).count { $0.session.isRunning(at: now) }
    }

    private static func eligible(_ sessions: [String: SessionUsage]) -> [Row] {
        sessions.filter { key, value in
            !(value.client == "reasonix" && key.contains("reasonix-stats:"))
                && !value.isBackgroundReview
                && value.measuredTokens != 0
        }.map { Row(id: $0.key, session: $0.value) }
    }

    private static func precedes(_ lhs: Row, _ rhs: Row, now: Date) -> Bool {
        if lhs.session.isRunning(at: now) != rhs.session.isRunning(at: now) {
            return lhs.session.isRunning(at: now)
        }
        let left = lhs.session.lastActivity ?? .distantPast
        let right = rhs.session.lastActivity ?? .distantPast
        if left != right { return left > right }
        let a = lhs.session.measuredTokens ?? 0, b = rhs.session.measuredTokens ?? 0
        if a != b { return a > b }
        let c = lhs.session.costUsd ?? 0, d = rhs.session.costUsd ?? 0
        return c == d ? lhs.id < rhs.id : c > d
    }
}
