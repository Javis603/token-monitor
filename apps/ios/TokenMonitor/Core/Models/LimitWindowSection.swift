import Foundation

/// Desktop limits have paired primary lanes and explicitly full-width riders.
nonisolated struct LimitWindowSection: Identifiable, Sendable {
    let id: String
    var title: String? = nil
    let rows: [[LimitWindow]]

    static func make(provider: LimitProvider, windows: [LimitWindow]) -> [Self] {
        let providerID = provider.normalizedProviderID
        if providerID == "antigravity" {
            let candidates = windows.filter { $0.kind == "session" || $0.kind == "weekly" }
            let groups = candidates.map { window -> String? in
                let suffix = window.kind == "session" ? " 5-hour" : " weekly"
                let label = (window.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard label.lowercased().hasSuffix(suffix) else { return nil }
                let group = String(label.dropLast(suffix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                return group.isEmpty ? nil : group
            }
            if !candidates.isEmpty, groups.allSatisfy({ $0 != nil }), candidates.count == windows.count {
                var order: [String] = []
                var buckets: [String: [LimitWindow]] = [:]
                for (window, group) in zip(candidates, groups) {
                    guard let group else { continue }
                    if buckets[group] == nil { order.append(group) }
                    var short = window
                    short.label = window.kind == "session" ? "5-hour" : "Weekly"
                    buckets[group, default: []].append(short)
                }
                return order.map { group in
                    let values = buckets[group, default: []]
                    let ordered = values.filter { $0.kind == "session" } + values.filter { $0.kind == "weekly" }
                    return Self(id: group, title: group, rows: pairedRows(ordered, wide: { _ in false }))
                }
            }
            return [Self(id: "windows", rows: windows.map { [$0] })]
        }
        if providerID == "cursor" {
            return [Self(id: "windows", rows: windows.map { [$0] })]
        }
        if providerID == "codex" {
            let primary = windows.filter { $0.additional != true && ($0.kind == "session" || $0.kind == "weekly") }
            let ordered = primary.filter { $0.kind == "session" } + primary.filter { $0.kind == "weekly" }
            let riders = windows.filter { $0.additional == true || ($0.kind != "session" && $0.kind != "weekly") }
            return [Self(id: "windows", rows: pairedRows(ordered, wide: { _ in false }) + riders.map { [$0] })]
        }
        if providerID == "claude" {
            let primary = windows.filter {
                $0.kind == "session" || ($0.kind == "weekly" && ($0.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            let ordered = primary.filter { $0.kind == "session" } + primary.filter { $0.kind == "weekly" }
            let riders = windows.filter { candidate in !primary.contains { $0.id == candidate.id } }
            return [Self(id: "windows", rows: pairedRows(ordered, wide: { _ in false }) + riders.map { [$0] })]
        }
        return [Self(id: "windows", rows: pairedRows(windows) {
            $0.additional == true || $0.kind == "billing" || $0.isCredits || $0.metric == "spend"
        })]
    }

    private static func pairedRows(_ windows: [LimitWindow], wide: (LimitWindow) -> Bool) -> [[LimitWindow]] {
        var rows: [[LimitWindow]] = []
        var pending: [LimitWindow] = []
        for window in windows {
            if wide(window) {
                if !pending.isEmpty { rows.append(pending); pending = [] }
                rows.append([window])
            } else {
                pending.append(window)
                if pending.count == 2 { rows.append(pending); pending = [] }
            }
        }
        if !pending.isEmpty { rows.append(pending) }
        return rows
    }
}
