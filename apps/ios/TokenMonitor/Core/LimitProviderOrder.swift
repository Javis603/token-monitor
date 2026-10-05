import Foundation

/// Desktop `normalizeLimitProviderOrder` / `orderedLimitProviders`: the saved
/// order wins, unseen catalog ids fill in behind it, and ids the catalog has
/// never heard of sort alphabetically at the end.
nonisolated enum LimitProviderOrder {
    /// Default provider order, mirroring LIMIT_PROVIDER_CATALOG in
    /// src/shared/limits/providers.js.
    static let defaultOrder: [String] = [
        "claude", "codex", "opencode", "cursor", "antigravity", "cline",
        "factory", "kimi", "grok", "copilot", "zed", "commandcode", "mimo",
        "zai", "zaiteam", "kiro", "workbuddy", "qoder", "deepseek", "devin",
        "minimax", "typesafe", "openrouter", "volcengine", "ollama", "trae",
        "alibaba", "stepfun", "thirdparty"
    ]

    static func normalizedID(_ raw: String?) -> String {
        raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    /// Orders provider records: saved order first, then catalog order, then
    /// unknown ids alphabetically. Accounts within one provider keep Hub order.
    static func ordered(
        _ providers: [LimitProvider],
        order: [String],
        hidden: Set<String> = []
    ) -> [LimitProvider] {
        let hiddenIDs = Set(hidden.map(normalizedID))
        var groups: [String: [LimitProvider]] = [:]
        var firstSeen: [String] = []
        for provider in providers {
            let id = provider.normalizedProviderID
            guard !id.isEmpty, !hiddenIDs.contains(id) else { continue }
            if groups[id] == nil { firstSeen.append(id) }
            groups[id, default: []].append(provider)
        }
        return sortedIDs(firstSeen, order: order)
            .flatMap { groups[$0] ?? [] }
    }

    /// Orders a flat list of provider ids the same way (editor rows).
    static func sortedIDs(_ ids: [String], order: [String]) -> [String] {
        let saved = normalizedOrder(order)
        let catalogRank = Dictionary(
            uniqueKeysWithValues: defaultOrder.enumerated().map { ($1, $0) }
        )
        let savedRank = Dictionary(
            uniqueKeysWithValues: saved.enumerated().map { ($1, $0) }
        )
        var seen = Set<String>()
        let unique = ids.compactMap { raw -> String? in
            let id = normalizedID(raw)
            guard !id.isEmpty, seen.insert(id).inserted else { return nil }
            return id
        }
        return unique.sorted { lhs, rhs in
            switch (savedRank[lhs], savedRank[rhs]) {
            case let (left?, right?):
                return left < right
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            default:
                switch (catalogRank[lhs], catalogRank[rhs]) {
                case let (left?, right?):
                    return left < right
                case (_?, nil):
                    return true
                case (nil, _?):
                    return false
                default:
                    return lhs.localizedStandardCompare(rhs) == .orderedAscending
                }
            }
        }
    }

    private static func normalizedOrder(_ order: [String]) -> [String] {
        var seen = Set<String>()
        return order.compactMap { raw -> String? in
            let id = normalizedID(raw)
            guard !id.isEmpty, seen.insert(id).inserted else { return nil }
            return id
        }
    }
}
