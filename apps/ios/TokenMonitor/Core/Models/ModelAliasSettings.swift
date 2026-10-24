import Foundation

/// Presentation only: source IDs and the Hub's already priced USD costs stay intact.
nonisolated struct ModelAliasSettings: Decodable, Sendable {
    var modelAliases: [String: String] = [:]
    var modelAliasGrouping = "off"

    private static func key(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .replacingOccurrences(of: "[._\\s]+", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    func resolver(modelIDs: [String]) -> [String: String] {
        let explicit = Dictionary(modelAliases.map { (Self.key($0.key), $0.value) },
                                  uniquingKeysWith: { first, _ in first })
        var automatic: [String: String] = [:]
        if modelAliasGrouping == "duplicates" || modelAliasGrouping == "prefix" {
            let ids = Set(modelIDs.filter { !$0.isEmpty })
            let groups = Dictionary(grouping: ids) { Self.key(Self.leaf($0)) }
            for (identity, group) in groups where modelAliasGrouping == "prefix" || group.count > 1 {
                guard let first = group.sorted(by: { Self.precedes($0, $1, identity: identity) }).first else { continue }
                let canonical = Self.leaf(first)
                for id in group where id != canonical { automatic[Self.key(id)] = canonical }
            }
        }
        var result: [String: String] = [:]
        for id in Set(modelIDs) {
            result[id] = explicit[Self.key(id)] ?? automatic[Self.key(id)].map { explicit[Self.key($0)] ?? $0 } ?? id
        }
        return result
    }

    private static func leaf(_ id: String) -> String {
        id.split(separator: "/").last.map(String.init) ?? id
    }

    private static func precedes(_ left: String, _ right: String, identity: String) -> Bool {
        func rank(_ id: String) -> [Int] {
            let name = leaf(id)
            return [key(name) == identity ? 0 : 1, id == name ? 0 : 1,
                    name == name.lowercased() ? 0 : 1,
                    name.range(of: "[._\\s]", options: .regularExpression) == nil ? 0 : 1, name.count]
        }
        let a = rank(left), b = rank(right)
        for index in a.indices where a[index] != b[index] { return a[index] < b[index] }
        return leaf(left).lowercased() == leaf(right).lowercased()
            ? leaf(left) < leaf(right) : leaf(left).lowercased() < leaf(right).lowercased()
    }

    static func fold(_ map: [String: Double]?, using resolver: [String: String]) -> [String: Double]? {
        guard let map else { return nil }
        return map.reduce(into: [:]) { result, item in
            result[resolver[item.key] ?? item.key, default: 0] += item.value
        }
    }
}
