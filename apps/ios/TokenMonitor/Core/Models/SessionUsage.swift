import Foundation

/// A collector's live reading of one session: provider-observed state plus the
/// observation time. On the wire as `session.liveActivity` and in the period's
/// `sessionActivity` overlay; mirrors `src/shared/sessionLive.js`.
nonisolated struct LiveSessionActivity: Decodable, Sendable {
    let state: String?
    let observedAt: String?

    static let validStates: Set<String> = ["running", "waiting", "idle", "unknown"]

    var observedDate: Date? { Date.hubTimestamp(from: observedAt) }

    /// The 30-second lease from `liveActivityExpiryAt`: reject future
    /// observations and anything older than the lease; `unknown` never
    /// overrides the transcript reading.
    func expiryAt(now: Date) -> Date? {
        guard let state, Self.validStates.contains(state), state != "unknown",
              let observed = observedDate, observed <= now else { return nil }
        let expiry = observed.addingTimeInterval(30)
        return expiry > now ? expiry : nil
    }

    /// `canReplaceLiveActivity`: a valid, non-future observation that is at
    /// least as new as the previous one (or the previous one is itself
    /// future-dated and therefore untrusted).
    func canReplace(_ previous: LiveSessionActivity?, now: Date) -> Bool {
        guard let incoming = observedDate, incoming <= now else { return false }
        guard let prior = previous?.observedDate else { return true }
        return prior > now || incoming >= prior
    }
}

/// The presentation states a session row can be in; mirrors
/// `sessionActivityState` in `src/shared/sessionLive.js`. `ended` means the
/// transcript reported the turn finished inside the activity window.
nonisolated enum SessionActivityState: Sendable {
    case running, waiting, ended, idle
}

/// Only the bounded, authenticated Hub summary is decoded. Transcripts stay on the collector.
nonisolated struct SessionUsage: Decodable, Sendable {
    let client: String?
    let sessionId: String?
    let title: String?
    let projectLabel: String?
    let totalTokens: Double?
    let costUsd: Double?
    let messageCount: Int?
    let outputTokens: Double?
    let timedOutputTokens: Double?
    let timedDurationMs: Double?
    let lastUsedAt: String?
    let startedAt: String?
    var models: [String: Double]?
    let contextTokens: Double?
    let contextWindow: Double?
    let turnEnded: Bool?
    let tokenDataUnavailable: Bool?
    var inputTokens: Double? = nil
    var cacheReadTokens: Double? = nil
    var cacheWriteTokens: Double? = nil
    var archived: Bool? = nil
    var deleted: Bool? = nil
    var sourceDeleted: Bool? = nil
    var sessionKind: String? = nil
    var promptCache: PromptCacheObservation? = nil
    var grokBotSession: Bool? = nil
    var parentSessionId: String? = nil
    var parentClient: String? = nil
    var nativeSessionId: String? = nil
    var t3ThreadId: String? = nil
    var waitingForInput: Bool? = nil
    var liveActivity: LiveSessionActivity? = nil
    var unpricedTokens: Double? = nil
    var reasoningEffort: String? = nil

    /// Persistent provider setting, independent of the context/cache leases.
    /// Matches shared/sessionLive.normalizeReasoningEffort.
    var displayReasoningEffort: String? {
        guard client == "codex" || client == "claude", let reasoningEffort else { return nil }
        let value = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.lowercased() != "unknown",
              value.range(of: #"\A[a-zA-Z][a-zA-Z0-9_-]{0,31}\z"#, options: .regularExpression) != nil else { return nil }
        return value
    }

    func identityKey(fallback key: String) -> String {
        let id = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !id.isEmpty ? id : (key.hasPrefix("cursor:") ? String(key.dropFirst(7)) : key)
    }

    func isGrokBot(key: String) -> Bool {
        guard client == "cursor" else { return false }
        if let grokBotSession { return grokBotSession }
        let id = identityKey(fallback: key)
        return (id.hasPrefix("sand-subagent-") && id.count > "sand-subagent-".count)
            || (models ?? [:]).contains { model, tokens in
                model.hasPrefix("grok-bot-") && model.count > "grok-bot-".count && tokens.isFinite && tokens > 0
            }
    }

    var isBackgroundReview: Bool { sessionKind?.trimmingCharacters(in: .whitespacesAndNewlines) == "background-review" }

    /// Clients whose collectors publish `sessionActivity` observations
    /// (`SESSION_ACTIVITY_CLIENTS` in shared/sessionActivityProviders.js).
    private static let activityClients: Set<String> = ["claude", "codex"]

    /// The live observation that currently applies, if any. The period's
    /// `sessionActivity` overlay is joined upstream by `UsagePeriod
    /// .sessionWithActivity`; here only the merged `liveActivity` is read.
    private func liveState(at now: Date) -> String? {
        guard Self.activityClients.contains(client ?? ""), !isArchived,
              liveActivity?.expiryAt(now: now) != nil else { return nil }
        return liveActivity?.state
    }

    /// Mirrors `sessionActivityState`: archived sessions are idle; a live
    /// provider observation inside its lease wins outright; otherwise the
    /// transcript decides — recent without a turn end is running (or waiting
    /// on a Codex question), a reported turn end is `ended`, and silence past
    /// the window is idle.
    func activityState(at now: Date) -> SessionActivityState {
        guard !isArchived else { return .idle }
        if let live = liveState(at: now) {
            switch live {
            case "running": return .running
            case "waiting": return .waiting
            case "idle": return .idle
            default: break
            }
        }
        guard isRecent(at: now) else { return .idle }
        if turnEnded == true { return .ended }
        if client == "codex", waitingForInput == true { return .waiting }
        return .running
    }

    func isRunning(at now: Date) -> Bool { activityState(at: now) == .running }
    func isWaiting(at now: Date) -> Bool { activityState(at: now) == .waiting }

    /// A session with a verified `parentSessionId` that is not one of the
    /// fixed aggregates — mirrors the `subagent` predicate in sessionRows.js.
    /// `parentClient` defaults to the child's client, so a same-session or
    /// self-link never counts.
    var isSubagent: Bool { parentKey != nil }

    /// `session:<parentClient>:<parentSessionId>` — the key the parent row
    /// carries when it is visible in the same list, or nil for top-level
    /// sessions and for the aggregates that keep their own groups.
    var parentKey: String? {
        let parentId = parentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !parentId.isEmpty, !isBackgroundReview else { return nil }
        let parent = parentClient?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedClient = (parent?.isEmpty == false ? parent! : client) ?? ""
        guard resolvedClient != client || parentId != (sessionId ?? "") else { return nil }
        return "session:\(resolvedClient):\(parentId)"
    }

    /// The conversation identity `sessionConversationIdentity` groups by:
    /// verified T3 thread, then the Codex native conversation UUID, then the
    /// accounting key itself.
    func conversationIdentity(key: String) -> String {
        if let t3 = t3ThreadId?.trimmingCharacters(in: .whitespacesAndNewlines), !t3.isEmpty {
            return "t3:\(t3)"
        }
        if client == "codex",
           let native = nativeSessionId?.trimmingCharacters(in: .whitespacesAndNewlines), !native.isEmpty {
            return "codex:\(native)"
        }
        return "session:\(key)"
    }

    func cacheMinutesRemaining(at now: Date) -> Int? {
        // Ignore legacy Codex estimates from older Hubs, devices and archives.
        guard !isArchived, client == "claude", let promptCache,
              [300, 1800, 3600].contains(promptCache.ttlSeconds),
              let observed = Date.hubTimestamp(from: promptCache.observedAt), observed <= now else { return nil }
        let remaining = observed.addingTimeInterval(Double(promptCache.ttlSeconds)).timeIntervalSince(now)
        return remaining > 0 ? Int(ceil(remaining / 60)) : nil
    }

    var displayTitle: String? {
        guard let title else { return nil }
        let bounded = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return bounded.isEmpty ? nil : String(bounded.prefix(160))
    }

    var lastActivity: Date? {
        Date.hubTimestamp(from: lastUsedAt) ?? Date.hubTimestamp(from: startedAt)
    }

    var primaryModel: String? {
        models?.sorted {
            $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value
        }.first?.key
    }

    var measuredTokens: Double? {
        guard tokenDataUnavailable != true, let totalTokens,
              totalTokens.isFinite, totalTokens >= 0 else { return nil }
        return totalTokens
    }

    var outputTokensPerSecond: Double? {
        guard let timedOutputTokens, let timedDurationMs,
              timedOutputTokens.isFinite, timedDurationMs.isFinite,
              timedOutputTokens > 0, timedDurationMs > 0 else { return nil }
        let measuredOutput = outputTokens.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        let speed = min(timedOutputTokens, measuredOutput ?? timedOutputTokens) / (timedDurationMs / 1_000)
        return speed.isFinite && speed > 0 ? speed : nil
    }

    var modelEntries: [BreakdownEntry] {
        (models ?? [:]).filter { !$0.key.isEmpty && $0.value.isFinite && $0.value > 0 }
            .map { BreakdownEntry(id: $0.key, value: $0.value, cost: 0) }
            .sorted { $0.value == $1.value ? $0.id < $1.id : $0.value > $1.value }
    }

    var cacheHitPercent: Double? {
        guard measuredTokens != nil,
              let inputTokens, inputTokens.isFinite, inputTokens >= 0,
              let cacheReadTokens, cacheReadTokens.isFinite, cacheReadTokens >= 0,
              let cacheWriteTokens, cacheWriteTokens.isFinite, cacheWriteTokens >= 0,
              cacheReadTokens > 0 || cacheWriteTokens > 0 else { return nil }
        let input = inputTokens + cacheReadTokens + cacheWriteTokens
        guard input.isFinite, input > 0 else { return nil }
        return cacheReadTokens / input * 100
    }

    var isArchived: Bool { archived == true || deleted == true || sourceDeleted == true }

    func isRecent(at now: Date) -> Bool {
        guard !isArchived, let last = Date.hubTimestamp(from: lastUsedAt) else { return false }
        let age = now.timeIntervalSince(last)
        return age >= 0 && age <= 600
    }

    func contextUsedPercent(at now: Date) -> Double? {
        guard isRecent(at: now), let contextTokens, let contextWindow,
              contextTokens.isFinite, contextWindow.isFinite,
              contextTokens > 0, contextWindow > 0 else { return nil }
        let left = max(0, ((contextWindow - contextTokens) / contextWindow * 100).rounded())
        return 100 - left
    }

    func matches(_ query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        return ([displayTitle, client, sessionId, projectLabel] + modelEntries.map { Optional($0.id) })
            .compactMap { $0 }
            .contains { $0.localizedStandardContains(query) }
    }
}
